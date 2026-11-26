// SRV-8F: the student's acceptance of a suggestion, as a pure function over
// the live state (a v1 document, the same check as live.document.put). It
// returns a new document and the change to record; the document it is given
// is never touched, so a suggestion alone changes neither the work nor its
// hash. The student's client publishes the result with its own PUT, so the
// one writer of the work stays the student (§4.15 invariant 1).
import { resolveTextAnchor } from "../index.ts";
import {
  MAX_DOCUMENT_SNAPSHOT_BYTES,
  validateDocument,
  type CanonicalDocument,
  type InlineNode,
  type NodeId,
} from "../../document/index.ts";
import { canonicalizeJcs } from "../../forensics/index.ts";

import type { Suggestion } from "./suggestion.ts";

/**
 * The recorded change: the student's write, with its origin a teacher's
 * suggestion („izmjena nastavnika”, D-34, D-58). Offsets are UTF-16 units in
 * the text of the node. It holds no person: the author is the stored record's.
 */
export type SuggestionChange = {
  readonly source: "teacher-suggestion";
  readonly suggestionId: string;
  readonly nodeId: NodeId;
  readonly start: number;
  readonly end: number;
  readonly removed: string;
  readonly inserted: string;
};

export type ApplyOutcome =
  | {
      readonly ok: true;
      readonly document: CanonicalDocument;
      /** The exact JCS text to publish with live.document.put. */
      readonly text: string;
      readonly change: SuggestionChange;
    }
  /** `not_pending`: already accepted or rejected; `missing`/`ambiguous`: no single place. */
  | {
      readonly ok: false;
      readonly reason: "not_pending" | "missing" | "ambiguous" | "invalid" | "too_large";
    };

/** The children with [start, end) replaced by `inserted`, which takes the marks of the first removed character. */
function replaceRange(
  children: readonly InlineNode[],
  start: number,
  end: number,
  inserted: string,
): InlineNode[] {
  const pieces: InlineNode[] = [];
  let offset = 0;
  let placed = false;
  for (const child of children) {
    const from = offset;
    const to = offset + child.text.length;
    offset = to;
    const keep = (text: string) => pieces.push({ type: "text", text, marks: [...child.marks] });
    if (to <= start || from >= end) {
      keep(child.text);
      continue;
    }
    if (from < start) keep(child.text.slice(0, start - from));
    if (!placed) {
      keep(inserted);
      placed = true;
    }
    if (to > end) keep(child.text.slice(end - from));
  }
  // Canonical inline form: no empty text, neighbours with the same marks merged.
  const merged: InlineNode[] = [];
  for (const piece of pieces) {
    if (piece.text.length === 0) continue;
    const last = merged.at(-1);
    if (last && last.marks.join() === piece.marks.join()) {
      merged[merged.length - 1] = { ...last, text: last.text + piece.text };
    } else merged.push(piece);
  }
  return merged;
}

export function applySuggestion(document: CanonicalDocument, suggestion: Suggestion): ApplyOutcome {
  if (suggestion.state !== "pending") return { ok: false, reason: "not_pending" };
  const { anchor } = suggestion;
  const index = document.nodes.findIndex((node) => node.id === anchor.nodeId);
  const node = document.nodes[index];
  if (node === undefined) return { ok: false, reason: "missing" };
  const nodeText = node.children.map((child) => child.text).join("");
  const place = resolveTextAnchor(anchor, node.id, nodeText);
  if (place.status === "missing" || place.status === "ambiguous") {
    return { ok: false, reason: place.status };
  }
  const children = replaceRange(node.children, place.start, place.end, suggestion.text);
  const nodes = document.nodes.map((each, i) => (i === index ? { ...each, children } : each));
  const valid = validateDocument({ schemaVersion: document.schemaVersion, nodes });
  if (!valid.ok) return { ok: false, reason: "invalid" };
  const text = canonicalizeJcs(valid.doc);
  if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_SNAPSHOT_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return {
    ok: true,
    document: valid.doc,
    text,
    change: {
      source: "teacher-suggestion",
      suggestionId: suggestion.suggestionId,
      nodeId: node.id,
      start: place.start,
      end: place.end,
      removed: nodeText.slice(place.start, place.end),
      inserted: suggestion.text,
    },
  };
}
