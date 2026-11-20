/**
 * Structural comparison of canonical documents. Both functions are pure and
 * allocate nothing beyond a few locals, so they are safe on every keystroke
 * batch.
 *
 * Documents of different schema versions are never equal. In v2 a citation
 * equals only a citation with the same source and locator (an absent locator
 * is not ""), and the ordered source list is part of the document (§9.1).
 * In v3 every atom equals only an atom of the same type with the same fields
 * (contract v3 §8), and v3 keeps the sources of v2.
 */

import {
  DOCUMENT_SCHEMA_VERSION,
  type DocumentNodeV3,
  type InlineNodeV3,
  type VersionedDocument,
} from "./schema.ts";

function inlineEqual(a: InlineNodeV3, b: InlineNodeV3): boolean {
  if (a.type !== "text" || b.type !== "text") {
    // An atom's fields are strings, so JSON equality is field equality.
    return a.type === b.type && jsonEqual(a, b);
  }
  return (
    a.text === b.text &&
    a.marks.length === b.marks.length &&
    a.marks.every((mark, j) => mark === b.marks[j])
  );
}

function childrenEqual(a: readonly InlineNodeV3[], b: readonly InlineNodeV3[]): boolean {
  return a.length === b.length && a.every((child, i) => inlineEqual(child, b[i]!));
}

function shapeEqual(a: DocumentNodeV3, b: DocumentNodeV3): boolean {
  if (a.type !== b.type) {
    return false;
  }
  if (a.type === "heading" && b.type === "heading" && a.level !== b.level) {
    return false;
  }
  return childrenEqual(a.children, b.children);
}

/** JSON data equality; a key holding `undefined` counts as absent, as in JSON. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((key) => o[key] !== undefined);
  const xKeys = keys(x);
  return (
    xKeys.length === keys(y).length &&
    xKeys.every((key) => Object.hasOwn(y, key) && jsonEqual(x[key], y[key]))
  );
}

/** Same version, same number of blocks and, from v2, the same ordered sources. */
function sameFrame(a: VersionedDocument, b: VersionedDocument): boolean {
  if (a.schemaVersion !== b.schemaVersion || a.nodes.length !== b.nodes.length) {
    return false;
  }
  return (
    a.schemaVersion === DOCUMENT_SCHEMA_VERSION ||
    b.schemaVersion === DOCUMENT_SCHEMA_VERSION ||
    jsonEqual(a.sources, b.sources)
  );
}

/**
 * Full structural equality, node ids included.
 *
 * Ids are canonical identity, not a rendering detail: two documents with the
 * same text in differently identified paragraphs are *not* the same document,
 * because comments, evidence and revisions are anchored to those ids.
 */
export function documentsEqual(a: VersionedDocument, b: VersionedDocument): boolean {
  if (!sameFrame(a, b)) {
    return false;
  }
  const other = b.nodes as readonly DocumentNodeV3[];
  return (a.nodes as readonly DocumentNodeV3[]).every(
    (node, i) => node.id === other[i]!.id && shapeEqual(node, other[i]!),
  );
}

/**
 * Equality ignoring node ids: same block types, levels and inline content in
 * the same order (and, in v2, the same sources). Used by the conflict UX to
 * tell "the same text was retyped elsewhere" apart from "the text actually
 * diverged"; never used to decide whether a write is needed, because id churn
 * is itself a real change.
 */
export function contentEqual(a: VersionedDocument, b: VersionedDocument): boolean {
  if (!sameFrame(a, b)) {
    return false;
  }
  const other = b.nodes as readonly DocumentNodeV3[];
  return (a.nodes as readonly DocumentNodeV3[]).every((node, i) => shapeEqual(node, other[i]!));
}
