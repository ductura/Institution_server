// .pptx writer for a frozen slides snapshot (SRV-V13-IZVOZ-PPTX, val 13): an
// OOXML package (presentation, master, four layouts, slides, speaker notes,
// images) written through the deterministic ZIP of `writeZip`, so the same
// snapshot and the same image bytes give the same bytes. Images are read only
// when their SHA-256 equals the one bound in the document; a missing,
// replaced or unreadable image stops the export instead of printing a gap.
// Pure: no I/O, no clock, no network.
import { createHash } from "node:crypto";

import {
  SLIDE_LAYOUTS,
  verifySlidesSnapshot,
  type SlideLayout,
  type SlideSlot,
  type SlidesDocument,
} from "../../domain/index.ts";
import { xmlEscape } from "./docx.ts";
import {
  buildSlidesExportModel,
  type SlidesExportBlock,
  type SlidesExportLabels,
  type SlidesExportSlide,
} from "./slides-model.ts";
import { writeZip, type ZipEntry } from "./zip.ts";

export type SlidesPptxInput = {
  /** The exact JCS bytes of the frozen slides snapshot (docs/contracts/slides-v1.md §4). */
  readonly snapshot: Uint8Array;
  /** Stored image bytes by attachment id; each is checked against the SHA-256 in the document. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  readonly labels: SlidesExportLabels;
};

export type SlidesPptx =
  | { readonly status: "rendered"; readonly bytes: Uint8Array; readonly snapshotSha256: string }
  /** The snapshot is not a slides document the export reads. */
  | { readonly status: "unreadable"; readonly reason: "snapshot_too_large" | "snapshot_invalid" }
  /** An image the document binds cannot be printed; the reason is a closed code. */
  | {
      readonly status: "image_problem";
      readonly reason: "image_missing" | "image_hash_mismatch" | "image_unsupported";
      readonly attachmentId: string;
    };

// EMU: 16:9 slide of 13.333 x 7.5 inches.
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
const MARGIN = 609600;
const FULL_W = SLIDE_W - 2 * MARGIN;
const TITLE_BOX: Box = { x: MARGIN, y: 457200, w: FULL_W, h: 1143000 };
const CONTENT_Y = 1828800;
const CONTENT_H = 4572000;
const COLUMN_W = 5334000;
const BOXES: Readonly<Record<SlideSlot, Readonly<Record<SlideLayout, Box | undefined>>>> = {
  title: {
    title: { x: 1524000, y: 2130000, w: 9144000, h: 1470000 },
    titleContent: TITLE_BOX,
    twoColumns: TITLE_BOX,
    imageOnly: undefined,
  },
  subtitle: {
    title: { x: 1524000, y: 3770000, w: 9144000, h: 1400000 },
    titleContent: undefined,
    twoColumns: undefined,
    imageOnly: undefined,
  },
  body: {
    title: undefined,
    titleContent: { x: MARGIN, y: CONTENT_Y, w: FULL_W, h: CONTENT_H },
    twoColumns: undefined,
    imageOnly: undefined,
  },
  left: {
    title: undefined,
    titleContent: undefined,
    twoColumns: { x: MARGIN, y: CONTENT_Y, w: COLUMN_W, h: CONTENT_H },
    imageOnly: undefined,
  },
  right: {
    title: undefined,
    titleContent: undefined,
    twoColumns: { x: SLIDE_W - MARGIN - COLUMN_W, y: CONTENT_Y, w: COLUMN_W, h: CONTENT_H },
    imageOnly: undefined,
  },
  image: {
    title: undefined,
    titleContent: undefined,
    twoColumns: undefined,
    imageOnly: { x: MARGIN, y: 457200, w: FULL_W, h: 5943600 },
  },
};

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument.presentationml";

type Rel = { readonly id: string; readonly type: string; readonly target: string };
const rels = (items: readonly Rel[]): string =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map((r) => `<Relationship Id="${r.id}" Type="${REL_TYPE}/${r.type}" Target="${r.target}"/>`)
    .join("")}</Relationships>`;

// ---- images ---------------------------------------------------------------

type ImageInfo = { readonly ext: "png" | "jpeg"; readonly width: number; readonly height: number };

/** PNG and JPEG with their pixel size, read from the header; anything else is unsupported. */
function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 24 && png.every((b, i) => bytes[i] === b)) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { ext: "png", width, height } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = view.getUint16(at + 5);
        const width = view.getUint16(at + 7);
        return width > 0 && height > 0 ? { ext: "jpeg", width, height } : null;
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
}

type Media = { readonly name: string; readonly info: ImageInfo; readonly bytes: Uint8Array };

// ---- slide shapes ----------------------------------------------------------

const xfrm = (box: Box): string =>
  `<a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>`;

/** A line feed is a break; the validator allows no other control character. */
function textRuns(text: string, props: string): string {
  return text
    .split("\n")
    .map((line) => `<a:r><a:rPr ${props}/><a:t>${xmlEscape(line)}</a:t></a:r>`)
    .join("<a:br/>");
}

const TITLE_SIZE: Readonly<Record<SlideLayout, number>> = {
  title: 4400,
  titleContent: 3600,
  twoColumns: 3600,
  imageOnly: 3600,
};

function paragraphs(blocks: readonly SlidesExportBlock[], slot: SlideSlot, layout: SlideLayout) {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      const size = slot === "title" ? TITLE_SIZE[layout] : 2800;
      const algn = slot === "title" && layout === "title" ? ' algn="ctr"' : "";
      out.push(
        `<a:p><a:pPr${algn}><a:buNone/></a:pPr>${textRuns(block.text, `lang="" sz="${size}" b="1"`)}</a:p>`,
      );
    } else if (block.type === "paragraph") {
      const algn = slot === "subtitle" ? ' algn="ctr"' : "";
      const size = slot === "subtitle" ? 2800 : 2400;
      out.push(
        `<a:p><a:pPr marL="0" indent="0"${algn}><a:buNone/></a:pPr>${textRuns(block.text, `lang="" sz="${size}"`)}</a:p>`,
      );
    } else if (block.type === "list") {
      for (const item of block.items) {
        out.push(
          `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>${textRuns(item, 'lang="" sz="2400"')}</a:p>`,
        );
      }
    }
  }
  return out.join("");
}

function placeholder(slot: SlideSlot, layout: SlideLayout): string {
  if (slot === "title")
    return layout === "title" ? '<p:ph type="ctrTitle"/>' : '<p:ph type="title"/>';
  if (slot === "subtitle") return '<p:ph type="subTitle" idx="1"/>';
  return slot === "right" ? '<p:ph idx="2"/>' : '<p:ph idx="1"/>';
}

type Context = {
  nextId: number;
  readonly imageRels: Map<string, string>;
  readonly media: ReadonlyMap<string, Media>;
};

function textShape(
  ctx: Context,
  slot: SlideSlot,
  layout: SlideLayout,
  box: Box,
  blocks: readonly SlidesExportBlock[],
): string {
  const id = ctx.nextId++;
  const anchor = slot === "title" || slot === "subtitle" ? "ctr" : "t";
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${slot} ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${placeholder(slot, layout)}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}</p:spPr><p:txBody><a:bodyPr anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(blocks, slot, layout)}</p:txBody></p:sp>`
  );
}

