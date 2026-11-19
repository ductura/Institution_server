// The in-memory state of the dev fake server and its invented starting data.
// People, courses, codes and the assignment are the values of SRV-01
// (db/main/local/seed.sql and db/main/local/lazni-oidc-racuni.json on
// migracija/w1119r-seed-lokalni, Ductus#2028), with fixed ids here, so the web
// sees the same names locally against the fake and against the real stack.
// Every person, text and id is invented.

export const ACCOUNT_KEYS = [
  "student",
  "student-2",
  "nastavnik",
  "nastavnik-2",
  "administrator",
  "bez-uloge",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];
export type Role = "student" | "teacher" | "institution_admin";
export type AiPolicy = "prohibited" | "partially_allowed" | "encouraged";
export type Language = "hr" | "en";

export type Account = {
  readonly id: string;
  readonly key: AccountKey;
  readonly givenName: string;
  readonly familyName: string;
  roles: Role[];
  locale: Language | null;
};

export type Group = {
  readonly id: string;
  readonly name: string;
  teacherIds: string[];
  studentIds: string[];
};

export type EnrollmentCode = { readonly code: string; validUntil: string; active: boolean };

export type Course = {
  readonly id: string;
  readonly name: string;
  readonly academicYear: string;
  readonly aiPolicy: AiPolicy;
  readonly holderId: string;
  readonly createdBy: string;
  studentIds: string[];
  groups: Group[];
  codes: EnrollmentCode[];
  /** Removed students, refused by a code until a teacher lets them back. */
  removed: string[];
};

export type AssignmentContent = {
  title: string;
  instructions: string;
  workType:
    | "short_paper"
    | "essay"
    | "seminar_paper"
    | "bachelor_thesis"
    | "master_thesis"
    | "specialist_thesis"
    | "doctoral_thesis";
  opensAt: string;
  dueAt: string;
  aiPolicy: AiPolicy;
  aiPurposes: (
    "formatting" | "proofreading" | "literature_search" | "transcription" | "translation"
  )[];
  evidenceProfile: "basic" | "extended";
  importAllowed: boolean;
  wordMin: number | null;
  wordMax: number | null;
};

export type Assignment = {
  readonly id: string;
  readonly courseId: string;
  version: number;
  content: AssignmentContent;
  language: Language;
  /** Version of the notice each student acknowledged, by student id. */
  acknowledged: Map<string, { version: number; at: string }>;
  /** Work language set for one student, by student id. */
  studentLanguage: Map<string, Language>;
};

export type Work = {
  readonly documentId: string;
  readonly assignmentId: string;
  readonly studentId: string;
  state: "in_progress" | "submitted";
  language: Language | null;
};

export type State = {
  accounts: Account[];
  /** Session token -> account id. */
  sessions: Map<string, string>;
  courses: Course[];
  assignments: Assignment[];
  works: Work[];
  /** Refused enrolment codes, by account id (too_many_attempts after five). */
  enrollmentGuesses: Map<string, number>;
};

/** Fixed, invented ids (UUID v4 form) of the starting data. */
export const IDS = {
  student: "5a000000-0000-4000-8000-000000000001",
  student2: "5a000000-0000-4000-8000-000000000002",
  teacher: "7e000000-0000-4000-8000-000000000001",
  teacher2: "7e000000-0000-4000-8000-000000000002",
  admin: "ad000000-0000-4000-8000-000000000001",
  noRole: "0e000000-0000-4000-8000-000000000001",
  course: "c0000000-0000-4000-8000-000000000001",
  emptyCourse: "c0000000-0000-4000-8000-000000000002",
  groupA: "9a000000-0000-4000-8000-00000000000a",
  groupB: "9a000000-0000-4000-8000-00000000000b",
  assignment: "a5000000-0000-4000-8000-000000000001",
  document: "d0000000-0000-4000-8000-000000000001",
} as const;

/** The enrolment codes of the starting data (the fixed texts of SRV-01). */
export const CODES = {
  valid: "UPIS2026DEMO",
  expired: "STARI2025KOD",
  emptyCourse: "PRAZNI2026DEMO",
} as const;

