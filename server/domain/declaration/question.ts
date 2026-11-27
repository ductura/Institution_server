import { isDeclaredText, isFormText } from "./text.ts";
import { dataObject, isCanonicalUuid, keySet } from "./shape.ts";

// SRV-IZJAVA-PITANJE (declaration-v1 section 6.8): the teacher's optional
// question with the declaration and the student's optional answer. The
// answer is no part of the hashed payload; the database binds it to the
// saved row (draft or confirmed version), so it is stale or bound exactly as
// that row is.

/** The teacher's question: up to 500 code points, multiline. */
export const MAX_DECLARATION_QUESTION_CODE_POINTS = 500;
/** The student's answer: up to 2000 code points, multiline. */
export const MAX_DECLARATION_ANSWER_CODE_POINTS = 2000;

export type DeclarationQuestionAnswer = { questionId: string; text: string };

const ANSWER_KEYS = keySet("questionId", "text");

/** The text of a question as the teacher sets it (NFC, trimmed, no control but line feed). */
export function isDeclarationQuestion(value: unknown): value is string {
  return isFormText(value, MAX_DECLARATION_QUESTION_CODE_POINTS);
}

/**
 * The optional `questionAnswer` of `student.declaration.put`: absent or null
 * is no answer, otherwise exactly {questionId, text}. Whether questionId
 * names a question of the assignment is the database's check.
 */
export function parseDeclarationQuestionAnswer(
  value: unknown,
): { ok: true; answer: DeclarationQuestionAnswer | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, answer: null };
  if (!dataObject(value, ANSWER_KEYS) || !isCanonicalUuid(value.questionId)) return { ok: false };
  if (!isDeclaredText(value.text)) return { ok: false };
  return { ok: true, answer: { questionId: value.questionId, text: value.text } };
}

/**
 * F4-PRE-R02-SRV2 (R-35, declaration-v1 section 6.9): the optional
 * `mismatchExplanation` of the v2 and v3 declaration PUT. Absent or null is
 * no explanation, otherwise a text as the answer (2000 code points,
 * multiline). Whether the choice and the record disagree is the client's call.
 */
export function parseDeclarationMismatchExplanation(
  value: unknown,
): { ok: true; explanation: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, explanation: null };
  return isDeclaredText(value) ? { ok: true, explanation: value } : { ok: false };
}
