import type { ConversationAttachmentReason } from "./constants.ts";

/**
 * One event from the evidence chain up to the declaration's revision that
 * points at the conversation (section 2.2). `text` is the transferred or
 * pasted text as recorded.
 */
export type ConversationEvent =
  | { kind: "transfer"; text: string }
  | {
      kind: "paste";
      verdict: "known" | "not_observed";
      originKind: string;
      text: string;
    };

export type ReasonInput = {
  events: readonly ConversationEvent[];
  /** Full text of the revision the declaration is for. */
  revisionText: string;
  /** The student picked this conversation themselves. */
  studentSelected: boolean;
};

const qualifies = (e: ConversationEvent): boolean =>
  e.kind === "transfer" || (e.verdict === "known" && e.originKind === "ai-response");

/**
 * Reason of a conversation attachment, first row of the table that holds
 * (section 2.2), or null when the conversation is neither mandatory nor
 * selected. Later deletion does not lift the obligation: deleted text gives
 * `transferred_deleted`, which stays mandatory (OD-8).
 */
export function resolveAttachmentReason(input: ReasonInput): ConversationAttachmentReason | null {
  const qualifying = input.events.filter(qualifies);
  if (qualifying.length > 0) {
    if (!qualifying.some((e) => input.revisionText.includes(e.text))) return "transferred_deleted";
    return qualifying.some((e) => e.kind === "transfer") ? "transferred" : "pasted_known";
  }
  return input.studentSelected ? "student_added" : null;
}

export const isMandatoryReason = (reason: ConversationAttachmentReason): boolean =>
  reason !== "student_added";
