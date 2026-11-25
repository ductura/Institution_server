// SRV-V18-KODIRANJE-BAZA: the material of qualitative coding (migration
// 20261219390000_qualitative_coding.sql, same rules). Pure functions, no I/O.
export const MATERIAL_KINDS = ["interview", "note"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MAX_MATERIAL_TITLE_LENGTH = 200;
export const MAX_MATERIAL_BODY_LENGTH = 100_000;
export const MAX_MATERIALS_PER_PERSON = 200;

// A control character other than a line break or a tab (a lone \r is turned into
// a line break before the text is checked, so none is left to find here).
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** Characters, not UTF-16 units: the database counts and cuts the same way. */
export const lengthOf = (text: string): number => [...text].length;

/** A line break as \n, whatever the paste had (\r\n and a lone \r both become one). */
export function normalizeBody(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export function isMaterialKind(value: unknown): value is MaterialKind {
  return typeof value === "string" && (MATERIAL_KINDS as readonly string[]).includes(value);
}

/** One line of 1..max characters, trimmed, with something visible and no control character. */
export function isSingleLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    lengthOf(value) >= 1 &&
    lengthOf(value) <= max &&
    value === value.trim() &&
    !CONTROL.test(value)
  );
}

/** Text of 1..max characters with something visible; \n and \t allowed, other control characters not. */
export function isMultiLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    lengthOf(value) >= 1 &&
    lengthOf(value) <= max &&
    value.trim() !== "" &&
    !CONTROL_IN_TEXT.test(value)
  );
}

export function isMaterialTitle(value: unknown): value is string {
  return isSingleLine(value, MAX_MATERIAL_TITLE_LENGTH);
}

/** The text of a material as it is stored (normalised first by the caller). */
export function isMaterialBody(value: unknown): value is string {
  return isMultiLine(value, MAX_MATERIAL_BODY_LENGTH) && !value.includes("\r");
}

/**
 * The paragraphs of a text: its lines, an empty one included, so the index of a
 * paragraph is the same here, in the database and in the web page.
 */
export function paragraphsOf(text: string): string[] {
  return text.split("\n");
}
