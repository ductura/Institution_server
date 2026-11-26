// SRV-V13-KORACI-SLAJD (val 13): the serialised editing step of a slides
// document, format `ductus-slide-steps-v1`. Pure: no clock, no I/O and no Node
// module (SRV-V14-PARSERI-BEZ-NODE). The editor's capture, the evidence segment
// check (server/domain/forensics/evidence-segment-v2.ts) and the server's
// replayer all read steps through `parseSlideStep`, so none can accept a shape
// another does not know. The hash a removal carries is computed in
// ../step-hash.ts, never here.
//
// Rules, as for the text steps (server/domain/document/edit-step.ts):
//   - every object has a closed set of keys: an unknown field, `__proto__`
//     and any time field have nowhere to sit;
//   - an unknown step type is refused (`unknown_step`), never skipped;
//   - positions are non-negative safe integers; whether they lie inside the
//     document is `applySlideStep`'s check, because only it holds the document;
//   - a step that removes content carries the SHA-256 of what it removes, so a
//     removal never goes unnoticed (nothing is deleted silently);
//   - a block in a step is checked by the document validator itself, so a step
//     cannot carry a block the document would refuse;
//   - the result is a fresh copy built from known fields only.
import { canonicalizeJcs } from "../../forensics/index.ts";
import { hasOnlyKeys, isPlainObject, ownProperty } from "../../json/index.ts";

import {
  SLIDE_LAYOUTS,
  isSlidesId,
  isSlidesSha256,
  LAYOUT_SLOTS,
  type SlideBlock,
  type SlideLayout,
} from "./schema.ts";
import { validateSlidesDocument } from "./validate.ts";

/** Value of `captureContext.transactionFormat` for slides documents. */
export const SLIDE_STEP_FORMAT_V1 = "ductus-slide-steps-v1" as const;

export const SLIDE_STEP_TYPES = [
  "slideAdd",
  "slideRemove",
  "slideMove",
  "layoutSet",
  "blockSet",
  "blockRemove",
  "textEdit",
  "notesSet",
  "notesRemove",
] as const;
export type SlideStepType = (typeof SLIDE_STEP_TYPES)[number];

/** Most steps in the array of one event (proposal; contract slides-steps §3). */
export const MAX_SLIDE_STEPS_PER_EVENT = 1000;
/** Most UTF-8 bytes of the array of one event, as for a whole segment (2 MiB). */
export const MAX_SLIDE_STEPS_BYTES = 2_097_152;

/** Adds an empty slide (no blocks, no notes) so that it is at `index` afterwards. */
export type SlideAddStep = {
  type: "slideAdd";
  slideId: string;
  layout: SlideLayout;
  index: number;
};
/** Removes a slide; `removedSha256` is the SHA-256 of its JCS text. */
export type SlideRemoveStep = { type: "slideRemove"; slideId: string; removedSha256: string };
/** Moves a slide so that it is at `toIndex` afterwards. */
export type SlideMoveStep = { type: "slideMove"; slideId: string; toIndex: number };
/** Sets the layout; refused when a block's slot is not in the new layout. */
export type LayoutSetStep = { type: "layoutSet"; slideId: string; layout: SlideLayout };
/**
 * Puts a block in a slide so that it is at `index` among the slide's blocks
 * afterwards: inserts it when no block of the slide has its id, replaces
 * (and moves) the block with that id otherwise.
 */
export type BlockSetStep = { type: "blockSet"; slideId: string; index: number; block: SlideBlock };
/** Removes a block; `removedSha256` is the SHA-256 of its JCS text. */
export type BlockRemoveStep = {
  type: "blockRemove";
  slideId: string;
  blockId: string;
  removedSha256: string;
};
/**
 * Replaces the code points `[from, to)` of the text of a heading or paragraph
 * block (of one item for a list block, `item` set) with `insert`.
 * `removedSha256` is the SHA-256 of the UTF-8 bytes of the replaced text and
 * is present exactly when `from < to`.
 */
