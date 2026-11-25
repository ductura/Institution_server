// SRV-V18-KODIRANJE-BAZA: the anchor of a marked passage. A passage is the
// characters start..end (0-based, end exclusive) of one paragraph (a line of the
// text); the quote must be exactly those characters.
import { isMultiLine, lengthOf, paragraphsOf } from "./material.ts";

export const MAX_QUOTE_LENGTH = 500;
export const MAX_MEMO_LENGTH = 1000;
export const MAX_SEGMENTS_PER_MATERIAL = 5000;

export type Anchor = { paragraph: number; start: number; end: number; quote: string };

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/** Does the anchor describe exactly its quote in the text? A quote of white space only does not. */
export function isAnchorOfText(text: string, anchor: Anchor): boolean {
  const { paragraph, start, end, quote } = anchor;
  if (!isCount(paragraph) || !isCount(start) || !isCount(end) || typeof quote !== "string")
    return false;
  if (end <= start || end - start > MAX_QUOTE_LENGTH) return false;
  if (lengthOf(quote) !== end - start || quote.replace(/[ \t]/gu, "") === "") return false;
  const line = paragraphsOf(text)[paragraph];
  if (line === undefined) return false;
  return [...line].slice(start, end).join("") === quote;
}

/** The memo of a passage: up to 1000 characters; no memo is `null`, never the empty text. */
export const isMemo = (value: unknown): value is string => isMultiLine(value, MAX_MEMO_LENGTH);
