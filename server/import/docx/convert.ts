// The main part of a DOCX as a Ductura document v2 (SRV-1803, M8.2; ADR
// docs/adr/import-contract.md §2 and attack rows K6 to K8). Only the current
// text is taken: paragraphs, heading levels 1 to 3, list items, quotes, bold
// and italic. Tables are read cell by cell as paragraphs. Deleted text of a
// tracked change, field instructions (INCLUDETEXT, INCLUDEPICTURE, DDE ...),
// drawings, text boxes and alternate content are left out; a field keeps only
// its stored result and nothing is ever run (K7). A hyperlink keeps its text,
// its target never enters the content (K6). Author, date and rsid of a change
// or comment are never read into the content (K8); the traces only count
// insertions, deletions and comments. Text is NFC, without the FORBIDDEN code
// points of document v2, a control character becoming a space.
import {
  canonicalMarks,
  isForbiddenCodePoint,
  newNodeId,
  type DocumentNodeV2,
  type HeadingLevel,
  type InlineNode,
  type Mark,
} from "../../domain/index.ts";
import type { ImportTraceV1 } from "../../contracts/index.ts";

import { attributeOf, elementsOf, type XmlElement } from "./xml.ts";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

type BlockKind =
  | { kind: "paragraph" }
  | { kind: "heading"; level: HeadingLevel }
  | { kind: "bulletItem" }
  | { kind: "quote" };
type Run = { text: string; marks: Mark[] };
type StyleInfo = {
  name: string;
  basedOn: string | undefined;
  outline: number | undefined;
  list: boolean;
};

const isW = (element: XmlElement, local: string) => element.ns === W_NS && element.local === local;
const childW = (element: XmlElement, local: string) =>
  elementsOf(element).find((child) => isW(child, local));
const valOf = (element: XmlElement | undefined) =>
  element === undefined ? undefined : attributeOf(element, W_NS, "val");

/** A w:b or w:i toggle: present without a value, or with a true value. */
function toggle(element: XmlElement | undefined): boolean {
  if (element === undefined) return false;
  const value = valOf(element);
  return value === undefined || ["1", "true", "on"].includes(value.toLowerCase());
}

function outlineLevel(pPr: XmlElement | undefined): number | undefined {
  const value = valOf(pPr === undefined ? undefined : childW(pPr, "outlineLvl"));
  if (value === undefined || !/^[0-9]$/u.test(value)) return undefined;
  return Number(value);
}

function hasList(pPr: XmlElement | undefined): boolean {
  const numPr = pPr === undefined ? undefined : childW(pPr, "numPr");
  if (numPr === undefined) return false;
  return valOf(childW(numPr, "numId")) !== "0";
}

function readStyles(styles: XmlElement | null): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  if (styles === null || !isW(styles, "styles")) return map;
  for (const style of elementsOf(styles)) {
    if (!isW(style, "style") || attributeOf(style, W_NS, "type") !== "paragraph") continue;
    const id = attributeOf(style, W_NS, "styleId");
    if (id === undefined) continue;
    const pPr = childW(style, "pPr");
    map.set(id, {
      name: (valOf(childW(style, "name")) ?? "").toLowerCase(),
      basedOn: valOf(childW(style, "basedOn")),
      outline: outlineLevel(pPr),
      list: hasList(pPr),
    });
  }
  return map;
}

const HEADING_NAME = /^(?:heading|naslov) ?([1-9])$/u;
const QUOTE_NAME = /^(?:quote|intense quote|citat|istaknuti citat)$/u;

/** The kind of a paragraph style, along its basedOn chain (at most 20 steps, no cycle). */
function styleKind(
  styles: Map<string, StyleInfo>,
  styleId: string | undefined,
): {
  outline?: number;
  quote: boolean;
  list: boolean;
} {
  const result: { outline?: number; quote: boolean; list: boolean } = { quote: false, list: false };
  const seen = new Set<string>();
  let id = styleId;
  for (let step = 0; id !== undefined && step < 20 && !seen.has(id); step += 1) {
    seen.add(id);
    const style = styles.get(id);
    const name = style?.name ?? id.toLowerCase();
    const heading = HEADING_NAME.exec(name);
    if (result.outline === undefined && heading !== null) result.outline = Number(heading[1]) - 1;
    if (result.outline === undefined && style?.outline !== undefined)
      result.outline = style.outline;
    if (QUOTE_NAME.test(name)) result.quote = true;
    if (style?.list === true) result.list = true;
    id = style?.basedOn;
  }
  return result;
}

/** Text as document v2 takes it: control characters become a space, FORBIDDEN code points go, NFC. */
export function cleanText(text: string): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) out += " ";
    else if (!isForbiddenCodePoint(codePoint)) out += char;
  }
  return out.normalize("NFC");
}

type Context = {
  readonly styles: Map<string, StyleInfo>;
  /** Open fields: true while in the instruction part (begin to separate). */
  readonly fields: boolean[];
  readonly traces: { insertion: number; deletion: number };
  readonly blocks: DocumentNodeV2[];
  readonly uuid: (() => string) | undefined;
};

