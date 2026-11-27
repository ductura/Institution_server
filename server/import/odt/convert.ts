// The body of an ODT (content.xml) as a Ductura document v2 and its traces
// (F4-PM2-R18 step 3; ADR docs/adr/import-manifest-v2.md §2 and §2a). The
// text is the body of office:text: paragraphs, headings (outline level 1 to 3),
// list items, quotes (the Quotations paragraph style), bold and italic from the
// automatic text styles. Tables are read cell by cell as paragraphs. Never in
// the text: office:annotation, text:tracked-changes (so no deleted text),
// notes, frames and drawings, and the fields that show an author or sender
// (M1, M15, K8). Inserted text stays, it is part of the document. Headers and
// footers live in styles.xml, which is never read. The traces count
// office:annotation (not office:annotation-end) and each text:changed-region
// by its text:deletion or text:insertion; a text:format-change is neither.
// Text goes through the same cleaning as DOCX (cleanText). Text is counted as
// it is built, so a part that would make more text than one segment holds is
// refused while reading (L2), never built first.
import {
  canonicalMarks,
  MAX_EVIDENCE_SEGMENT_BYTES,
  newNodeId,
  type DocumentNodeV2,
  type HeadingLevel,
  type InlineNode,
  type Mark,
} from "../../domain/index.ts";
import type { ImportTraceV1 } from "../../contracts/index.ts";

import { attributeOf, cleanText, elementsOf, type XmlElement } from "../docx/index.ts";

export const OFFICE_NS = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
export const TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
export const TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
export const STYLE_NS = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
export const FO_NS = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";

/** Fields whose shown value names a person: never text (M1, K8). */
const PERSON_FIELDS: ReadonlySet<string> = new Set([
  "author-name",
  "author-initials",
  "initial-creator",
  "creator",
]);
/** Text elements whose content is never document text. */
const SKIPPED_TEXT: ReadonlySet<string> = new Set([
  "note",
  "tracked-changes",
  "change",
  "change-start",
  "change-end",
  "bookmark",
  "bookmark-start",
  "bookmark-end",
  "reference-mark",
  "reference-mark-start",
  "reference-mark-end",
  "soft-page-break",
  "sequence-decls",
  "variable-decls",
  "user-field-decls",
]);
/** A text:s with a larger count is read as this many spaces (L2 guard). */
const MAX_SPACES = 1024;

type Run = { text: string; marks: Mark[] };
type Styles = { readonly marks: Map<string, Mark[]>; readonly quote: Set<string> };
type Context = {
  readonly styles: Styles;
  readonly traces: { comment: number; deletion: number; insertion: number };
  readonly blocks: DocumentNodeV2[];
  readonly uuid: (() => string) | undefined;
  /** UTF-16 units of text read so far; never fewer than its UTF-8 bytes would need. */
  chars: number;
};

/** Thrown when the text grows past one segment (L2). */
export class ContentTooLarge extends Error {}

const is = (element: XmlElement, ns: string, local: string) =>
  element.ns === ns && element.local === local;
const childOf = (element: XmlElement, ns: string, local: string) =>
  elementsOf(element).find((child) => is(child, ns, local));

function readStyles(root: XmlElement): Styles {
  const marks = new Map<string, Mark[]>();
  const quote = new Set<string>(["Quotations"]);
  const automatic = childOf(root, OFFICE_NS, "automatic-styles");
  if (automatic === undefined) return { marks, quote };
  for (const style of elementsOf(automatic)) {
    if (!is(style, STYLE_NS, "style")) continue;
    const name = attributeOf(style, STYLE_NS, "name");
    if (name === undefined) continue;
    const family = attributeOf(style, STYLE_NS, "family");
    const parent = attributeOf(style, STYLE_NS, "parent-style-name");
    if (family === "paragraph" && parent === "Quotations") quote.add(name);
    const props = childOf(style, STYLE_NS, "text-properties");
    if (family !== "text" || props === undefined) continue;
    const found: Mark[] = [];
    if (attributeOf(props, FO_NS, "font-weight") === "bold") found.push("bold");
    if (attributeOf(props, FO_NS, "font-style") === "italic") found.push("italic");
    if (found.length > 0) marks.set(name, found);
  }
  return { marks, quote };
}

function addText(context: Context, runs: Run[], text: string, marks: Mark[]): void {
  if (text === "") return;
  context.chars += text.length;
  if (context.chars > MAX_EVIDENCE_SEGMENT_BYTES) throw new ContentTooLarge();
  runs.push({ text, marks });
}

