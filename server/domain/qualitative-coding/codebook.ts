// SRV-V18-KODIRANJE-BAZA: the codebook of a person. The order is the owner's
// (V18-8): nothing here sorts by how often a code is used.
import { isSingleLine } from "./material.ts";

export const MAX_CODE_NAME_LENGTH = 80;
export const MAX_CODE_DESCRIPTION_LENGTH = 500;
export const MAX_CODES_PER_PERSON = 200;

export type CodebookEntry = { id: string; name: string; description: string; order: number };

export function isCodeName(value: unknown): value is string {
  return isSingleLine(value, MAX_CODE_NAME_LENGTH);
}

/** No description is the empty one. */
export function isCodeDescription(value: unknown): value is string {
  return value === "" || isSingleLine(value, MAX_CODE_DESCRIPTION_LENGTH);
}

/** A code of the same name, the case aside, is the same code. */
export function sameCodeName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The codebook after a code moves to a place (1 = first); the others keep their
 * order and everything is numbered 1..n again. `undefined` for a code that is not
 * in it or a place outside 1..n.
 */
export function moveCode(
  codebook: readonly CodebookEntry[],
  id: string,
  position: number,
): CodebookEntry[] | undefined {
  const ordered = [...codebook].sort((a, b) => a.order - b.order);
  const moved = ordered.find((entry) => entry.id === id);
  if (!moved || !Number.isInteger(position) || position < 1 || position > ordered.length) {
    return undefined;
  }
  const others = ordered.filter((entry) => entry.id !== id);
  others.splice(position - 1, 0, moved);
  return others.map((entry, index) => ({ ...entry, order: index + 1 }));
}
