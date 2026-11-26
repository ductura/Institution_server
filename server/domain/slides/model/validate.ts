// Validator of the slides document (docs/contracts/slides-v1.md §4): closed
// key sets, whole numbers only, bounded sizes, text rules shared with the
// text documents (forbidden code points, NFC, no edge white space), blocks in
// the canonical order of the layout's slots. It never repairs: it refuses,
// and a valid input comes back as a fresh copy holding only known keys.
import { allowedCodePointLength, isWhiteSpaceCodePoint } from "../../document/index.ts";
import { hasOnlyKeys, isPlainObject, ownProperty } from "../../json/index.ts";

import {
  LAYOUT_SLOTS,
  MAX_ALT_CODE_POINTS,
  MAX_DOCUMENT_BLOCKS,
  MAX_DOCUMENT_IMAGES,
  MAX_HEADING_CODE_POINTS,
  MAX_LIST_ITEMS,
  MAX_LIST_ITEM_CODE_POINTS,
  MAX_NOTES_CODE_POINTS,
  MAX_SLIDE_PARAGRAPH_CODE_POINTS,
  MAX_SLIDES,
  SLIDE_BLOCK_TYPES,
  SLIDE_LAYOUTS,
  SLIDE_SLOTS,
  SLIDES_DOCUMENT_KIND,
  SLIDES_SCHEMA_VERSION,
  SLOT_BLOCK_TYPES,
  SLOT_CAPACITY,
  isSlidesId,
  isSlidesSha256,
  type Slide,
  type SlideBlock,
  type SlideBlockType,
  type SlideLayout,
  type SlideSlot,
  type SlidesDocument,
  type SlidesValidationError,
  type SlidesValidationErrorCode,
} from "./schema.ts";

export type SlidesValidation =
  { ok: true; doc: SlidesDocument } | { ok: false; errors: SlidesValidationError[] };

const MAX_ERRORS = 50;

const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["documentKind", "schemaVersion", "slides"]);
const SLIDE_KEYS: ReadonlySet<string> = new Set(["id", "layout", "blocks", "notes"]);
const BLOCK_KEYS: Readonly<Record<SlideBlockType, ReadonlySet<string>>> = {
  heading: new Set(["type", "id", "slot", "text"]),
  paragraph: new Set(["type", "id", "slot", "text"]),
  list: new Set(["type", "id", "slot", "items"]),
  image: new Set(["type", "id", "slot", "attachmentId", "attachmentSha256", "alt"]),
};

/**
 * A text of 1 to `max` code points: no forbidden code point (the closed list
 * of document v2), NFC, and no white space at either end. Only the notes and
 * paragraphs may hold line breaks (`\n`, never `\r`).
 */
export function isSlideText(value: unknown, max: number, multiline: boolean): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.normalize("NFC") !== value) return false;
  const lines = multiline ? value.split("\n") : [value];
  let total = lines.length - 1;
  for (const line of lines) {
    const length = allowedCodePointLength(line);
    if (length === null) return false;
    total += length;
  }
  if (total < 1 || total > max) return false;
  const first = value.codePointAt(0)!;
  const lastUnit = value.charCodeAt(value.length - 1);
  const last =
    lastUnit >= 0xdc00 && lastUnit <= 0xdfff
      ? value.codePointAt(value.length - 2)!
      : value.codePointAt(value.length - 1)!;
  return !isWhiteSpaceCodePoint(first) && !isWhiteSpaceCodePoint(last);
}

/** An array with a value at every index: `new Array(1)` has length 1 and no element, and `forEach` skips the hole. */
function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