function pictureShape(
  ctx: Context,
  block: Extract<SlidesExportBlock, { type: "image" }>,
  box: Box,
): string {
  const media = ctx.media.get(block.attachmentSha256);
  if (media === undefined) throw new Error("image without media");
  let relId = ctx.imageRels.get(media.name);
  if (relId === undefined) {
    relId = `rIdI${ctx.imageRels.size + 1}`;
    ctx.imageRels.set(media.name, relId);
  }
  // Fit inside the box, keep the aspect ratio, centre.
  const scaleW = box.w * media.info.height;
  const scaleH = box.h * media.info.width;
  const w = scaleW <= scaleH ? box.w : Math.floor(scaleH / media.info.height);
  const h = scaleW <= scaleH ? Math.floor(scaleW / media.info.width) : box.h;
  const at: Box = {
    x: box.x + Math.floor((box.w - w) / 2),
    y: box.y + Math.floor((box.h - h) / 2),
    w,
    h,
  };
  const id = ctx.nextId++;
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="image ${id}" descr="${xmlEscape(block.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(at)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** A slot's blocks in order: consecutive text blocks share one shape, each image has its own band. */
function slotShapes(
  ctx: Context,
  slide: SlidesExportSlide,
  slot: SlideSlot,
  blocks: readonly SlidesExportBlock[],
): string {
  const box = BOXES[slot][slide.layout];
  if (box === undefined || blocks.length === 0) return "";
  if (slot === "image") {
    const only = blocks[0];
    return only?.type === "image" ? pictureShape(ctx, only, box) : "";
  }
  const groups: SlidesExportBlock[][] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (block.type !== "image" && last !== undefined && last[0]?.type !== "image") last.push(block);
    else groups.push([block]);
  }
  const band = Math.floor(box.h / groups.length);
  return groups
    .map((group, index) => {
      const part: Box = { ...box, y: box.y + index * band, h: band };
      const first = group[0];
      return first?.type === "image"
        ? pictureShape(ctx, first, part)
        : textShape(ctx, slot, slide.layout, part, group);
    })
    .join("");
}

