import type { WithActor } from "./with-actor.ts";

/**
 * The person and institution `app.current_actor()` answers for, in camelCase
 * (docs/CODE_STYLE.md 9: rows become camelCase only in this folder). Both are
 * null for a closed or expired session, and for no row at all.
 */
export type CurrentActor = { userId: string | null; institutionId: string | null };

/** As `CurrentActor`, with the slug of the institution from the same statement. */
export type CurrentActorWithInstitution = CurrentActor & { institutionSlug: string | null };

/**
 * The port server/session reads the session's actor through. Each call is one
 * statement in one withActor transaction; an error is the caller's to handle.
 */
export type ActorReader = {
  currentActor(token: string): Promise<CurrentActor>;
  currentActorWithInstitution(token: string): Promise<CurrentActorWithInstitution>;
};

export const CURRENT_ACTOR_SQL = "SELECT user_id, institution_id FROM app.current_actor()";

// Person and slug in one statement, so a session closed in between yields
// neither (M2.12-P02, plan #1689).
export const CURRENT_ACTOR_WITH_INSTITUTION_SQL =
  "SELECT user_id, institution_id, app.current_institution_slug() AS institution_slug FROM app.current_actor()";

type ActorRow = {
  user_id: string | null;
  institution_id: string | null;
  institution_slug?: unknown;
};

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A reader over `withActor`; the token is only presented, never a parameter of the statement. */
export function createActorReader(withActor: WithActor): ActorReader {
  const readRow = (token: string, statement: string) =>
    withActor(token, async (tx) => (await tx.query<ActorRow>(statement)).rows[0]);
  return {
    async currentActor(token) {
      const row = await readRow(token, CURRENT_ACTOR_SQL);
      return { userId: text(row?.user_id), institutionId: text(row?.institution_id) };
    },
    async currentActorWithInstitution(token) {
      const row = await readRow(token, CURRENT_ACTOR_WITH_INSTITUTION_SQL);
      return {
        userId: text(row?.user_id),
        institutionId: text(row?.institution_id),
        institutionSlug: text(row?.institution_slug),
      };
    },
  };
}
