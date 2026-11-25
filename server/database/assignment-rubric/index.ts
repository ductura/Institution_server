import type { WithActor } from "../index.ts";

/**
 * SRV-V17-RUBRIC-DEF: the rubric of an assignment, versioned by adding only. The database
 * decides who may (a teacher of the assignment writes and reads, a student of it reads) and
 * raises ZD401, ZD404, ZD409 and ZD422; they are not caught here, the HTTP edge maps them.
 * Nothing in this port comes from the caller but the session token, the assignment and the
 * fields of the change.
 */

export type RubricLevel = { label: string; descriptor: string };
export type RubricCriterion = { id: string; title: string; levels: RubricLevel[] };
export type AssignmentRubric = { version: number; criteria: RubricCriterion[] };

/**
 * The six working criteria (SRV-1107) as a student reads them while the teacher set none. Version 0
 * only: the title and the level labels are message keys of locales/hr.json (`workingCriteria.<id>`,
 * `assignmentRubric.level*`), never sentences, and the client shows their text. A stored rubric
 * carries the teacher's own words.
 */
const DEFAULT_IDS = ["topic", "structure", "sources", "method", "language", "formatting"] as const;
const DEFAULT_LEVELS = [
  "assignmentRubric.levelLow",
  "assignmentRubric.levelMid",
  "assignmentRubric.levelHigh",
] as const;

export function defaultRubricCriteria(): RubricCriterion[] {
  return DEFAULT_IDS.map((id) => ({
    id,
    title: `workingCriteria.${id}`,
    levels: DEFAULT_LEVELS.map((label) => ({ label, descriptor: "" })),
  }));
}

type Row = { version: number; criteria: RubricCriterion[] };

export function createAssignmentRubric(withActor: WithActor) {
  function read(token: string, fn: string, assignmentId: string): Promise<Row | null> {
    return withActor(token, async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT version, criteria FROM ${fn}($1::uuid)`, [
        assignmentId,
      ]);
      if (rows.length > 1) throw new Error("invalid rubric read");
      return rows[0] ?? null;
    });
  }
  return {
    /** The latest version for a teacher of the assignment: version 0 and no criteria while none is set. */
    async forTeacher(token: string, assignmentId: string): Promise<AssignmentRubric> {
      const row = await read(token, "app.read_assignment_rubric_teacher", assignmentId);
      return row ?? { version: 0, criteria: [] };
    },
    /** The latest version for a student of the assignment: the six default criteria while none is set. */
    async forStudent(token: string, assignmentId: string): Promise<AssignmentRubric> {
      const row = await read(token, "app.read_assignment_rubric_student", assignmentId);
      return row ?? { version: 0, criteria: defaultRubricCriteria() };
    },
    /** Adds the next version; the version number is the database's. */
    publish(
      token: string,
      assignmentId: string,
      expectedVersion: number,
      criteria: readonly RubricCriterion[],
    ): Promise<AssignmentRubric> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<Row>(
          "SELECT version, criteria FROM app.publish_assignment_rubric($1::uuid, $2::integer, $3::jsonb)",
          [assignmentId, expectedVersion, JSON.stringify(criteria)],
        );
        const row = rows[0];
        if (rows.length !== 1 || row === undefined || row.version !== expectedVersion + 1) {
          throw new Error("invalid published rubric version");
        }
        return row;
      });
    },
  };
}

export type AssignmentRubricStore = ReturnType<typeof createAssignmentRubric>;