export type TextEditStep = {
  type: "textEdit";
  slideId: string;
  blockId: string;
  item?: number;
  from: number;
  to: number;
  insert: string;
  removedSha256?: string;
};
export type NotesSetStep = { type: "notesSet"; slideId: string; notes: string };
/** `removedSha256` is the SHA-256 of the UTF-8 bytes of the removed notes. */
export type NotesRemoveStep = { type: "notesRemove"; slideId: string; removedSha256: string };

export type SlideStep =
  | SlideAddStep
  | SlideRemoveStep
  | SlideMoveStep
  | LayoutSetStep
  | BlockSetStep
  | BlockRemoveStep
  | TextEditStep
  | NotesSetStep
  | NotesRemoveStep;

export type SlideStepErrorCode =
  "not_an_object" | "unknown_step" | "step_invalid" | "too_many_steps" | "too_large";
export type SlideStepParse =
  { ok: true; step: SlideStep } | { ok: false; error: SlideStepErrorCode };
export type SlideStepsParse =
  { ok: true; steps: SlideStep[] } | { ok: false; error: SlideStepErrorCode; index?: number };

const KEYS: Readonly<Record<SlideStepType, ReadonlySet<string>>> = {
  slideAdd: new Set(["type", "slideId", "layout", "index"]),
  slideRemove: new Set(["type", "slideId", "removedSha256"]),
  slideMove: new Set(["type", "slideId", "toIndex"]),
  layoutSet: new Set(["type", "slideId", "layout"]),
  blockSet: new Set(["type", "slideId", "index", "block"]),
  blockRemove: new Set(["type", "slideId", "blockId", "removedSha256"]),
  textEdit: new Set([
    "type",
    "slideId",
    "blockId",
    "item",
    "from",
    "to",
    "insert",
    "removedSha256",
  ]),
  notesSet: new Set(["type", "slideId", "notes"]),
  notesRemove: new Set(["type", "slideId", "removedSha256"]),
};

// A text inside a step is bounded like a whole snapshot; the document
// validator then applies the real per-field limits to the result.
const MAX_INSERT_CODE_POINTS = 4000;

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLayout(value: unknown): value is SlideLayout {
  return typeof value === "string" && (SLIDE_LAYOUTS as readonly string[]).includes(value);
}

/** Well-formed Unicode (no lone surrogate) and no NUL; never normalised. */
function isWellFormedText(value: unknown): value is string {
  return typeof value === "string" && !/\p{Cs}/u.test(value) && !value.includes("\u0000");
}

/**
 * A block as the document validator sees it: put alone in a probe slide whose
 * layout has the block's slot. Returns a fresh, known-keys-only copy, or null.
 */
const PROBE_SLIDE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PROBE_SLIDE_ID = "00000000-0000-4000-8000-0000000000bb";

function checkBlock(raw: unknown): SlideBlock | null {
  if (!isPlainObject(raw)) return null;
  const slot = ownProperty(raw, "slot");
  const layout = SLIDE_LAYOUTS.find((candidate) =>
    (LAYOUT_SLOTS[candidate] as readonly unknown[]).includes(slot),
  );
  if (layout === undefined) return null;
  // A probe slide id that differs from the block's id, so no valid block id is excluded.
  const probeId = ownProperty(raw, "id") === PROBE_SLIDE_ID ? OTHER_PROBE_SLIDE_ID : PROBE_SLIDE_ID;
  const probe = validateSlidesDocument({
    documentKind: "slides",
    schemaVersion: 1,
    slides: [{ id: probeId, layout, blocks: [raw] }],
  });
  if (!probe.ok) return null;
  return probe.doc.slides[0]!.blocks[0] ?? null;
}

/**
 * Reads one step. An accepted step is a fresh copy with only known fields;
 * everything else is refused, never guessed.
 */
