// Pure projection of a document v4 into the blocks an export prints
// (docs/contracts/document-schema-v4.md §8: numbers are derived, never stored).
import type {
  BoxKind,
  CanonicalDocumentV4,
  CodeLanguage,
  HeadingLevel,
  ImageCrop,
  InlineNodeV4,
  MarkV4,
  TableCellFill,
  TableMerge,
} from "../../domain/index.ts";

/** Words printed by the export; the caller takes them from the message catalogue. */
export type ExportLabels = {
  readonly listing: string;
  readonly boxes: Readonly<Record<BoxKind, string>>;
  readonly table: string;
  readonly image: string;
  /** Printed before the source line under a table or an image. */
  readonly source: string;
  /** Printed in place of an image whose attachment is missing or does not match its hash. */
  readonly imageUnavailable: string;
};

export type ExportRun = {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly superscript: boolean;
  readonly subscript: boolean;
  readonly highlight?: string;
  readonly language?: string;
  readonly href?: string;
};

export type ExportBlock =
  | {
      readonly kind: "heading";
      readonly level: HeadingLevel;
      readonly number: string;
      readonly runs: readonly ExportRun[];
    }
  | { readonly kind: "paragraph" | "bullet" | "quote"; readonly runs: readonly ExportRun[] }
  | { readonly kind: "ordered"; readonly number: number; readonly runs: readonly ExportRun[] }
  | {
      readonly kind: "code";
      readonly lines: readonly string[];
      readonly language?: CodeLanguage;
      readonly caption: string;
    }
  | {
      readonly kind: "box";
      readonly label: string;
      readonly paragraphs: readonly (readonly ExportRun[])[];
    }
  | { readonly kind: "formula"; readonly tex: string; readonly number: number }
  | {
      readonly kind: "table";
      readonly caption: string;
      readonly rows: readonly (readonly string[])[];
      readonly header: boolean;
      readonly stripes: boolean;
      readonly landscape: boolean;
      readonly headerFill?: string;
      readonly cellFills: readonly TableCellFill[];
      readonly merges: readonly TableMerge[];
      readonly source?: string;
    }
  | {
      readonly kind: "image";
      readonly caption: string;
      readonly attachmentId?: string;
      readonly attachmentSha256?: string;
      readonly crop?: ImageCrop;
      readonly widthPercent: number;
      readonly align: "left" | "center" | "right";
      readonly landscape: boolean;
      readonly unavailable: string;
      readonly source?: string;
    }
  | { readonly kind: "pageBreak" };

export type ExportModel = {
  /** Text of the first level 1 heading, or "". */
  readonly title: string;
  readonly blocks: readonly ExportBlock[];
};

function hasType(mark: MarkV4, type: string): boolean {
  return typeof mark === "string" ? mark === type : mark.type === type;
}

function runOf(text: string, marks: readonly MarkV4[]): ExportRun {
  const highlight = marks.find((m) => typeof m !== "string" && m.type === "highlight");
  const lang = marks.find((m) => typeof m !== "string" && m.type === "lang");
  const link = marks.find((m) => typeof m !== "string" && m.type === "link");
  return {
    text,
    bold: marks.some((m) => hasType(m, "bold")),
    italic: marks.some((m) => hasType(m, "italic")),
    superscript: marks.some((m) => hasType(m, "sup")),
    subscript: marks.some((m) => hasType(m, "sub")),
    ...(highlight && "color" in highlight ? { highlight: highlight.color } : {}),
    ...(lang && "lang" in lang ? { language: lang.lang } : {}),
    ...(link && "href" in link ? { href: link.href } : {}),
  };
}

/** Citations, footnotes and cross references are resolved by later export steps (open item). */
function runsOf(children: readonly InlineNodeV4[]): ExportRun[] {
  const runs: ExportRun[] = [];
  for (const child of children) {
    if (child.type === "text") runs.push(runOf(child.text, child.marks));
    else if (child.type === "inlineFormula") runs.push(runOf(child.tex, []));
  }
  return runs;
}

