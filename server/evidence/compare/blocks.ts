// The text blocks of a reconstructed document and the difference between two
// of them by blocks (SRV-9E, Ductus#2028). A block is one paragraph, heading,
// list item or quote of the canonical document, shown by its kind and plain
// text. The difference is computed on what is shown (kind, heading level,
// text), so a change that adds no character (a mark, a citation of v2 and v3,
// a footnote) is not a difference here. Pure: no I/O and no identity.

/** The most blocks one version may have; a longer document is too large to compare. */
export const MAX_COMPARE_BLOCKS = 5_000;
/** The most cells of the table between the changed middles; beyond it the middle is replaced whole. */
export const MAX_COMPARE_DIFF_CELLS = 4_000_000;

export type CompareBlock =
  | { readonly kind: "paragraph" | "bulletItem" | "quote"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string };

export type CompareChange = "unchanged" | "removed" | "added";
export type CompareEntry = CompareBlock & { readonly change: CompareChange };

const PLAIN = new Set(["paragraph", "bulletItem", "quote"]);

/**
 * A numbered list item (document v4 §2.2) is a text block like any other, but
 * the wire contract of work.compare.get knows only the kinds above and a new
 * kind would be a breaking change. It is therefore shown as a `paragraph`
 * with its text, as the text reader does (text-blocks.ts); its number is its
 * position in the run and is not text, so it is not part of the difference.
 */
const ORDERED_ITEM = "orderedItem";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of one block: its text children joined; other inline nodes add nothing. */
function textOf(children: unknown): string | null {
  if (!Array.isArray(children)) return null;
  let text = "";
  for (const child of children) {
    if (!isRecord(child) || typeof child.type !== "string") return null;
    if (child.type === "text") {
      if (typeof child.text !== "string") return null;
      text += child.text;
    }
  }
  return text;
}

/**
 * The blocks of a canonical document (the JCS text a replay ends with), in
 * document order; null when it is not a document of that shape. The replayer
 * has already loaded the document, so null means a shape this reader does
 * not know, never a guess.
 */
export function blocksOf(canonical: string): CompareBlock[] | null {
  let document: unknown;
  try {
    document = JSON.parse(canonical);
  } catch {
    return null;
  }
  if (!isRecord(document) || !Array.isArray(document.nodes)) return null;
  const blocks: CompareBlock[] = [];
  for (const node of document.nodes) {
    if (!isRecord(node) || typeof node.type !== "string") return null;
    const text = textOf(node.children);
    if (text === null) return null;
    if (node.type === "heading") {
      if (!Number.isSafeInteger(node.level)) return null;
      blocks.push({ kind: "heading", level: node.level as number, text });
    } else if (node.type === ORDERED_ITEM) {
      blocks.push({ kind: "paragraph", text });
    } else if (PLAIN.has(node.type)) {
      blocks.push({ kind: node.type as "paragraph" | "bulletItem" | "quote", text });
    } else {
      return null;
    }
  }
  return blocks;
}

const keyOf = (block: CompareBlock) =>
  JSON.stringify([block.kind, block.kind === "heading" ? block.level : 0, block.text]);

const entry = (block: CompareBlock, change: CompareChange): CompareEntry => ({ ...block, change });

/**
 * The difference from `before` to `after` in block order: every block of
 * both, each once, as unchanged, removed or added; a removed block comes
 * before the added ones at the same place. The common start and end are
 * unchanged; the middle between them is the longest common subsequence of
 * blocks when its table has at most `maxCells` cells, and otherwise every
 * block of the middle removed and then added (a correct, longer answer).
 */
export function diffBlocks(
  before: readonly CompareBlock[],
  after: readonly CompareBlock[],
  maxCells: number = MAX_COMPARE_DIFF_CELLS,
): CompareEntry[] {
  const a = before.map(keyOf);
  const b = after.map(keyOf);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const result = before.slice(0, start).map((block) => entry(block, "unchanged"));
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > maxCells) {
    for (let i = start; i < endA; i++) result.push(entry(before[i]!, "removed"));
    for (let j = start; j < endB; j++) result.push(entry(after[j]!, "added"));
  } else {
    // lcs[i * (m + 1) + j]: the longest common subsequence of a[start + i..endA) and b[start + j..endB).
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
            : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        result.push(entry(before[start + i]!, "unchanged"));
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
        result.push(entry(before[start + i]!, "removed"));
        i++;
      } else {
        result.push(entry(after[start + j]!, "added"));
        j++;
      }
    }
  }
  for (let i = endA; i < a.length; i++) result.push(entry(before[i]!, "unchanged"));
  return result;
}