class Collector {
  readonly errors: SlidesValidationError[] = [];
  add(path: string, code: SlidesValidationErrorCode): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ path, code });
  }
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function validateBlock(
  raw: unknown,
  path: string,
  layout: SlideLayout,
  ids: Set<string>,
  out: Collector,
): SlideBlock | null {
  if (!isPlainObject(raw)) {
    out.add(path, "NOT_AN_OBJECT");
    return null;
  }
  const type = ownProperty(raw, "type");
  if (!includes(SLIDE_BLOCK_TYPES, type)) {
    out.add(`${path}.type`, "BLOCK_TYPE_INVALID");
    return null;
  }
  const before = out.errors.length;
  if (!hasOnlyKeys(raw, BLOCK_KEYS[type])) out.add(path, "UNKNOWN_FIELD");
  const id = ownProperty(raw, "id");
  if (!isSlidesId(id)) out.add(`${path}.id`, "SLIDE_ID_INVALID");
  else if (ids.has(id)) out.add(`${path}.id`, "ID_DUPLICATE");
  else ids.add(id);
  const slot = ownProperty(raw, "slot");
  if (!includes(SLIDE_SLOTS, slot) || !LAYOUT_SLOTS[layout].includes(slot)) {
    out.add(`${path}.slot`, "SLOT_INVALID");
  } else if (!SLOT_BLOCK_TYPES[slot].includes(type)) {
    out.add(`${path}.type`, "BLOCK_TYPE_INVALID");
  }
  const textOf = (key: string, max: number, multiline: boolean): string => {
    const value = ownProperty(raw, key);
    if (!isSlideText(value, max, multiline)) {
      out.add(`${path}.${key}`, key === "alt" ? "IMAGE_INVALID" : "TEXT_INVALID");
      return "";
    }
    return value;
  };
  let block: SlideBlock | null = null;
  if (type === "heading") {
    const text = textOf("text", MAX_HEADING_CODE_POINTS, false);
    block = { type, id: id as string, slot: slot as SlideSlot, text };
  } else if (type === "paragraph") {
    const text = textOf("text", MAX_SLIDE_PARAGRAPH_CODE_POINTS, true);
    block = { type, id: id as string, slot: slot as SlideSlot, text };
  } else if (type === "list") {
    const items = ownProperty(raw, "items");
    const checked: string[] = [];
    if (!isDenseArray(items) || items.length < 1 || items.length > MAX_LIST_ITEMS) {
      out.add(`${path}.items`, "LIST_INVALID");
    } else {
      items.forEach((item, index) => {
        if (isSlideText(item, MAX_LIST_ITEM_CODE_POINTS, false)) checked.push(item);
        else out.add(`${path}.items[${index}]`, "LIST_INVALID");
      });
    }
    block = { type, id: id as string, slot: slot as SlideSlot, items: checked };
  } else {
    const attachmentId = ownProperty(raw, "attachmentId");
    const attachmentSha256 = ownProperty(raw, "attachmentSha256");
    if (!isSlidesId(attachmentId)) out.add(`${path}.attachmentId`, "IMAGE_INVALID");
    if (!isSlidesSha256(attachmentSha256)) out.add(`${path}.attachmentSha256`, "IMAGE_INVALID");
    const alt = textOf("alt", MAX_ALT_CODE_POINTS, false);
    block = {
      type,
      id: id as string,
      slot: slot as SlideSlot,
      attachmentId: attachmentId as string,
      attachmentSha256: attachmentSha256 as string,
      alt,
    };
  }
  return out.errors.length === before ? block : null;
}

