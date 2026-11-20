import { documentWordCountV4 } from "./consumers-v4.ts";
import type { DocumentNodeV3, InlineNodeV3, VersionedDocument } from "./schema.ts";

/**
 * Word count over the canonical text: whitespace-separated runs, counted per
 * block so a paragraph break never fuses two words. An atom (a v2 citation;
 * in v3 also a footnote and a cross reference) is one position without
 * characters (contract v2 §9.1, v3 §8): it adds no word, but it separates the
 * text on its two sides, so "Prva", citation, "riječ" is two words and never
 * one. The text of a footnote is not counted.
 *
 * A reading aid, nothing more. It is never evidence about authorship and
 * never decides anything. A v4 document is counted by `documentWordCountV4`
 * (contract v4 §11).
 */
export function documentWordCount(doc: VersionedDocument): number {
  if (doc.schemaVersion === 4) return documentWordCountV4(doc);
  let total = 0;
  for (const node of doc.nodes as readonly DocumentNodeV3[]) {
    const children: readonly InlineNodeV3[] = node.children;
    const text = children.map((child) => (child.type === "text" ? child.text : " ")).join("");
    for (const word of text.split(/\s+/u)) {
      if (word.length > 0) {
        total += 1;
      }
    }
  }
  return total;
}
