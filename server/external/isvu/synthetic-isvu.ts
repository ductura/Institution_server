/**
 * The synthetic ISVU adapter (SRV-V22-ISVU-PORT). Invented courses and
 * students held in the code; it opens no network and needs no secret. The
 * people are the invented accounts of the local fake OIDC provider
 * (db/main/local/lazni-oidc-racuni.json) plus two invented people without an
 * account, so an import preview shows both `new` and `unknown_account`.
 * This is not the format of any real system (docs/contracts/isvu-v1.md).
 */
import {
  gradeBatchSha256,
  isGradeConfirmation,
  isValidBatch,
  type IsvuCourse,
  type IsvuGradeRow,
  type IsvuListCoursesInput,
  type IsvuPort,
  type IsvuRosterRow,
  type IsvuSubmitOutcome,
  type GradeConfirmation,
} from "./port.ts";

import data from "./synthetic-isvu-data.json" with { type: "json" };

/** The one institution the synthetic source knows. */
export const SYNTHETIC_INSTITUTION_KEY: string = data.institutionKey;

type PersonKey = keyof typeof data.people;

function rowOf(key: PersonKey): IsvuRosterRow {
  const person = data.people[key];
  return Object.freeze({
    identifier: `${person.user}@${data.domain}`,
    givenName: person.givenName,
    familyName: person.familyName,
  });
}

type SyntheticCourse = {
  readonly sourceCourseKey: string;
  readonly name: string;
  readonly academicYear: string;
  readonly roster: readonly IsvuRosterRow[];
};

const COURSES: readonly SyntheticCourse[] = Object.freeze(
  data.courses.map((course) =>
    Object.freeze({
      sourceCourseKey: course.sourceCourseKey,
      name: course.name,
      academicYear: course.academicYear,
      roster: Object.freeze(course.roster.map((key) => rowOf(key as PersonKey))),
    }),
  ),
);

export type SyntheticIsvu = IsvuPort & {
  /** What the source received, in order; for tests only. */
  readonly submissions: readonly {
    readonly sourceCourseKey: string;
    readonly rows: readonly IsvuGradeRow[];
  }[];
};

export function createSyntheticIsvu(): SyntheticIsvu {
  const submissions: { sourceCourseKey: string; rows: readonly IsvuGradeRow[] }[] = [];
  const find = (key: string) => COURSES.find((course) => course.sourceCourseKey === key) ?? null;

  const port: SyntheticIsvu = {
    mode: "mock",
    submissions,
    async listCourses(input: IsvuListCoursesInput): Promise<readonly IsvuCourse[]> {
      if (input.institutionKey !== SYNTHETIC_INSTITUTION_KEY) return [];
      return COURSES.filter((course) => course.academicYear === input.academicYear).map(
        (course) => ({
          sourceCourseKey: course.sourceCourseKey,
          name: course.name,
          academicYear: course.academicYear,
          enrolledCount: course.roster.length,
        }),
      );
    },
    async listEnrolled(sourceCourseKey: string): Promise<readonly IsvuRosterRow[] | null> {
      const course = typeof sourceCourseKey === "string" ? find(sourceCourseKey) : null;
      return course ? course.roster.map((r) => ({ ...r })) : null;
    },
    async submitGrades(
      sourceCourseKey: string,
      batch: readonly IsvuGradeRow[],
      confirmation: GradeConfirmation,
    ): Promise<IsvuSubmitOutcome> {
      if (!isGradeConfirmation(confirmation) || confirmation.sourceCourseKey !== sourceCourseKey) {
        return { ok: false, reason: "no_confirmation" };
      }
      if (!isValidBatch(batch)) return { ok: false, reason: "invalid_batch" };
      if (gradeBatchSha256(batch) !== confirmation.batchSha256) {
        return { ok: false, reason: "batch_mismatch" };
      }
      const course = typeof sourceCourseKey === "string" ? find(sourceCourseKey) : null;
      if (!course) return { ok: false, reason: "unknown_course" };
      const enrolled = new Set(course.roster.map((r) => r.identifier));
      if (!batch.every((r) => enrolled.has(r.identifier))) {
        return { ok: false, reason: "not_enrolled" };
      }
      submissions.push({
        sourceCourseKey,
        rows: batch.map((r) => ({ identifier: r.identifier, grade: r.grade })),
      });
      return { ok: true, sent: batch.length, mode: "mock" };
    },
  };
  return port;
}
