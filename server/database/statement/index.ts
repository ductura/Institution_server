import { createActorReader, type WithActor } from "../index.ts";
import type {
  DeclarationForm,
  DeclarationPutBody,
  DeclarationQuestionAnswer,
} from "../../domain/index.ts";
export {
  checkExternalAttachmentBytes,
  incompleteFields,
  isDeclarationQuestion,
  isExternalFormat,
  parseDeclarationFormFile,
  parseDeclarationMismatchExplanation,
  parseDeclarationPutBody,
  parseDeclarationQuestionAnswer,
} from "../../domain/index.ts";

export type ConfiguredForm = { file: string; form: DeclarationForm & { text: string } };
export type FormReader = (slug: string) => Promise<ConfiguredForm | null>;

/**
 * A refusal keeps the RPC's reason and the context the client needs to
 * recover (declaration-v1 §7.3); nothing else of the RPC answer leaves.
 */
export type StatementRefusal = {
  status: "unauthorized" | "not_found" | "conflict" | "invalid_input";
  reason?: string;
  currentVersion?: unknown;
  currentRevision?: unknown;
  conversationIds?: unknown;
};
type Outcome = StatementRefusal | { status: "ok"; body: unknown };
function fail(): never {
  throw new Error("Invalid declaration database response");
}
const CONTEXT = ["currentVersion", "currentRevision", "conversationIds"] as const;

function refusalOf(status: StatementRefusal["status"], data: Record<string, unknown>) {
  const refusal: StatementRefusal = { status };
  if (typeof data.reason === "string") refusal.reason = data.reason;
  for (const key of CONTEXT) if (data[key] !== undefined) refusal[key] = data[key];
  return refusal;
}
export type StatementOperation =
  | { type: "read" }
  | { type: "conversations" }
  | {
      type: "save";
      body: DeclarationPutBody;
      answer: DeclarationQuestionAnswer | null;
      explanation: string | null;
    }
  | { type: "upload"; format: string; bytes: Uint8Array };

export type StatementPort = {
  institutionSlug(token: string): Promise<string | null>;
  run(token: string, assignmentId: string, slug: string, op: StatementOperation): Promise<Outcome>;
};

const SQL = {
  read: "SELECT declaration.read_statement($1) AS result",
  // SRV-F4-EDI-R07: the student's own assistant conversations a declaration can attach.
  conversations: "SELECT declaration.list_conversations($1) AS result",
  // SRV-IZJAVA-PITANJE, F4-PRE-R02-SRV2: save_statement, the optional answer
  // and the optional mismatch explanation in one call.
  save: "SELECT declaration.save_statement_explained($1, $2, $3, $4, $5) AS result",
  upload: "SELECT declaration.upload_attachment($1, $2, $3) AS result",
} as const;

export function createStatementPort(withActor: WithActor, readForm: FormReader): StatementPort {
  const reader = createActorReader(withActor);
  return {
    async institutionSlug(token) {
      return (await reader.currentActorWithInstitution(token)).institutionSlug;
    },
    async run(token, assignmentId, slug, op) {
      const form =
        op.type === "upload" || op.type === "conversations" ? null : await readForm(slug);
      const args =
        op.type === "save"
          ? [assignmentId, op.body, form?.file ?? null, op.answer, op.explanation]
          : op.type === "upload"
            ? [assignmentId, op.format, Buffer.from(op.bytes)]
            : [assignmentId];
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<{ result: unknown }>(SQL[op.type], args);
        const result = rows[0]?.result;
        if (typeof result !== "object" || result === null || !("status" in result)) {
          throw new Error("Invalid declaration database response");
        }
        const { status, ...data } = result as Record<string, unknown>;
        switch (status) {
          case "unauthorized":
          case "not_found":
          case "conflict":
          case "invalid_input":
            return refusalOf(status, data);
          case "ok":
            if (op.type === "upload") return { status, body: data };
            if (op.type === "conversations") {
              return Array.isArray(data.conversations)
                ? { status, body: { conversations: data.conversations } }
                : fail();
            }
            if (
              !("statement" in data) ||
              typeof data.statement !== "object" ||
              data.statement === null
            )
              break;
            return { status, body: { ...data.statement, currentForm: form?.form ?? null } };
        }
        return fail();
      });
    },
  };
}
