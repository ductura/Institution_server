/**
 * What the consumers of a canonical document need of v4
 * (docs/contracts/document-schema-v4.md §11): the text blocks in document
 * order with the paragraphs of a box in place, the word count, the
 * normalization and the comparison without ids. Pure; nothing is mutated.
 */

import {
  MARK_V4_ORDER,
  markV4Type,
  type CanonicalDocumentV4,
  type DocumentNodeV4,
  type InlineNodeV4,
  type MarkV4,
} from "./schema.ts";
import { marksV4Key } from "./validate-marks-v4.ts";

/** A v4 block that holds inline nodes. */
export type TextBlockNodeV4 = Extract<DocumentNodeV4, { children: InlineNodeV4[] }>;

const BLOCK_ATOMS = new Set(["table", "image", "formula", "pageBreak"]);

/**
 * The text blocks of a v4 document in order: a box gives its paragraphs in
 * place, and the atoms of a block (table, image, formula, page break) give
 * none (contract §11).
 */
export function textBlockNodesV4(doc: CanonicalDocumentV4): TextBlockNodeV4[] {
  return doc.nodes.flatMap((node): TextBlockNodeV4[] => {
    if (node.type === "box") return node.children;
    return BLOCK_ATOMS.has(node.type) ? [] : [node as TextBlockNodeV4];
  });
}

/**
 * Words of the body text (contract §11): paragraphs (in a box too),
 * headings, bullet items and quotes. A code block, a table, an image and a
 * formula add none; every inline atom separates the text on its two sides.
 */
export function documentWordCountV4(doc: CanonicalDocumentV4): number {
  let total = 0;
  for (const node of textBlockNodesV4(doc)) {
    if (node.type === "codeBlock") continue;
    const text = node.children.map((child) => (child.type === "text" ? child.text : " ")).join("");
    total += text.split(/\s+/u).filter((word) => word.length > 0).length;
  }
  return total;
}

/**
 * A copy of a mark whose attribute keys are in sorted order, as the
 * validator writes them, so equal marks always give equal `marksV4Key`.
 */
function sortedMark(mark: MarkV4): MarkV4 {
  if (typeof mark === "string") return mark;
  const entries = Object.entries(mark).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries) as MarkV4;
}

/** Marks deduplicated by type, in the canonical order of §3, keys sorted. */
function canonicalMarksV4(marks: readonly MarkV4[]): MarkV4[] {
  const byType = new Map<string, MarkV4>();
  for (const mark of marks) {
    if (!byType.has(markV4Type(mark))) byType.set(markV4Type(mark), sortedMark(mark));
  }
  return MARK_V4_ORDER.flatMap((type) => (byType.has(type) ? [byType.get(type)!] : []));
}

function normalizeChildrenV4(children: readonly InlineNodeV4[]): InlineNodeV4[] {
  const result: InlineNodeV4[] = [];
  for (const child of children) {
    if (child.type !== "text") {
      result.push(structuredClone(child));
      continue;
    }
    if (child.text.length === 0) continue;
    const marks = canonicalMarksV4(child.marks);
    const previous = result[result.length - 1];
    if (previous?.type === "text" && marksV4Key(previous.marks) === marksV4Key(marks)) {
      result[result.length - 1] = { type: "text", text: previous.text + child.text, marks };
      continue;
    }
    result.push({ type: "text", text: child.text, marks });
  }
  return result;
}

function normalizeBlockV4(node: DocumentNodeV4): DocumentNodeV4 {
  if (node.type === "box") {
    return { ...node, children: node.children.map((child) => normalizeBlockV4(child)) as never };
  }
  if (!("children" in node)) return structuredClone(node);
  return { ...node, children: normalizeChildrenV4(node.children) } as DocumentNodeV4;
}

/**
 * Joins adjacent text with the same marks (attributes included, in a code
 * block too) and puts marks in canonical order. Atoms of a block, a box's
 * kind and every block field stay as they are.
 */
export function normalizeDocumentV4(doc: CanonicalDocumentV4): CanonicalDocumentV4 {
  return {
    schemaVersion: doc.schemaVersion,
    nodes: doc.nodes.map(normalizeBlockV4),
    sources: structuredClone(doc.sources),
    ...(doc.cover ? { cover: { ...doc.cover } } : {}),
  };
}

/** A copy without the `id` of any block, the paragraphs of a box included. */
export function withoutBlockIdsV4(doc: CanonicalDocumentV4): unknown {
  const strip = (node: DocumentNodeV4): unknown => {
    const rest = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "id"));
    return node.type === "box" ? { ...rest, children: node.children.map(strip) } : rest;
  };
  return { ...doc, nodes: doc.nodes.map(strip) };
}