/** "Tablica 2. Naslov": the number is derived by order of appearance, per kind (§8). */
const captionOf = (label: string, n: number, title: string | undefined): string =>
  `${label} ${n}.${title ? ` ${title}` : ""}`;

export function buildExportModel(doc: CanonicalDocumentV4, labels: ExportLabels): ExportModel {
  const counters = [0, 0, 0];
  const boxCounts = new Map<BoxKind, number>();
  let formulas = 0;
  let listings = 0;
  let tables = 0;
  let images = 0;
  // Position in the current run of consecutive numbered-list items (v4 §2).
  let orderedRun = 0;
  let title = "";
  let titleSeen = false;
  const blocks: ExportBlock[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "orderedItem") orderedRun = 0;
    switch (node.type) {
      case "heading": {
        counters[node.level - 1] = (counters[node.level - 1] ?? 0) + 1;
        for (let i = node.level; i < 3; i += 1) counters[i] = 0;
        const runs = runsOf(node.children);
        if (node.level === 1 && !titleSeen) {
          titleSeen = true;
          title = runs.map((r) => r.text).join("");
        }
        blocks.push({
          kind: "heading",
          level: node.level,
          number: counters.slice(0, node.level).join("."),
          runs,
        });
        break;
      }
      case "paragraph":
        blocks.push({ kind: "paragraph", runs: runsOf(node.children) });
        break;
      case "bulletItem":
        blocks.push({ kind: "bullet", runs: runsOf(node.children) });
        break;
      case "orderedItem":
        orderedRun += 1;
        blocks.push({ kind: "ordered", number: orderedRun, runs: runsOf(node.children) });
        break;
      case "quote":
        blocks.push({ kind: "quote", runs: runsOf(node.children) });
        break;
      case "codeBlock": {
        listings += 1;
        const caption = `${labels.listing} ${listings}.${node.caption ? ` ${node.caption}` : ""}`;
        const lines = node.children
          .map((c) => c.text)
          .join("")
          .split("\n");
        blocks.push({
          kind: "code",
          lines,
          ...(node.language ? { language: node.language } : {}),
          caption,
        });
        break;
      }
      case "box": {
        const count = (boxCounts.get(node.kind) ?? 0) + 1;
        if (node.kind !== "proof") boxCounts.set(node.kind, count);
        const label =
          node.kind === "proof" ? labels.boxes.proof : `${labels.boxes[node.kind]} ${count}.`;
        blocks.push({
          kind: "box",
          label,
          paragraphs: node.children.map((p) => runsOf(p.children)),
        });
        break;
      }
      case "formula":
        formulas += 1;
        blocks.push({ kind: "formula", tex: node.tex, number: formulas });
        break;
      case "table": {
        tables += 1;
        blocks.push({
          kind: "table",
          caption: captionOf(labels.table, tables, node.title),
          rows: node.rows,
          header: node.header,
          stripes: node.stripes,
          landscape: node.landscape,
          ...(node.headerFill ? { headerFill: node.headerFill } : {}),
          cellFills: node.cellFills ?? [],
          merges: node.merges ?? [],
          ...(node.source ? { source: `${labels.source} ${node.source}` } : {}),
        });
        break;
      }
      case "image": {
        images += 1;
        blocks.push({
          kind: "image",
          caption: captionOf(labels.image, images, node.title),
          ...(node.attachmentId ? { attachmentId: node.attachmentId } : {}),
          ...(node.attachmentSha256 ? { attachmentSha256: node.attachmentSha256 } : {}),
          ...(node.crop ? { crop: node.crop } : {}),
          widthPercent: node.widthPercent,
          align: node.align,
          landscape: node.landscape,
          unavailable: labels.imageUnavailable,
          ...(node.source ? { source: `${labels.source} ${node.source}` } : {}),
        });
        break;
      }
      case "pageBreak":
        blocks.push({ kind: "pageBreak" });
        break;
    }
  }
  return { title, blocks };
}