export function parseSlideStep(raw: unknown): SlideStepParse {
  if (!isPlainObject(raw)) return { ok: false, error: "not_an_object" };
  const type = ownProperty(raw, "type");
  if (typeof type !== "string" || !(SLIDE_STEP_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "unknown_step" };
  }
  const kind = type as SlideStepType;
  const bad = { ok: false, error: "step_invalid" } as const;
  if (!hasOnlyKeys(raw, KEYS[kind])) return bad;
  const slideId = ownProperty(raw, "slideId");
  if (!isSlidesId(slideId)) return bad;
  const get = (key: string): unknown => ownProperty(raw, key);

  switch (kind) {
    case "slideAdd": {
      const layout = get("layout");
      const index = get("index");
      if (!isLayout(layout) || !isIndex(index)) return bad;
      return { ok: true, step: { type: kind, slideId, layout, index } };
    }
    case "slideRemove": {
      const removedSha256 = get("removedSha256");
      if (!isSlidesSha256(removedSha256)) return bad;
      return { ok: true, step: { type: kind, slideId, removedSha256 } };
    }
    case "slideMove": {
      const toIndex = get("toIndex");
      if (!isIndex(toIndex)) return bad;
      return { ok: true, step: { type: kind, slideId, toIndex } };
    }
    case "layoutSet": {
      const layout = get("layout");
      if (!isLayout(layout)) return bad;
      return { ok: true, step: { type: kind, slideId, layout } };
    }
    case "blockSet": {
      const index = get("index");
      const block = checkBlock(get("block"));
      if (!isIndex(index) || block === null) return bad;
      return { ok: true, step: { type: kind, slideId, index, block } };
    }
    case "blockRemove": {
      const blockId = get("blockId");
      const removedSha256 = get("removedSha256");
      if (!isSlidesId(blockId) || !isSlidesSha256(removedSha256)) return bad;
      return { ok: true, step: { type: kind, slideId, blockId, removedSha256 } };
    }
    case "textEdit": {
      const blockId = get("blockId");
      const from = get("from");
      const to = get("to");
      const insert = get("insert");
      const hasItem = Object.hasOwn(raw, "item");
      const item = get("item");
      const hasHash = Object.hasOwn(raw, "removedSha256");
      const removedSha256 = get("removedSha256");
      if (!isSlidesId(blockId) || !isIndex(from) || !isIndex(to) || from > to) return bad;
      if (!isWellFormedText(insert) || Array.from(insert).length > MAX_INSERT_CODE_POINTS) {
        return bad;
      }
      if (hasItem && !isIndex(item)) return bad;
      // A step that changes nothing is refused: `from === to` with nothing to insert.
      if (from === to && insert.length === 0) return bad;
      // The hash is present exactly when text is removed.
      if (from < to !== hasHash) return bad;
      if (hasHash && !isSlidesSha256(removedSha256)) return bad;
      return {
        ok: true,
        step: {
          type: kind,
          slideId,
          blockId,
          ...(hasItem ? { item: item as number } : {}),
          from,
          to,
          insert,
          ...(hasHash ? { removedSha256: removedSha256 as string } : {}),
        },
      };
    }
    case "notesSet": {
      const notes = get("notes");
      if (!isWellFormedText(notes) || notes.length === 0) return bad;
      return { ok: true, step: { type: kind, slideId, notes } };
    }
    case "notesRemove": {
      const removedSha256 = get("removedSha256");
      if (!isSlidesSha256(removedSha256)) return bad;
      return { ok: true, step: { type: kind, slideId, removedSha256 } };
    }
  }
}

/**
 * Reads the array of one event: 1 to `MAX_SLIDE_STEPS_PER_EVENT` steps, at
 * most `MAX_SLIDE_STEPS_BYTES` of UTF-8. One bad step refuses the whole array.
 */
export function parseSlideSteps(raw: unknown): SlideStepsParse {
  if (!Array.isArray(raw)) return { ok: false, error: "step_invalid" };
  if (raw.length < 1) return { ok: false, error: "step_invalid" };
  if (raw.length > MAX_SLIDE_STEPS_PER_EVENT) return { ok: false, error: "too_many_steps" };
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(raw, index)) return { ok: false, error: "step_invalid", index };
  }
  const steps: SlideStep[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseSlideStep(raw[index]);
    if (!parsed.ok) return { ok: false, error: parsed.error, index };
    steps.push(parsed.step);
  }
  // The steps are fresh known-keys copies of valid input, so the JCS form cannot throw.
  if (new TextEncoder().encode(canonicalizeJcs(steps)).byteLength > MAX_SLIDE_STEPS_BYTES) {
    return { ok: false, error: "too_large" };
  }
  return { ok: true, steps };
}
