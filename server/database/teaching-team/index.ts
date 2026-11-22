import type { WithActor } from "../index.ts";

type Team = { holderId: string | null; assistantIds: string[] };

export function createTeachingTeam(withActor: WithActor) {
  return {
    read: (token: string, courseId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Team>(
          'SELECT holder_id AS "holderId", assistant_ids AS "assistantIds" FROM institution.read_teaching_team($1::uuid)',
          [courseId],
        );
        if (rows.length !== 1) throw new Error("Expected one teaching team");
        return rows[0]!;
      }),
    readView: (token: string, courseId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{ view: unknown }>(
          "SELECT institution.read_teaching_team_view($1::uuid) AS view",
          [courseId],
        );
        if (rows.length !== 1) throw new Error("Expected one teaching team view");
        return rows[0]!.view;
      }),
    replaceAssistants: (token: string, courseId: string, assistantIds: readonly string[]) =>
      withActor(token, (tx) =>
        tx.query("SELECT institution.replace_course_assistants($1::uuid, $2::uuid[])", [
          courseId,
          assistantIds,
        ]),
      ),
    replaceGroup: (
      token: string,
      courseId: string,
      groupId: string,
      assistantIds: readonly string[],
      studentIds: readonly string[],
    ) =>
      withActor(token, (tx) =>
        tx.query(
          "SELECT institution.replace_teaching_group_members($1::uuid, $2::uuid, $3::uuid[], $4::uuid[])",
          [courseId, groupId, assistantIds, studentIds],
        ),
      ),
  };
}
