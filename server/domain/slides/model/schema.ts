// SRV-V13-UGOVOR-SLAJD (val 13; docs/contracts/slides-v1.md): the canonical
// document of a work of kind "slides". A line of its own with its own
// `schemaVersion` counted from 1; it never extends text documents 1 to 4, so
// text works stay byte-identical. Pure types and constants, no I/O.

/** The kind of document a work holds; fixed at revision 0 and never changed. */
export const SLIDES_DOCUMENT_KIND = "slides";

/** `schemaVersion` of the slides line. */
export const SLIDES_SCHEMA_VERSION = 1;

/** Closed list of layouts (contract §3). */
export const SLIDE_LAYOUTS = ["title", "titleContent", "twoColumns", "imageOnly"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** Closed list of slots a block can occupy. */
export const SLIDE_SLOTS = ["title", "subtitle", "body", "left", "right", "image"] as const;
export type SlideSlot = (typeof SLIDE_SLOTS)[number];

/** The slots of each layout, in the order blocks must appear in `blocks`. */
export const LAYOUT_SLOTS: Readonly<Record<SlideLayout, readonly SlideSlot[]>> = {
  title: ["title", "subtitle"],
  titleContent: ["title", "body"],
  twoColumns: ["title", "left", "right"],
  imageOnly: ["image"],
};

export const SLIDE_BLOCK_TYPES = ["heading", "paragraph", "list", "image"] as const;
export type SlideBlockType = (typeof SLIDE_BLOCK_TYPES)[number];

/** Which block types each slot accepts. */
export const SLOT_BLOCK_TYPES: Readonly<Record<SlideSlot, readonly SlideBlockType[]>> = {
  title: ["heading"],
  subtitle: ["paragraph"],
  body: ["paragraph", "list", "heading", "image"],
  left: ["paragraph", "list", "heading", "image"],
  right: ["paragraph", "list", "heading", "image"],
  image: ["image"],
};

/** Most blocks one slot holds. */
export const SLOT_CAPACITY: Readonly<Record<SlideSlot, number>> = {
  title: 1,
  subtitle: 1,
  body: 8,
  left: 8,
  right: 8,
  image: 1,
};

// Limits (contract §6). Numbers are the contract's proposal; the owner
// confirms them when reviewing the contract.
export const MAX_SLIDES = 100;
export const MAX_DOCUMENT_BLOCKS = 800;
export const MAX_DOCUMENT_IMAGES = 60;
export const MAX_HEADING_CODE_POINTS = 200;
export const MAX_SLIDE_PARAGRAPH_CODE_POINTS = 2000;
export const MAX_LIST_ITEMS = 20;
export const MAX_LIST_ITEM_CODE_POINTS = 300;
export const MAX_ALT_CODE_POINTS = 300;
export const MAX_NOTES_CODE_POINTS = 4000;
/** The cap of one snapshot in UTF-8 bytes: 2 MiB, as for text documents. */
export const MAX_SLIDES_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type HeadingBlock = {
  type: "heading";
  id: string;
  slot: SlideSlot;
  text: string;
};
export type ParagraphBlock = {
  type: "paragraph";
  id: string;
  slot: SlideSlot;
  text: string;
};
export type ListBlock = {
  type: "list";
  id: string;
  slot: SlideSlot;
  items: string[];
};
/** An image through the existing attachments, bound by its SHA-256. */
export type SlideImageBlock = {
  type: "image";
  id: string;
  slot: SlideSlot;
  attachmentId: string;
  attachmentSha256: string;
  alt: string;
};
export type SlideBlock = HeadingBlock | ParagraphBlock | ListBlock | SlideImageBlock;

export type Slide = {
  id: string;
  layout: SlideLayout;
  blocks: SlideBlock[];
  /** Speaker notes; absent when there are none (never an empty string). */
  notes?: string;
};

export type SlidesDocument = {
  documentKind: typeof SLIDES_DOCUMENT_KIND;
  schemaVersion: typeof SLIDES_SCHEMA_VERSION;
  slides: Slide[];
};

export type SlidesValidationErrorCode =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FIELD"
  | "DOCUMENT_KIND_INVALID"
  | "SCHEMA_VERSION_INVALID"
  | "SLIDES_INVALID"
  | "SLIDE_ID_INVALID"
  | "ID_DUPLICATE"
  | "LAYOUT_INVALID"
  | "BLOCKS_INVALID"
  | "BLOCK_TYPE_INVALID"
  | "SLOT_INVALID"
  | "BLOCK_ORDER_INVALID"
  | "SLOT_FULL"
  | "TEXT_INVALID"
  | "LIST_INVALID"
  | "IMAGE_INVALID"
  | "NOTES_INVALID"
  | "TOO_MANY_BLOCKS"
  | "TOO_MANY_IMAGES";

export type SlidesValidationError = { path: string; code: SlidesValidationErrorCode };

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Lowercase UUID v4 shape, the id of a slide, a block or an attachment. */
export function isSlidesId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isSlidesSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}
