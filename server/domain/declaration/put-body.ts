import {
  AI_USES,
  MAX_ATTACHED_CONVERSATIONS,
  MAX_DECLARED_TOOLS,
  MAX_EXTERNAL_ATTACHMENTS,
  MAX_HUMAN_HELP_ENTRIES,
  type AiUse,
} from "./constants.ts";
import {
  isDeclarationForm,
  isDeclaredTool,
  isHumanHelpEntry,
  type DeclarationForm,
  type DeclaredTool,
  type HumanHelpEntry,
} from "./payload.ts";
import { dataArray, dataObject, isPositiveInt, isSha256Hex, isUuidV4, keySet } from "./shape.ts";

export type PutConversationRef = {
  conversationId: string;
  throughSeq: number;
  messagesSha256: string;
};

/** Body of `student.declaration.put` (section 7.1). */
export type DeclarationPutBody = {
  baseVersion: number;
  revision: number;
  form: DeclarationForm;
  ownWork: { confirmed: boolean };
  humanHelp: { received: boolean; entries: HumanHelpEntry[] };
  ai: {
    use: AiUse | null;
    declaredTools: DeclaredTool[];
    attachments: PutConversationRef[];
    externalAttachmentIds: string[];
  };
  confirm: boolean;
};

const BODY_KEYS = keySet(
  "baseVersion",
  "revision",
  "form",
  "ownWork",
  "humanHelp",
  "ai",
  "confirm",
);
const OWN_WORK_KEYS = keySet("confirmed");
const HUMAN_HELP_KEYS = keySet("received", "entries");
const AI_KEYS = keySet("use", "declaredTools", "attachments", "externalAttachmentIds");
const REF_KEYS = keySet("conversationId", "throughSeq", "messagesSha256");

/**
 * The client lists mandatory conversations too, and the contract sets no
 * count for them, so the body bound is the student-added bound plus a
 * generous allowance; the server checks the real split against the chain.
 * TODO(MAX_DECLARATION_BODY_BYTES): the routes step derives the byte cap.
 */
const MAX_PUT_CONVERSATIONS = 10 * MAX_ATTACHED_CONVERSATIONS;

function isConversationRef(v: unknown): v is PutConversationRef {
  return (
    dataObject(v, REF_KEYS) &&
    isUuidV4(v.conversationId) &&
    isPositiveInt(v.throughSeq) &&
    isSha256Hex(v.messagesSha256)
  );
}

const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

function isPutAi(v: unknown): v is DeclarationPutBody["ai"] {
  if (!dataObject(v, AI_KEYS)) return false;
  if (v.use !== null && !(AI_USES as readonly unknown[]).includes(v.use)) return false;
  const { declaredTools, attachments, externalAttachmentIds } = v;
  return (
    dataArray(declaredTools, MAX_DECLARED_TOOLS) &&
    declaredTools.every(isDeclaredTool) &&
    dataArray(attachments, MAX_PUT_CONVERSATIONS) &&
    attachments.every(isConversationRef) &&
    unique(attachments.map((a) => a.conversationId)) &&
    dataArray(externalAttachmentIds, MAX_EXTERNAL_ATTACHMENTS) &&
    externalAttachmentIds.every(isUuidV4) &&
    unique(externalAttachmentIds)
  );
}

export type PutBodyParse =
  { ok: true; body: DeclarationPutBody } | { ok: false; reason: "invalid_input" };

/**
 * Closed parse of the put body. Any unknown key, including `reason`,
 * `recorded`, `principalId` and `confirmedAt`, gives `invalid_input`.
 * Completeness for `confirm: true` is a separate check (`incomplete`, 409).
 */
export function parseDeclarationPutBody(value: unknown): PutBodyParse {
  const invalid = { ok: false, reason: "invalid_input" } as const;
  if (!dataObject(value, BODY_KEYS)) return invalid;
  const v = value;
  const ok =
    Number.isSafeInteger(v.baseVersion) &&
    (v.baseVersion as number) >= 0 &&
    isPositiveInt(v.revision) &&
    isDeclarationForm(v.form) &&
    dataObject(v.ownWork, OWN_WORK_KEYS) &&
    typeof v.ownWork.confirmed === "boolean" &&
    dataObject(v.humanHelp, HUMAN_HELP_KEYS) &&
    typeof v.humanHelp.received === "boolean" &&
    dataArray(v.humanHelp.entries, MAX_HUMAN_HELP_ENTRIES) &&
    v.humanHelp.entries.every(isHumanHelpEntry) &&
    isPutAi(v.ai) &&
    typeof v.confirm === "boolean";
  return ok ? { ok: true, body: v as DeclarationPutBody } : invalid;
}

export type IncompleteField = "ownWork" | "ai.use" | "humanHelp" | "ai.declaredTools";

/**
 * What still blocks `confirm: true` (409 `incomplete`): own-work
 * confirmation, a chosen `ai.use`, `humanHelp` consistent with `received`,
 * and no declared tools with `not_used`. A draft may hold any of these.
 */
export function incompleteFields(body: DeclarationPutBody): IncompleteField[] {
  const out: IncompleteField[] = [];
  if (!body.ownWork.confirmed) out.push("ownWork");
  if (body.ai.use === null) out.push("ai.use");
  if (body.humanHelp.received !== body.humanHelp.entries.length > 0) out.push("humanHelp");
  if (body.ai.use === "not_used" && body.ai.declaredTools.length > 0) out.push("ai.declaredTools");
  return out;
}
