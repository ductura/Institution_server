// Limits and closed sets of declaration v1 (docs/contracts/declaration-v1.md,
// sections 1 and 4). The values are the owner decisions OD-3, OD-4 and OD-12 of
// 21 November 2026; they change only with a new contract version.

export const DECLARATION_SCHEMA = "ductura-declaration-v1" as const;

/** OD-3: the only formats of an external attachment in v1. */
export const EXTERNAL_FORMATS = ["text/plain", "application/pdf"] as const;
export type ExternalFormat = (typeof EXTERNAL_FORMATS)[number];

/** OD-4 */
export const MAX_EXTERNAL_ATTACHMENT_BYTES = 2_097_152;
export const MAX_EXTERNAL_ATTACHMENTS = 10;
export const MAX_EXTERNAL_TOTAL_BYTES = 10_485_760;
/** Counts only `student_added` conversations; mandatory ones never hit it. */
export const MAX_ATTACHED_CONVERSATIONS = 50;
export const MAX_HUMAN_HELP_ENTRIES = 20;
export const MAX_DECLARED_TOOLS = 20;
export const MAX_DECLARED_TEXT_CODE_POINTS = 2000;
export const MAX_TOOL_FIELD_CODE_POINTS = 200;
/** Same as evidence-segment-v4. */
export const MAX_DECLARATION_ID_LENGTH = 256;

/** OD-12: closed set of kinds of human help (section 1.4). */
export const HUMAN_HELP_KINDS = [
  "language",
  "structure",
  "sources",
  "content",
  "technical",
  "other",
] as const;
export type HumanHelpKind = (typeof HUMAN_HELP_KINDS)[number];

export const AI_USES = ["used", "not_used"] as const;
export type AiUse = (typeof AI_USES)[number];

/**
 * Reasons of a conversation attachment in table order (section 2.2): when more
 * than one holds, the first wins. The same order sorts `ai.attachments`, with
 * `external_upload` last (section 1.5; the vector in section 9 puts
 * `transferred` before `external_upload`).
 */
export const CONVERSATION_ATTACHMENT_REASONS = [
  "transferred_deleted",
  "transferred",
  "pasted_known",
  "student_added",
] as const;
export type ConversationAttachmentReason = (typeof CONVERSATION_ATTACHMENT_REASONS)[number];
export const EXTERNAL_ATTACHMENT_REASON = "external_upload" as const;
export const ATTACHMENT_REASON_ORDER = [
  ...CONVERSATION_ATTACHMENT_REASONS,
  EXTERNAL_ATTACHMENT_REASON,
] as const;
export type AttachmentReason = (typeof ATTACHMENT_REASON_ORDER)[number];