const SP_TREE_ROOT =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function slideXml(ctx: Context, slide: SlidesExportSlide): string {
  ctx.nextId = 2;
  const shapes = slide.regions.map((r) => slotShapes(ctx, slide, r.slot, r.blocks)).join("");
  return `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${SP_TREE_ROOT}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesXml(notes: string): string {
  const body = notes
    .split("\n")
    .map((line) =>
      line === ""
        ? "<a:p><a:endParaRPr/></a:p>"
        : `<a:p><a:r><a:rPr lang=""/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`,
    )
    .join("");
  return (
    `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${SP_TREE_ROOT}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="slide image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>` +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
  );
}

// ---- master, layouts, theme -------------------------------------------------

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

const THEME = (name: string): string =>
  `${HEAD}<a:theme xmlns:a="${NS_A}" name="${name}"><a:themeElements>` +
  '<a:clrScheme name="Ductura"><a:dk1><a:srgbClr val="1F1F1F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="3A3A3A"/></a:dk2><a:lt2><a:srgbClr val="F4F4F2"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="B08D3C"/></a:accent1><a:accent2><a:srgbClr val="5A5A5A"/></a:accent2><a:accent3><a:srgbClr val="8A8A8A"/></a:accent3><a:accent4><a:srgbClr val="6E5A24"/></a:accent4><a:accent5><a:srgbClr val="A0A0A0"/></a:accent5><a:accent6><a:srgbClr val="2E2E2E"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="6E5A24"/></a:hlink><a:folHlink><a:srgbClr val="5A5A5A"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Ductura"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Ductura"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  "</a:themeElements></a:theme>";

