// SRV-1106 (Val 11, Ductus#2051; E§3.5 mentor2 "Poruke", PO-22): the database
// port of the short messages next to a work (20261121130000). Each call is one
// withActor transaction over one RPC of schema collaboration; the RPCs decide
// who may (the student of the work and the teachers of its assignment, the
// same relation as the comments) and give every reader the same conversation
// in the order of writing. Nothing here reads or writes the document. The
// answer is a closed status, never a database message or SQLSTATE: ZD401 is
// unauthenticated, ZD403 not_found (one answer for "not yours", "not there"
// and "no relation", C-23), ZD422 invalid, anything else unavailable. A row
// of an unexpected shape is unavailable too.
import type { ActorTransaction, WithActor } from "../with-actor.ts";

export type WorkMessage = {
  readonly id: string;
  readonly senderRole: "student" | "teacher";
  readonly text: string;
  readonly createdAt: string;
};

export type WorkMessageRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};
export type WorkMessageCreated = { readonly status: "created"; readonly message: WorkMessage };
export type WorkMessageList = { readonly status: "ok"; readonly messages: readonly WorkMessage[] };

export type WorkMessages = {
  create(
    token: string,
    documentId: string,
    text: string,
  ): Promise<WorkMessageCreated | WorkMessageRefusal>;
  list(token: string, documentId: string): Promise<WorkMessageList | WorkMessageRefusal>;
};

const SQL = {
  create:
    'SELECT message_id AS id, sender_role AS "senderRole", $2::text AS text, created_at AS "createdAt" FROM collaboration.create_work_message($1, $2)',
  list: 'SELECT message_id AS id, sender_role AS "senderRole", body AS text, created_at AS "createdAt" FROM collaboration.list_work_messages($1)',
} as const;

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): WorkMessageRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function toMessage(row: Record<string, unknown>): WorkMessage {
  const { id, senderRole, text, createdAt } = row;
  if (
    typeof id !== "string" ||
    (senderRole !== "student" && senderRole !== "teacher") ||
    typeof text !== "string" ||
    !(createdAt instanceof Date) ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new Malformed();
  }
  return { id, senderRole, text, createdAt: createdAt.toISOString() };
}

export function createWorkMessages(withActor: WithActor): WorkMessages {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | WorkMessageRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;

  return {
    create: (token, documentId, text) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.create, [documentId, text]);
        if (rows.length !== 1) throw new Malformed();
        return { status: "created" as const, message: toMessage(rows[0]!) };
      }),
    list: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        messages: (await rowsOf(tx, SQL.list, [documentId])).map(toMessage),
      })),
  };
}