export const INSTITUTION = { slug: "demo-fakultet", displayName: "Demo fakultet (test)" } as const;

function account(
  key: AccountKey,
  id: string,
  givenName: string,
  familyName: string,
  roles: Role[],
): Account {
  return { id, key, givenName, familyName, roles, locale: null };
}

/** A fresh state with the starting data; each call is independent. */
export function createState(): State {
  return {
    accounts: [
      account("student", IDS.student, "Lucija", "Đaković", ["student"]),
      account("student-2", IDS.student2, "Marko", "Ljubić", ["student"]),
      account("nastavnik", IDS.teacher, "Petar", "Kranjčec", ["teacher"]),
      account("nastavnik-2", IDS.teacher2, "Maja", "Džombić", ["teacher"]),
      account("administrator", IDS.admin, "Vesna", "Upravić", ["institution_admin"]),
      account("bez-uloge", IDS.noRole, "Iva", "Neimenić", []),
    ],
    sessions: new Map(),
    courses: [
      {
        id: IDS.course,
        name: "Izmišljeni seminar iz ekologije grada",
        academicYear: "2026/2027",
        aiPolicy: "partially_allowed",
        holderId: IDS.teacher,
        createdBy: IDS.teacher,
        studentIds: [IDS.student],
        groups: [
          { id: IDS.groupA, name: "Grupa A", teacherIds: [], studentIds: [IDS.student] },
          { id: IDS.groupB, name: "Grupa B", teacherIds: [IDS.teacher2], studentIds: [] },
        ],
        codes: [
          { code: CODES.expired, validUntil: "2025-10-31T22:59:00.000Z", active: false },
          { code: CODES.valid, validUntil: "2027-09-30T21:59:00.000Z", active: true },
        ],
        removed: [],
      },
      {
        id: IDS.emptyCourse,
        name: "Izmišljeni praktikum iz urbane sociologije",
        academicYear: "2026/2027",
        aiPolicy: "encouraged",
        holderId: IDS.teacher,
        createdBy: IDS.teacher,
        studentIds: [],
        groups: [],
        codes: [{ code: CODES.emptyCourse, validUntil: "2027-09-30T21:59:00.000Z", active: true }],
        removed: [],
      },
    ],
    assignments: [
      {
        id: IDS.assignment,
        courseId: IDS.course,
        version: 1,
        content: {
          title: "Seminarski rad: kućno kompostiranje",
          instructions:
            "Opiši kako kućno kompostiranje u gradskom kućanstvu smanjuje količinu otpada. " +
            "Osloni se na najmanje tri izvora i citiraj ih prema uputama fakulteta.\n\n" +
            "Kolegij, zadatak i tekst su izmišljeni i služe samo za lokalni demo.",
          workType: "seminar_paper",
          opensAt: "2026-10-01T06:00:00.000Z",
          dueAt: "2027-01-31T22:59:00.000Z",
          aiPolicy: "partially_allowed",
          aiPurposes: ["proofreading", "literature_search"],
          evidenceProfile: "basic",
          importAllowed: false,
          wordMin: 1500,
          wordMax: 2500,
        },
        language: "hr",
        acknowledged: new Map([[IDS.student, { version: 1, at: "2026-10-02T08:15:00.000Z" }]]),
        studentLanguage: new Map(),
      },
    ],
    works: [
      {
        documentId: IDS.document,
        assignmentId: IDS.assignment,
        studentId: IDS.student,
        state: "in_progress",
        language: null,
      },
    ],
    enrollmentGuesses: new Map(),
  };
}

export function accountByKey(state: State, key: AccountKey): Account {
  const found = state.accounts.find((a) => a.key === key);
  if (found === undefined) throw new Error(`no account ${key}`);
  return found;
}

/** Teachers of a course: its holder and the teachers of its groups. */
export function courseTeachers(course: Course): string[] {
  return [course.holderId, ...course.groups.flatMap((g) => g.teacherIds)];
}

export function teachesCourse(course: Course, accountId: string): boolean {
  return courseTeachers(course).includes(accountId);
}