function phShape(id: number, name: string, ph: string, box: Box | null): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${box === null ? "" : xfrm(box)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=""/></a:p></p:txBody></p:sp>`
  );
}

const MASTER_TEXT = (size: number, bold: boolean): string =>
  `<a:lvl1pPr algn="l"><a:defRPr sz="${size}"${bold ? ' b="1"' : ""}><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`;

function masterXml(): string {
  const shapes =
    phShape(2, "title", '<p:ph type="title"/>', TITLE_BOX) +
    phShape(3, "body", '<p:ph type="body" idx="1"/>', {
      x: MARGIN,
      y: CONTENT_Y,
      w: FULL_W,
      h: CONTENT_H,
    });
  const layoutIds = SLIDE_LAYOUTS.map(
    (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`,
  ).join("");
  return (
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_ROOT}${shapes}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst>${layoutIds}</p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle>${MASTER_TEXT(3600, true)}</p:titleStyle><p:bodyStyle>${MASTER_TEXT(2400, false)}</p:bodyStyle><p:otherStyle>${MASTER_TEXT(1800, false)}</p:otherStyle></p:txStyles></p:sldMaster>`
  );
}

const LAYOUT_TYPE: Readonly<Record<SlideLayout, string>> = {
  title: "title",
  titleContent: "obj",
  twoColumns: "twoObj",
  imageOnly: "blank",
};

function layoutXml(layout: SlideLayout): string {
  const parts: string[] = [];
  let id = 2;
  const add = (slot: SlideSlot, ph: string, name: string) => {
    const box = BOXES[slot][layout];
    if (box !== undefined) parts.push(phShape(id++, name, ph, box));
  };
  add("title", layout === "title" ? '<p:ph type="ctrTitle"/>' : '<p:ph type="title"/>', "title");
  add("subtitle", '<p:ph type="subTitle" idx="1"/>', "subtitle");
  add("body", '<p:ph idx="1"/>', "body");
  add("left", '<p:ph idx="1"/>', "left");
  add("right", '<p:ph idx="2"/>', "right");
  return `${HEAD}<p:sldLayout ${NS} type="${LAYOUT_TYPE[layout]}"><p:cSld name="${layout}"><p:spTree>${SP_TREE_ROOT}${parts.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function notesMasterXml(): string {
  return (
    `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_ROOT}` +
    phShape(2, "slide image", '<p:ph type="sldImg"/>', {
      x: 685800,
      y: 1143000,
      w: 5486400,
      h: 3086100,
    }) +
    phShape(3, "notes", '<p:ph type="body" sz="quarter" idx="1"/>', {
      x: 685800,
      y: 4400550,
      w: 5486400,
      h: 3600450,
    }) +
    `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle>${MASTER_TEXT(1200, false)}</p:notesStyle></p:notesMaster>`
  );
}

// ---- package -----------------------------------------------------------------

export function renderSlidesPptx(input: SlidesPptxInput): SlidesPptx {
  const checked = verifySlidesSnapshot(input.snapshot);
  if (!checked.ok) {
    return {
      status: "unreadable",
      reason: checked.reason === "too_large" ? "snapshot_too_large" : "snapshot_invalid",
    };
  }
  const doc: SlidesDocument = checked.document;
  const media = new Map<string, Media>();
  for (const slide of doc.slides) {
    for (const block of slide.blocks) {
      if (block.type !== "image") continue;
      const bytes = input.images.get(block.attachmentId);
      const problem = (reason: "image_missing" | "image_hash_mismatch" | "image_unsupported") =>
        ({ status: "image_problem", reason, attachmentId: block.attachmentId }) as const;
      if (bytes === undefined) return problem("image_missing");
      if (createHash("sha256").update(bytes).digest("hex") !== block.attachmentSha256)
        return problem("image_hash_mismatch");
      if (media.has(block.attachmentSha256)) continue;
      const info = imageInfo(bytes);
      if (info === null) return problem("image_unsupported");
      media.set(block.attachmentSha256, {
        name: `image${media.size + 1}.${info.ext === "jpeg" ? "jpg" : "png"}`,
        info,
        bytes,
      });
    }
  }
  const model = buildSlidesExportModel(doc, input.labels);
  const files: ZipEntry[] = [];
  const enc = new TextEncoder();
  const put = (name: string, data: string | Uint8Array) =>
    files.push({ name, data: typeof data === "string" ? enc.encode(data) : data });

  const count = model.slides.length;
  const hasNotes = model.slides.map((s) => s.notes !== undefined);
  const noteIndex = model.slides.flatMap((s, i) => (s.notes !== undefined ? [i + 1] : []));
  const types = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    media.size > 0 && [...media.values()].some((m) => m.info.ext === "png")
      ? '<Default Extension="png" ContentType="image/png"/>'
      : "",
    media.size > 0 && [...media.values()].some((m) => m.info.ext === "jpeg")
      ? '<Default Extension="jpg" ContentType="image/jpeg"/>'
      : "",
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>`,
    ...SLIDE_LAYOUTS.map(
      (_, i) =>
        `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="${CT}.slideLayout+xml"/>`,
    ),
    `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>`,
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ...model.slides.map(
      (s) =>
        `<Override PartName="/ppt/slides/slide${s.number}.xml" ContentType="${CT}.slide+xml"/>`,
    ),
    ...noteIndex.map(
      (n) =>
        `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${CT}.notesSlide+xml"/>`,
    ),
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];
  put(
    "[Content_Types].xml",
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types.join("")}</Types>`,
  );
  put(
    "_rels/.rels",
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_TYPE}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  put(
    "docProps/core.xml",
    `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(model.title)}</dc:title></cp:coreProperties>`,
  );
  put(
    "docProps/app.xml",
    `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Ductura</Application><Slides>${count}</Slides><Notes>${noteIndex.length}</Notes></Properties>`,
  );
  const slideIds = model.slides
    .map((s) => `<p:sldId id="${255 + s.number}" r:id="rId${3 + s.number}"/>`)
    .join("");
  put(
    "ppt/presentation.xml",
    `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  put(
    "ppt/_rels/presentation.xml.rels",
    rels([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      { id: "rId2", type: "notesMaster", target: "notesMasters/notesMaster1.xml" },
      { id: "rId3", type: "theme", target: "theme/theme1.xml" },
      ...model.slides.map((s) => ({
        id: `rId${3 + s.number}`,
        type: "slide",
        target: `slides/slide${s.number}.xml`,
      })),
    ]),
  );
  put("ppt/theme/theme1.xml", THEME("Ductura"));
  put("ppt/theme/theme2.xml", THEME("Ductura notes"));
  put("ppt/slideMasters/slideMaster1.xml", masterXml());
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([
      ...SLIDE_LAYOUTS.map((_, i) => ({
        id: `rId${i + 1}`,
        type: "slideLayout",
        target: `../slideLayouts/slideLayout${i + 1}.xml`,
      })),
      { id: `rId${SLIDE_LAYOUTS.length + 1}`, type: "theme", target: "../theme/theme1.xml" },
    ]),
  );
  SLIDE_LAYOUTS.forEach((layout, i) => {
    put(`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(layout));
    put(
      `ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`,
      rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
    );
  });
  put("ppt/notesMasters/notesMaster1.xml", notesMasterXml());
  put(
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    rels([{ id: "rId1", type: "theme", target: "../theme/theme2.xml" }]),
  );
  for (const slide of model.slides) {
    const ctx: Context = { nextId: 2, imageRels: new Map(), media };
    put(`ppt/slides/slide${slide.number}.xml`, slideXml(ctx, slide));
    put(
      `ppt/slides/_rels/slide${slide.number}.xml.rels`,
      rels([
        {
          id: "rId1",
          type: "slideLayout",
          target: `../slideLayouts/slideLayout${SLIDE_LAYOUTS.indexOf(slide.layout) + 1}.xml`,
        },
        ...(hasNotes[slide.number - 1]
          ? [
              {
                id: "rId2",
                type: "notesSlide",
                target: `../notesSlides/notesSlide${slide.number}.xml`,
              },
            ]
          : []),
        ...[...ctx.imageRels].map(([name, id]) => ({
          id,
          type: "image",
          target: `../media/${name}`,
        })),
      ]),
    );
    if (slide.notes !== undefined) {
      put(`ppt/notesSlides/notesSlide${slide.number}.xml`, notesXml(slide.notes));
      put(
        `ppt/notesSlides/_rels/notesSlide${slide.number}.xml.rels`,
        rels([
          { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
          { id: "rId2", type: "slide", target: `../slides/slide${slide.number}.xml` },
        ]),
      );
    }
  }
  for (const item of media.values()) put(`ppt/media/${item.name}`, item.bytes);
  return { status: "rendered", bytes: writeZip(files), snapshotSha256: checked.sha256 };
}
