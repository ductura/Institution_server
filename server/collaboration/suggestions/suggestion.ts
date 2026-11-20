// SRV-8F: a teacher's text suggestion is a record of its own with an anchor
// (Ductus docs/backend/suradnja.md §4.15, D-34; D-266 point 1, ARCHITECTURE
// §5a). It is never a mark in the editor schema and never a change of the
// document: the work's text changes only when its student owner accepts the
// suggestion, as the student's own write of the live state.
import { isTextAnchorInput, type TextAnchor } from "../../domain/collaboration/index.ts";

/** The longest suggested text, in code points (as the comment body). */
export const SUGGESTION_TEXT_MAX = 2000;

/** The decided states (§4.15 „Stanja koja su odlučena”: čeka, prihvaćen, odbijen). */
export const SUGGESTION_STATES = ["pending", "accepted", "rejected"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];
export type SuggestionAction = "accept" | "reject";

/** A stored suggestion, as its owner (the database) keeps it: never rewritten. */
export type Suggestion = {
  readonly suggestionId: string;
  readonly documentId: string;
  readonly anchor: TextAnchor;
  /** The text that replaces the anchored quote; empty removes it. */
  readonly text: string;
  readonly state: SuggestionState;
};

/** What the teacher's client sends; author, scope and state come from the session. */
export type SuggestionInput = { readonly anchor: TextAnchor; readonly text: string };

const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
// C0, DEL and C1: a paragraph holds no line break, so no control character at all.
const CONTROL = /\p{Cc}/u;
const INPUT_KEYS = ["anchor", "text"];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text a paragraph can hold: NFC, well formed, no control or bidi character. */
export function isSuggestionText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !LONE_SURROGATE.test(value) &&
    value.normalize("NFC") === value &&
    [...value].length <= SUGGESTION_TEXT_MAX &&
    !CONTROL.test(value) &&
    !BIDI.test(value)
  );
}

/**
 * Exactly `anchor` and `text`; a suggestion that leaves the quote as it is
 * changes nothing and is refused. Unknown fields are refused, not ignored.
 */
export function isSuggestionInput(value: unknown): value is SuggestionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== INPUT_KEYS.length || keys.some((key, i) => key !== INPUT_KEYS[i])) {
    return false;
  }
  return (
    isTextAnchorInput(input.anchor) &&
    isSuggestionText(input.text) &&
    input.text !== input.anchor.quote
  );
}

/**
 * The transition table. Only a pending suggestion moves, once; every other
 * (state, action) pair is null, which the database answers with ZD409.
 * Withdrawal, editing and lost membership wait for Ductus question #1489-3.
 */
export function nextState(
  state: SuggestionState,
  action: SuggestionAction,
): SuggestionState | null {
  if (state !== "pending") return null;
  return action === "accept" ? "accepted" : "rejected";
}