function collectRuns(element: XmlElement, context: Context, runs: Run[], marks: Mark[]): void {
  for (const child of element.children) {
    if (typeof child === "string") {
      // ODF white space (§6.1.2): a run of spaces, tabs and line breaks in the
      // XML is one space, and none at the start of a paragraph; text:s, text:tab
      // and text:line-break are the written ones.
      const collapsed = child.replace(/[ \t\r\n]+/g, " ");
      addText(context, runs, runs.length === 0 ? collapsed.replace(/^ /, "") : collapsed, marks);
      continue;
    }
    if (is(child, OFFICE_NS, "annotation")) {
      context.traces.comment += 1;
      continue;
    }
    if (child.ns !== TEXT_NS) continue;
    const local = child.local;
    if (SKIPPED_TEXT.has(local) || PERSON_FIELDS.has(local) || local.startsWith("sender-")) {
      continue;
    }
    if (local === "s") {
      const count = Number(attributeOf(child, TEXT_NS, "c") ?? "1");
      const spaces = Number.isSafeInteger(count) && count >= 1 ? Math.min(count, MAX_SPACES) : 1;
      addText(context, runs, " ".repeat(spaces), marks);
    } else if (local === "tab" || local === "line-break") {
      addText(context, runs, " ", marks);
    } else if (local === "span") {
      const own = context.styles.marks.get(attributeOf(child, TEXT_NS, "style-name") ?? "") ?? [];
      collectRuns(child, context, runs, canonicalMarks([...marks, ...own]));
    } else {
      // text:a keeps its text and never its target (K6); a field keeps its shown value.
      collectRuns(child, context, runs, marks);
    }
  }
}

function inlineOf(runs: readonly Run[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const run of runs) {
    const text = cleanText(run.text);
    if (text === "") continue;
    const last = nodes.at(-1);
    if (last !== undefined && last.marks.join() === run.marks.join()) {
      nodes[nodes.length - 1] = { ...last, text: (last.text + text).normalize("NFC") };
    } else {
      nodes.push({ type: "text", text, marks: [...run.marks] });
    }
  }
  return nodes;
}

function readParagraph(paragraph: XmlElement, context: Context, inList: boolean): void {
  const runs: Run[] = [];
  collectRuns(paragraph, context, runs, []);
  const children = inlineOf(runs);
  const id = newNodeId(context.uuid);
  const style = attributeOf(paragraph, TEXT_NS, "style-name") ?? "";
  if (paragraph.local === "h" && children.length > 0) {
    const level = Number(attributeOf(paragraph, TEXT_NS, "outline-level") ?? "1");
    const clamped = (
      Number.isSafeInteger(level) && level >= 1 ? Math.min(level, 3) : 1
    ) as HeadingLevel;
    context.blocks.push({ type: "heading", id, level: clamped, children });
  } else if (inList && children.length > 0) {
    context.blocks.push({ type: "bulletItem", id, children });
  } else if (context.styles.quote.has(style) && children.length > 0) {
    context.blocks.push({ type: "quote", id, children });
  } else {
    context.blocks.push({ type: "paragraph", id, children });
  }
}

const TABLE_PARTS: ReadonlySet<string> = new Set([
  "table",
  "table-row",
  "table-rows",
  "table-header-rows",
  "table-row-group",
  "table-cell",
]);

function readBlocks(container: XmlElement, context: Context, inList: boolean): void {
  for (const child of elementsOf(container)) {
    if (child.ns === TEXT_NS) {
      if (child.local === "p" || child.local === "h") readParagraph(child, context, inList);
      else if (
        child.local === "list" ||
        child.local === "list-item" ||
        child.local === "list-header"
      )
        readBlocks(child, context, true);
      else if (child.local === "section" || child.local === "index-body")
        readBlocks(child, context, inList);
      else if (child.local === "table-of-content") {
        const body = childOf(child, TEXT_NS, "index-body");
        if (body !== undefined) readBlocks(body, context, inList);
      } else if (child.local === "tracked-changes") countChanges(child, context);
    } else if (child.ns === TABLE_NS && TABLE_PARTS.has(child.local)) {
      readBlocks(child, context, inList);
    } else if (is(child, OFFICE_NS, "annotation")) {
      context.traces.comment += 1;
    }
  }
}

/** Each changed region is one deletion or one insertion; a format change is neither. */
function countChanges(tracked: XmlElement, context: Context): void {
  for (const region of elementsOf(tracked)) {
    if (!is(region, TEXT_NS, "changed-region")) continue;
    if (childOf(region, TEXT_NS, "deletion") !== undefined) context.traces.deletion += 1;
    else if (childOf(region, TEXT_NS, "insertion") !== undefined) context.traces.insertion += 1;
  }
}

export type Converted = {
  readonly nodes: DocumentNodeV2[];
  readonly traces: ImportTraceV1[];
};

/** null when content.xml is not the content of a text document. */
export function convertContent(root: XmlElement, uuid?: () => string): Converted | null {
  if (!is(root, OFFICE_NS, "document-content")) return null;
  const body = childOf(root, OFFICE_NS, "body");
  const text = body === undefined ? undefined : childOf(body, OFFICE_NS, "text");
  if (text === undefined) return null;
  const context: Context = {
    styles: readStyles(root),
    traces: { comment: 0, deletion: 0, insertion: 0 },
    blocks: [],
    uuid,
    chars: 0,
  };
  readBlocks(text, context, false);
  if (context.blocks.length === 0) {
    context.blocks.push({ type: "paragraph", id: newNodeId(uuid), children: [] });
  }
  const counts: [ImportTraceV1["traceKind"], number][] = [
    ["comment", context.traces.comment],
    ["deletion", context.traces.deletion],
    ["insertion", context.traces.insertion],
  ];
  return {
    nodes: context.blocks,
    traces: counts
      .filter(([, count]) => count > 0)
      .map(([traceKind, count]) => ({ traceKind, count })),
  };
}