function collectRuns(element: XmlElement, context: Context, runs: Run[]): void {
  for (const child of elementsOf(element)) {
    if (child.ns !== W_NS) continue;
    switch (child.local) {
      case "r":
        readRun(child, context, runs);
        break;
      case "ins":
        context.traces.insertion += 1;
        collectRuns(child, context, runs);
        break;
      case "del":
        context.traces.deletion += 1;
        break;
      case "hyperlink":
      case "smartTag":
      case "customXml":
      case "fldSimple":
      case "moveTo":
      case "dir":
      case "bdo":
        collectRuns(child, context, runs);
        break;
      case "sdt": {
        const content = childW(child, "sdtContent");
        if (content !== undefined) collectRuns(content, context, runs);
        break;
      }
      default:
        break;
    }
  }
}

function readRun(run: XmlElement, context: Context, runs: Run[]): void {
  const rPr = childW(run, "rPr");
  const marks: Mark[] = [];
  if (rPr !== undefined) {
    if (toggle(childW(rPr, "b"))) marks.push("bold");
    if (toggle(childW(rPr, "i"))) marks.push("italic");
    // A run whose mark is a tracked insertion counts once, like w:ins.
    if (childW(rPr, "ins") !== undefined) context.traces.insertion += 1;
    if (childW(rPr, "del") !== undefined) context.traces.deletion += 1;
  }
  const inInstruction = () => context.fields.includes(true);
  let text = "";
  for (const child of elementsOf(run)) {
    if (child.ns !== W_NS) continue;
    switch (child.local) {
      case "fldChar": {
        const type = attributeOf(child, W_NS, "fldCharType");
        if (type === "begin") context.fields.push(true);
        else if (type === "separate" && context.fields.length > 0)
          context.fields[context.fields.length - 1] = false;
        else if (type === "end") context.fields.pop();
        break;
      }
      case "t":
        if (!inInstruction()) {
          text += child.children.filter((c): c is string => typeof c === "string").join("");
        }
        break;
      case "tab":
      case "br":
      case "cr":
        if (!inInstruction()) text += " ";
        break;
      case "noBreakHyphen":
        if (!inInstruction()) text += "-";
        break;
      default:
        break;
    }
  }
  if (text !== "") runs.push({ text, marks: canonicalMarks(marks) });
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

function blockKind(paragraph: XmlElement, styles: Map<string, StyleInfo>): BlockKind {
  const pPr = childW(paragraph, "pPr");
  const style = styleKind(styles, valOf(pPr === undefined ? undefined : childW(pPr, "pStyle")));
  const outline = outlineLevel(pPr) ?? style.outline;
  if (outline !== undefined && outline <= 8) {
    return { kind: "heading", level: Math.min(outline + 1, 3) as HeadingLevel };
  }
  if (style.quote) return { kind: "quote" };
  if (hasList(pPr) || style.list) return { kind: "bulletItem" };
  return { kind: "paragraph" };
}

function readParagraph(paragraph: XmlElement, context: Context): void {
  const runs: Run[] = [];
  collectRuns(paragraph, context, runs);
  const children = inlineOf(runs);
  const kind = blockKind(paragraph, context.styles);
  const id = newNodeId(context.uuid);
  // An empty heading or list item says nothing; an empty paragraph keeps the spacing.
  if (children.length === 0 && kind.kind !== "paragraph") {
    context.blocks.push({ type: "paragraph", id, children });
    return;
  }
  if (kind.kind === "heading") {
    context.blocks.push({ type: "heading", id, level: kind.level, children });
  } else {
    context.blocks.push({ type: kind.kind, id, children });
  }
}

function readBlocks(container: XmlElement, context: Context): void {
  for (const child of elementsOf(container)) {
    if (child.ns !== W_NS) continue;
    if (child.local === "p") readParagraph(child, context);
    else if (child.local === "tbl" || child.local === "tr" || child.local === "tc")
      readBlocks(child, context);
    else if (child.local === "sdt") {
      const content = childW(child, "sdtContent");
      if (content !== undefined) readBlocks(content, context);
    } else if (child.local === "customXml") readBlocks(child, context);
    else if (child.local === "ins") {
      context.traces.insertion += 1;
      readBlocks(child, context);
    } else if (child.local === "del") context.traces.deletion += 1;
  }
}

export type Converted = {
  readonly nodes: DocumentNodeV2[];
  readonly traces: ImportTraceV1[];
};

/** null when the main part is not a WordprocessingML document (Strict OOXML included). */
export function convertDocument(
  parts: { document: XmlElement; styles: XmlElement | null; comments: XmlElement | null },
  uuid?: () => string,
): Converted | null {
  const { document } = parts;
  if (!isW(document, "document")) return null;
  const body = childW(document, "body");
  if (body === undefined) return null;
  const context: Context = {
    styles: readStyles(parts.styles),
    fields: [],
    traces: { insertion: 0, deletion: 0 },
    blocks: [],
    uuid,
  };
  readBlocks(body, context);
  if (context.blocks.length === 0) {
    context.blocks.push({ type: "paragraph", id: newNodeId(uuid), children: [] });
  }
  const comments =
    parts.comments !== null && isW(parts.comments, "comments")
      ? elementsOf(parts.comments).filter((c) => isW(c, "comment")).length
      : 0;
  const counts: [ImportTraceV1["traceKind"], number][] = [
    ["comment", comments],
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