function validateSlide(
  raw: unknown,
  path: string,
  ids: Set<string>,
  counts: { blocks: number; images: number },
  out: Collector,
): Slide | null {
  if (!isPlainObject(raw)) {
    out.add(path, "NOT_AN_OBJECT");
    return null;
  }
  const before = out.errors.length;
  if (!hasOnlyKeys(raw, SLIDE_KEYS)) out.add(path, "UNKNOWN_FIELD");
  const id = ownProperty(raw, "id");
  if (!isSlidesId(id)) out.add(`${path}.id`, "SLIDE_ID_INVALID");
  else if (ids.has(id)) out.add(`${path}.id`, "ID_DUPLICATE");
  else ids.add(id);
  const layout = ownProperty(raw, "layout");
  const rawBlocks = ownProperty(raw, "blocks");
  if (!includes(SLIDE_LAYOUTS, layout)) out.add(`${path}.layout`, "LAYOUT_INVALID");
  if (!isDenseArray(rawBlocks)) out.add(`${path}.blocks`, "BLOCKS_INVALID");
  const blocks: SlideBlock[] = [];
  if (includes(SLIDE_LAYOUTS, layout) && isDenseArray(rawBlocks)) {
    const perSlot = new Map<SlideSlot, number>();
    let lastRank = -1;
    rawBlocks.forEach((rawBlock, index) => {
      const at = `${path}.blocks[${index}]`;
      counts.blocks += 1;
      const block = validateBlock(rawBlock, at, layout, ids, out);
      if (block === null) return;
      if (block.type === "image") counts.images += 1;
      const rank = LAYOUT_SLOTS[layout].indexOf(block.slot);
      if (rank < lastRank) out.add(at, "BLOCK_ORDER_INVALID");
      lastRank = Math.max(lastRank, rank);
      const used = (perSlot.get(block.slot) ?? 0) + 1;
      perSlot.set(block.slot, used);
      if (used > SLOT_CAPACITY[block.slot]) out.add(at, "SLOT_FULL");
      blocks.push(block);
    });
  }
  let notes: string | undefined;
  if (Object.hasOwn(raw, "notes")) {
    const value = ownProperty(raw, "notes");
    if (isSlideText(value, MAX_NOTES_CODE_POINTS, true)) notes = value;
    else out.add(`${path}.notes`, "NOTES_INVALID");
  }
  if (out.errors.length > before) return null;
  return {
    id: id as string,
    layout: layout as SlideLayout,
    blocks,
    ...(notes === undefined ? {} : { notes }),
  };
}

/** Validates an unknown value as a slides document (schemaVersion 1). */
export function validateSlidesDocument(raw: unknown): SlidesValidation {
  const out = new Collector();
  if (!isPlainObject(raw)) return { ok: false, errors: [{ path: "", code: "NOT_AN_OBJECT" }] };
  if (!hasOnlyKeys(raw, DOCUMENT_KEYS)) out.add("", "UNKNOWN_FIELD");
  if (ownProperty(raw, "documentKind") !== SLIDES_DOCUMENT_KIND) {
    out.add("documentKind", "DOCUMENT_KIND_INVALID");
  }
  // Strict equality on the JSON number: 1.0 parses to 1, "1" and 1.5 do not.
  if (ownProperty(raw, "schemaVersion") !== SLIDES_SCHEMA_VERSION) {
    out.add("schemaVersion", "SCHEMA_VERSION_INVALID");
  }
  const rawSlides = ownProperty(raw, "slides");
  const slides: Slide[] = [];
  if (!isDenseArray(rawSlides) || rawSlides.length < 1 || rawSlides.length > MAX_SLIDES) {
    out.add("slides", "SLIDES_INVALID");
  } else {
    const ids = new Set<string>();
    const counts = { blocks: 0, images: 0 };
    rawSlides.forEach((rawSlide, index) => {
      const slide = validateSlide(rawSlide, `slides[${index}]`, ids, counts, out);
      if (slide !== null) slides.push(slide);
    });
    if (counts.blocks > MAX_DOCUMENT_BLOCKS) out.add("slides", "TOO_MANY_BLOCKS");
    if (counts.images > MAX_DOCUMENT_IMAGES) out.add("slides", "TOO_MANY_IMAGES");
  }
  if (out.errors.length > 0) return { ok: false, errors: out.errors };
  return {
    ok: true,
    doc: { documentKind: SLIDES_DOCUMENT_KIND, schemaVersion: SLIDES_SCHEMA_VERSION, slides },
  };
}
