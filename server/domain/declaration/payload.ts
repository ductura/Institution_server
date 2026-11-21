import { canonicalizeJcs, isSubmissionInstant } from "../forensics/index.ts";
import {
  attachmentId,
  compareAttachments,
  isConversationAttachment,
  isExternalAttachment,
  sha256Hex,
  type DeclarationAttachment,
} from "./attachments.ts";
import {
  AI_USES,
  DECLARATION_SCHEMA,
  EXTERNAL_ATTACHMENT_REASON,
  HUMAN_HELP_KINDS,
  MAX_ATTACHED_CONVERSATIONS,
  MAX_DECLARED_TOOLS,
  MAX_EXTERNAL_ATTACHMENTS,
  MAX_EXTERNAL_TOTAL_BYTES,
  MAX_HUMAN_HELP_ENTRIES,
  type AiUse,
  type HumanHelpKind,
} from "./constants.ts";
import {
  dataArray,
  dataObject,
  isCanonicalUuid,
  isDocumentId,
  isFormId,
  isFormVersion,
  isPositiveInt,
  isSha256Hex,
  isUuidV4,
  keySet,
} from "./shape.ts";
import { isDeclaredText, isToolFieldText } from "./text.ts";

export type DeclarationForm = { formId: string; formVersion: number; formSha256: string };
export type HumanHelpEntry = { kind: HumanHelpKind; text: string };
export type DeclaredTool = { toolLabel: string; purposeText: string; phaseText: string };
export type RecordedTransfer = { aiTransferId: string; aiTransferSha256: string };

export type DeclarationPayloadV1 = {
  declarationSchema: typeof DECLARATION_SCHEMA;
  declarationId: string;
  declarationVersion: number;
  principalId: string;
  assignmentId: string;
  assignmentVersion: number;
  documentId: string;
  revision: number;
  form: DeclarationForm;
  ownWork: { confirmed: true };
  humanHelp: { received: boolean; entries: HumanHelpEntry[] };
  ai: {
    use: AiUse;
    recorded: RecordedTransfer[];
    declaredTools: DeclaredTool[];
    attachments: DeclarationAttachment[];
  };
  confirmedAt: string;
};

const PAYLOAD_KEYS = keySet(
  "declarationSchema",
  "declarationId",
  "declarationVersion",
  "principalId",
  "assignmentId",
  "assignmentVersion",
  "documentId",
  "revision",
  "form",
  "ownWork",
  "humanHelp",
  "ai",
  "confirmedAt",
);
const FORM_KEYS = keySet("formId", "formVersion", "formSha256");
const OWN_WORK_KEYS = keySet("confirmed");
const HUMAN_HELP_KEYS = keySet("received", "entries");
const ENTRY_KEYS = keySet("kind", "text");
const AI_KEYS = keySet("use", "recorded", "declaredTools", "attachments");
const TOOL_KEYS = keySet("toolLabel", "purposeText", "phaseText");
const RECORDED_KEYS = keySet("aiTransferId", "aiTransferSha256");

/** The contract sets no count for `recorded` or for mandatory conversations. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const strictlyIncreasing = <T>(list: readonly T[], cmp: (a: T, b: T) => number): boolean =>
  list.every((item, i) => i === 0 || cmp(list[i - 1] as T, item) < 0);

export function isDeclarationForm(v: unknown): v is DeclarationForm {
  return (
    dataObject(v, FORM_KEYS) &&
    isFormId(v.formId) &&
    isFormVersion(v.formVersion) &&
    isSha256Hex(v.formSha256)
  );
}

export const isHumanHelpKind = (v: unknown): v is HumanHelpKind =>
  (HUMAN_HELP_KINDS as readonly unknown[]).includes(v);

export function isHumanHelpEntry(v: unknown): v is HumanHelpEntry {
  return dataObject(v, ENTRY_KEYS) && isHumanHelpKind(v.kind) && isDeclaredText(v.text);
}

export function isDeclaredTool(v: unknown): v is DeclaredTool {
  return (
    dataObject(v, TOOL_KEYS) &&
    isToolFieldText(v.toolLabel) &&
    isToolFieldText(v.purposeText) &&
    isToolFieldText(v.phaseText)
  );
}

function isRecordedTransfer(v: unknown): v is RecordedTransfer {
  return (
    dataObject(v, RECORDED_KEYS) &&
    isCanonicalUuid(v.aiTransferId) &&
    isSha256Hex(v.aiTransferSha256)
  );
}

export type AttachmentListProblem =
  "order" | "external_count" | "external_bytes" | "student_added_count";

/**
 * List rules for `ai.attachments`: payload order without a repeated id,
 * external count and total bytes, and at most `MAX_ATTACHED_CONVERSATIONS`
 * student-added conversations (mandatory ones never fail on a count).
 */
