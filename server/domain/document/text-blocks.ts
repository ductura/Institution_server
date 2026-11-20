import { deriveBibliography, formatCitation, type CitationStyle } from "../citation/index.ts";

import { textBlockNodesV4 } from "./consumers-v4.ts";
import type {
  CanonicalDocument,
  CanonicalDocumentV2,
  CanonicalDocumentV3,
  CanonicalDocumentV4,
  InlineNodeV4,
} from "./schema.ts";

/**
 * One block of a document's text, in document order, without marks. The fast
 * path reader knows four kinds (F-150 point 1); `bulletItem` and `quote` are
 * not sent yet.
 */
export type TextBlock = { kind: "heading" | "paragraph" | "bulletItem" | "quote"; text: string };

/**
 * How a v2 citation is shown as text (contract §9.1): the in-text form of the
 * style, and `orphanMark` for a citation whose source is not in the document.
 * The caller supplies the mark, so no interface text lives in the domain.
 */
export type CitationRendering = { style: CitationStyle; orphanMark: string };

/**
 * A v3 citation with `via` (contract v3 §3.2) is shown with the original
 * first: `viaJoiner` (", cit. prema " in Croatian) stands between `via` and
 * the in-text form, inside the style's opening bracket. The caller supplies
 * it, like `orphanMark`.
 */
export type CitationRenderingV3 = CitationRendering & { viaJoiner: string };

/**
 * The text of a document as blocks: a heading of any level is a heading, and
 * every other text block (a paragraph, a bullet list item from E1) is still a
 * paragraph until the server part of F-150 point 1. The fast path reader
 * refuses a whole response with a kind it does not know, so a new block type
 * of the editor must not reach it unmapped.
 *
 * A v2 citation is never dropped: it becomes its visible in-text form, or the
 * orphan mark, with the locator as stored. In v3 the same holds, with `via`
 * in front; a footnote and a cross reference add no characters to the body
 * text (contract v3 §8): their number and text are the interface's to show.
 * In v4 the paragraphs of a box come in place and a code block is a block
 * with its text; an inline formula adds no characters, and a table, image,
 * formula or page break is no text block (contract v4 §11).
 */
export function textBlocksOf(document: CanonicalDocument): TextBlock[];
export function textBlocksOf(
  document: CanonicalDocumentV2,
  rendering: CitationRendering,
): TextBlock[];
export function textBlocksOf(
  document: CanonicalDocumentV3,
  rendering: CitationRenderingV3,
): TextBlock[];
export function textBlocksOf(
  document: CanonicalDocumentV4,
  rendering: CitationRenderingV3,
): TextBlock[];
export function textBlocksOf(
  document: CanonicalDocument | CanonicalDocumentV2 | CanonicalDocumentV3 | CanonicalDocumentV4,
  rendering?: CitationRendering | CitationRenderingV3,
): TextBlock[] {
  let text: (child: InlineNodeV4) => string = (child) => (child.type === "text" ? child.text : "");
  if (document.schemaVersion !== 1 && rendering !== undefined) {
    const { style, orphanMark } = rendering;
    // Citations stand only in text blocks, so in v4 the bibliography is read
    // over those, with the paragraphs of a box in place (contract v4 §11).
    const bibliography = deriveBibliography(
      document.schemaVersion === 4
        ? ({ ...document, schemaVersion: 3, nodes: textBlockNodesV4(document) } as never)
        : document,
      style,
    );
    const joiner = "viaJoiner" in rendering ? rendering.viaJoiner : "";
    text = (child) => {
      if (child.type === "text") return child.text;
      if (child.type !== "citation") return "";
      const shown = formatCitation(child, bibliography, style) ?? orphanMark;
      if (!("via" in child) || child.via === undefined) return shown;
      const open = style.inText.open;
      return shown.startsWith(open)
        ? `${open}${child.via}${joiner}${shown.slice(open.length)}`
        : `${child.via}${joiner}${shown}`;
    };
  }
  const nodes = document.schemaVersion === 4 ? textBlockNodesV4(document) : document.nodes;
  return (nodes as readonly { type: string; children: readonly InlineNodeV4[] }[]).map((node) => ({
    kind: node.type === "heading" ? "heading" : "paragraph",
    text: node.children.map(text).join(""),
  }));
}
