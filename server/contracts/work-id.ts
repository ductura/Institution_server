// The one check of a work id (S-1H.1-c). Every route that takes a work id in
// its path, query or body checks it here and nowhere else, so a route cannot
// accept an id that the database would refuse or a different route rejects.

/** Longest work id, in code points: `length(id)` in the `evidence.document` CHECK. */
export const WORK_ID_MAX = 256;

// C0 and C1 control characters, as `[[:cntrl:]]` in the CHECK.
const CONTROL = /\p{Cc}/u;
// A lone UTF-16 surrogate: not valid UTF-8, so the database cannot store it.
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * A work id as `evidence.document.id` allows it: 1 to 256 code points, no
 * leading or trailing whitespace, no control characters, valid Unicode.
 * Same rule as Ductus `isDocumentId` (src/domain/collaboration/comment.ts).
 *
 * The id is opaque data: quotes, `;` or `../` pass, because the id only ever
 * reaches the database as a bound RPC parameter. It is not a file name; no
 * caller may build a path or storage key from it.
 */
export function isWorkId(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  if (CONTROL.test(value) || LONE_SURROGATE.test(value)) return false;
  const length = [...value].length;
  return length >= 1 && length <= WORK_ID_MAX;
}

/**
 * The work id in one raw (still percent-encoded) path segment, or null.
 * Decodes exactly once, so `%00` becomes a control character and is refused,
 * and `%2500` stays the literal text `%00`. Broken encoding is null.
 */
export function workIdFromPath(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isWorkId(decoded) ? decoded : null;
}