export function attachmentListProblem(
  list: readonly DeclarationAttachment[],
): AttachmentListProblem | null {
  if (!strictlyIncreasing(list, compareAttachments)) return "order";
  // The order compares the reason first, so one conversation under two reasons
  // passes it; a conversation id must be unique across the whole list.
  const conversationIds = list.filter(isConversationAttachment).map(attachmentId);
  if (new Set(conversationIds).size !== conversationIds.length) return "order";
  let external = 0;
  let externalBytes = 0;
  let studentAdded = 0;
  for (const a of list) {
    if (a.reason === EXTERNAL_ATTACHMENT_REASON) {
      external++;
      externalBytes += a.byteLength;
    } else if (a.reason === "student_added") studentAdded++;
  }
  if (external > MAX_EXTERNAL_ATTACHMENTS) return "external_count";
  if (externalBytes > MAX_EXTERNAL_TOTAL_BYTES) return "external_bytes";
  if (studentAdded > MAX_ATTACHED_CONVERSATIONS) return "student_added_count";
  return null;
}

function isHumanHelp(v: unknown): v is DeclarationPayloadV1["humanHelp"] {
  if (!dataObject(v, HUMAN_HELP_KEYS) || typeof v.received !== "boolean") return false;
  if (!dataArray(v.entries, MAX_HUMAN_HELP_ENTRIES) || !v.entries.every(isHumanHelpEntry))
    return false;
  return v.received ? v.entries.length > 0 : v.entries.length === 0;
}

function isAi(v: unknown): v is DeclarationPayloadV1["ai"] {
  if (!dataObject(v, AI_KEYS)) return false;
  if (!(AI_USES as readonly unknown[]).includes(v.use)) return false;
  const { recorded, declaredTools, attachments } = v;
  if (!dataArray(recorded, UNBOUNDED) || !recorded.every(isRecordedTransfer)) return false;
  if (!strictlyIncreasing(recorded, (a, b) => compareStrings(a.aiTransferId, b.aiTransferId)))
    return false;
  if (!dataArray(declaredTools, MAX_DECLARED_TOOLS) || !declaredTools.every(isDeclaredTool))
    return false;
  if (v.use === "not_used" && declaredTools.length !== 0) return false;
  if (
    !dataArray(attachments, UNBOUNDED) ||
    !attachments.every((a) => isConversationAttachment(a) || isExternalAttachment(a))
  )
    return false;
  return attachmentListProblem(attachments) === null;
}

/** Closed structural check of a confirmed declaration payload (section 1). */
export function isDeclarationPayloadV1(value: unknown): value is DeclarationPayloadV1 {
  if (!dataObject(value, PAYLOAD_KEYS)) return false;
  const v = value;
  return (
    v.declarationSchema === DECLARATION_SCHEMA &&
    isUuidV4(v.declarationId) &&
    isPositiveInt(v.declarationVersion) &&
    isCanonicalUuid(v.principalId) &&
    isCanonicalUuid(v.assignmentId) &&
    isPositiveInt(v.assignmentVersion) &&
    isDocumentId(v.documentId) &&
    isPositiveInt(v.revision) &&
    isDeclarationForm(v.form) &&
    dataObject(v.ownWork, OWN_WORK_KEYS) &&
    v.ownWork.confirmed === true &&
    isHumanHelp(v.humanHelp) &&
    isAi(v.ai) &&
    isSubmissionInstant(v.confirmedAt)
  );
}

/** JCS text of a valid payload; throws for anything else. */
export function declarationPayloadJcs(payload: DeclarationPayloadV1): string {
  if (!isDeclarationPayloadV1(payload)) throw new TypeError("invalid declaration payload");
  return canonicalizeJcs(payload);
}

/**
 * `declarationSha256 = SHA-256(JCS(payload))` (section 1.1). Throws for an
 * invalid payload: no hash is taken of a value the server would not store.
 */
export function declarationSha256(payload: DeclarationPayloadV1): string {
  return sha256Hex(declarationPayloadJcs(payload));
}

/**
 * Strict UTF-8, JSON, then equality with the JCS of the result. The equality
 * also rejects duplicate keys, which `JSON.parse` would silently merge.
 * Returns `undefined` for anything that is not canonical JSON.
 */
export function parseCanonicalJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return canonicalizeJcs(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads stored payload bytes; anything but the JCS bytes of a valid payload gives null. */
export function parseDeclarationPayloadV1Bytes(bytes: Uint8Array): DeclarationPayloadV1 | null {
  const value = parseCanonicalJson(bytes);
  return isDeclarationPayloadV1(value) ? value : null;
}
