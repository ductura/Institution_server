// F4-NAS-R16-SRV: the database port of the revision due date of a work
// (app.read_work_revision_due, 20261220210000). One withActor transaction over one
// RPC; the RPC decides who may read (the student owner and a teacher of the
// assignment). The answer is a closed status, never a database message: a row of an
// unexpected shape is unavailable. Nothing is written.
import type { WithActor } from "../index.ts";

export type OpenReturn = {
  readonly round: number;
  readonly revisionDueAt: string | null;
  readonly returnedAt: string;
};

export type WorkRevisionDueResult =
  | { readonly status: "ok"; readonly returned: OpenReturn | null }
  | { readonly status: "unauthenticated" | "not_found" | "unavailable" };

export type WorkRevisionDue = {
  read(token: string, documentId: string): Promise<WorkRevisionDueResult>;
};

const SQL =
  "SELECT outcome, attempt, revision_due_at, returned_at FROM app.read_work_revision_due($1)";

function instant(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("bad instant");
  return value.toISOString();
}

export function createWorkRevisionDue(withActor: WithActor): WorkRevisionDue {
  return {
    async read(token, documentId) {
      try {
        return await withActor(token, async (tx): Promise<WorkRevisionDueResult> => {
          const { rows } = await tx.query<Record<string, unknown>>(SQL, [documentId]);
          const row = rows[0];
          if (rows.length !== 1 || row === undefined) return { status: "unavailable" };
          switch (row.outcome) {
            case "unauthorized":
              return { status: "unauthenticated" };
            case "invalid":
            case "not_found":
              return { status: "not_found" };
            case "ok": {
              if (
                row.attempt === null &&
                row.returned_at === null &&
                row.revision_due_at === null
              ) {
                return { status: "ok", returned: null };
              }
              const returnedAt = instant(row.returned_at);
              if (
                typeof row.attempt !== "number" ||
                !Number.isInteger(row.attempt) ||
                returnedAt === null
              ) {
                return { status: "unavailable" };
              }
              return {
                status: "ok",
                returned: {
                  round: row.attempt,
                  revisionDueAt: instant(row.revision_due_at),
                  returnedAt,
                },
              };
            }
            default:
              return { status: "unavailable" };
          }
        });
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
