/**
 * The imported file's name as the mentor sees it (SRV-1801, D-292; ADR
 * docs/adr/import-contract.md §3, attack classes N1 to N9).
 *
 * Stored only in the nullable column `import_event.file_name`: never in the
 * hashed manifest, the segment or a receipt, so retention (D-30, Q-16) can
 * erase it without touching any hash. It is always shown as text, never as
 * markup.
 */
import { Type, type Static } from "@sinclair/typebox";

/** Longest name kept, in Unicode code points. */
export const MAX_IMPORT_FILE_NAME_LENGTH = 200;

/**
 * A stored name: what {@link normalizeImportFileName} can return, or null.
 * `maxLength` counts UTF-16 units, so it is twice the code point bound; the
 * code point bound itself is held by the normaliser.
 */
export const ImportFileNameV1 = Type.Union([
  Type.String({ minLength: 1, maxLength: MAX_IMPORT_FILE_NAME_LENGTH * 2 }),
  Type.Null(),
]);
export type ImportFileNameV1 = Static<typeof ImportFileNameV1>;

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
// Controls (C0, DEL, C1), format characters (bidi, zero width, BOM, soft hyphen),
// line or paragraph separators and default-ignorable code points (combining
// grapheme joiner, variation selectors, Hangul fillers): none is visible, so
// none may change what the mentor reads.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
const WHITESPACE = /\s+/gu;

function clean(value: string): string {
  // Invisible characters go before NFC: one between a letter and its mark
  // would otherwise leave an uncomposed pair behind.
  return value
    .replace(LONE_SURROGATES, "")
    .replace(INVISIBLE, "")
    .normalize("NFC")
    .replace(WHITESPACE, " ")
    .trim();
}

/**
 * The last path segment, cleaned and cut at a code point boundary; `null` when
 * nothing usable is left. Applying it to its own output changes nothing.
 */
export function normalizeImportFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const segments = value.split(/[\\/]/u);
  let name = clean(segments[segments.length - 1] ?? "");
  const points = Array.from(name);
  if (points.length > MAX_IMPORT_FILE_NAME_LENGTH) {
    name = clean(points.slice(0, MAX_IMPORT_FILE_NAME_LENGTH).join(""));
  }
  if (name === "" || name === "." || name === "..") return null;
  return name;
}
