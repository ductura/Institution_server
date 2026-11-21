import { MAX_DECLARED_TEXT_CODE_POINTS, MAX_TOOL_FIELD_CODE_POINTS } from "./constants.ts";

// Declared text (section 1.6). The text must already be NFC: the payload is
// hashed as sent, so normalising here would hash something the student did not
// send. A client normalises before it sends.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const BOM = /\uFEFF/u;
// Embeddings, overrides, isolates and the implicit marks LRM, RLM and ALM.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;
const CONTROL = /\p{Cc}/u;
const EDGE_WHITESPACE = /^\s|\s$/u;
const NON_WHITESPACE = /\S/u;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isDeclaredTextWith(
  value: unknown,
  maxCodePoints: number,
  multiline: boolean,
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (LONE_SURROGATE.test(value) || BOM.test(value) || BIDI.test(value)) return false;
  if ((multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(value)) return false;
  if (!NON_WHITESPACE.test(value) || EDGE_WHITESPACE.test(value)) return false;
  if (value.normalize("NFC") !== value) return false;
  return codePointLength(value) <= maxCodePoints;
}

/** `humanHelp.entries[].text`: may hold a newline. */
export function isDeclaredText(value: unknown): value is string {
  return isDeclaredTextWith(value, MAX_DECLARED_TEXT_CODE_POINTS, true);
}

/** `toolLabel`, `purposeText`, `phaseText`: one line. */
export function isToolFieldText(value: unknown): value is string {
  return isDeclaredTextWith(value, MAX_TOOL_FIELD_CODE_POINTS, false);
}

/** The text of a declaration form file (multiline, own limit). */
export function isFormText(value: unknown, maxCodePoints: number): value is string {
  return isDeclaredTextWith(value, maxCodePoints, true);
}
