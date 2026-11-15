/**
 * Ported from Ductus `src/lib/i18n/parity.ts` at d52a92c3 (S-1L.1, DAN-768).
 *
 * Key parity between interface catalogues (D-70): every catalogue has the
 * keys of the Croatian one, the same length of every list, and the same
 * `{placeholders}` in every text. The `Messages` type checks the shape when a
 * catalogue is compiled; this checks the values a catalogue holds at run time.
 */
import { messagesEn } from "./en.ts";
import { messagesHr } from "./hr.ts";

type Leaf =
  | { readonly kind: "text"; readonly placeholders: string }
  | { readonly kind: "empty" }
  | { readonly kind: "other" };

export type CatalogueGaps = {
  /** Paths of the reference that the other catalogue does not fill the same way. */
  readonly missing: string[];
  /** Paths of the other catalogue that the reference does not have. */
  readonly extra: string[];
  /** Paths of texts whose placeholders differ. */
  readonly placeholders: string[];
};

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholdersOf(text: string): string {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]))].sort().join(",");
}

function leafOf(node: unknown): Leaf | null {
  if (typeof node === "string") return { kind: "text", placeholders: placeholdersOf(node) };
  if (typeof node !== "object" || node === null) return { kind: "other" };
  // A list is empty by its length: holes give `[ , ]` no keys, yet it holds a slot.
  return (Array.isArray(node) ? node.length : Object.keys(node).length) === 0
    ? { kind: "empty" }
    : null;
}

/**
 * How a path is reported: segments joined with dots, as long as that reads one
 * way only. A path with a dotted key, or one that would start like the other
 * form, is written as its segments in JSON (`["a.b"]` is not `a.b`).
 */
function shownPath(segments: readonly string[]): string {
  return segments.some((segment) => segment.includes(".")) || segments[0]?.startsWith("[")
    ? JSON.stringify(segments)
    : segments.join(".");
}

/**
 * Every text, empty section and stray value of a catalogue. A path is told by
 * its segments in JSON, never by a dotted join: a key may hold a dot, and
 * `"a.b"` and a → b must not share one entry.
 */
function leaves(
  node: unknown,
  segments: readonly string[] = [],
  into = new Map<string, { path: string; leaf: Leaf }>(),
) {
  const leaf = leafOf(node);
  if (leaf) {
    // An empty catalogue has no leaves: a root with nothing in it is not a missing or extra key.
    if (segments.length > 0 || leaf.kind !== "empty")
      into.set(JSON.stringify(segments), { path: shownPath(segments), leaf });
    return into;
  }
  for (const [key, value] of Object.entries(node as object))
    leaves(value, [...segments, key], into);
  // `Object.entries` skips holes, so a list that ends in one would read as shorter than it is.
  // Its last slot stands for the length: reported as a stray value, the way a list of other length is.
  if (Array.isArray(node) && !Object.hasOwn(node, node.length - 1)) {
    const segmentsOfLast = [...segments, String(node.length - 1)];
    into.set(JSON.stringify(segmentsOfLast), {
      path: shownPath(segmentsOfLast),
      leaf: { kind: "other" },
    });
  }
  return into;
}

/** What the other catalogue lacks, adds or words with other placeholders, compared with the reference. */
export function catalogueGaps(reference: unknown, other: unknown): CatalogueGaps {
  const want = leaves(reference);
  const have = leaves(other);
  const gaps: CatalogueGaps = { missing: [], extra: [], placeholders: [] };
  for (const [id, { path, leaf }] of want) {
    const found = have.get(id)?.leaf;
    if (found?.kind !== leaf.kind) gaps.missing.push(path);
    else if (
      leaf.kind === "text" &&
      found.kind === "text" &&
      leaf.placeholders !== found.placeholders
    )
      gaps.placeholders.push(path);
  }
  for (const [id, { path, leaf }] of have)
    if (want.get(id)?.leaf.kind !== leaf.kind) gaps.extra.push(path);
  return gaps;
}

/** Letters and symbols that render blank: Hangul fillers and the empty Braille pattern. */
const BLANK_GLYPHS = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

/**
 * A text a reader can see holds at least one letter, number, punctuation mark
 * or symbol that is not a blank glyph. White space, format characters
 * (zero-width spaces and joiners, soft hyphen), combining marks alone
 * (U+034F, variation selectors) and private-use characters are not seen.
 */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

function isInvisible(text: string): boolean {
  return !VISIBLE.test(text.replace(BLANK_GLYPHS, ""));
}

/**
 * Texts of a catalogue that hold nothing a reader can see, and sections whose
 * form (list or table) differs from the reference. A missing text would be
 * shown as an empty label, and a table where a list stands has no length.
 */
function unfitTexts(reference: unknown, node: unknown, segments: readonly string[] = []): string[] {
  if (typeof node === "string") return isInvisible(node) ? [shownPath(segments)] : [];
  if (typeof node !== "object" || node === null) return [];
  if (Array.isArray(node) !== Array.isArray(reference)) return [shownPath(segments)];
  return Object.entries(node).flatMap(([key, value]) =>
    unfitTexts(
      typeof reference === "object" && reference !== null
        ? (reference as Record<string, unknown>)[key]
        : undefined,
      value,
      [...segments, key],
    ),
  );
}

/**
 * A catalogue is complete when it has every key of the reference and no other,
 * the same `{placeholders}` in every text, a list wherever the reference has
 * one, and no text a reader cannot see. It is checked by
 * value, at run time; a catalogue that throws while it is read is not complete.
 */
export function isCompleteCatalogue(reference: unknown, candidate: unknown): boolean {
  try {
    const gaps = catalogueGaps(reference, candidate);
    return (
      gaps.missing.length === 0 &&
      gaps.extra.length === 0 &&
      gaps.placeholders.length === 0 &&
      unfitTexts(reference, candidate).length === 0
    );
  } catch {
    return false;
  }
}

/** Croatian is the default interface language and the reference of every other catalogue. */
export const DEFAULT_LANGUAGE = "hr";

/** An ISO 639-1 code other than Croatian, in lower case: `HR`, ` hr` or `hr-HR` are not candidates. */
const LANGUAGE_CODE = /^(?!hr$)[a-z]{2}$/;

/**
 * The interface languages to offer: Croatian always and first, then every other
 * language whose catalogue is complete against the Croatian one (S-1L.5, DAN-781).
 * Croatian is never taken from `catalogues`: an entry under `hr`, or under any
 * code that is not two lower-case letters, is not a candidate, and catalogues
 * that cannot be listed leave only the default.
 */
export function offeredLanguages(
  reference: unknown,
  catalogues: Readonly<Record<string, unknown>>,
): string[] {
  const offered = [DEFAULT_LANGUAGE];
  try {
    for (const [language, catalogue] of Object.entries(catalogues))
      if (LANGUAGE_CODE.test(language) && isCompleteCatalogue(reference, catalogue))
        offered.push(language);
  } catch {
    // Catalogues that cannot be listed offer nothing but the default.
    return [DEFAULT_LANGUAGE];
  }
  return offered;
}

/** Every interface catalogue of this repository other than Croatian, by language. */
export const INTERFACE_CATALOGUES: Readonly<Record<string, unknown>> = Object.freeze({
  en: messagesEn,
});

/** The languages the interface offers today; a catalogue that falls behind Croatian drops out. */
export const OFFERED_LANGUAGES: readonly string[] = Object.freeze(
  offeredLanguages(messagesHr, INTERFACE_CATALOGUES),
);
