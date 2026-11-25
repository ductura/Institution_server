// SRV-V13-KORACI-SLAJD (val 13): applies `ductus-slide-steps-v1` steps to a
// slides document. Pure and atomic: the input is never changed, a refused step
// leaves no trace, and the result is always a document the validator accepts
// (so every limit of the contract holds after every step). Nothing is skipped
// and nothing is repaired: a step that does not fit the document is refused.
import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../forensics/index.ts";

import {
  LAYOUT_SLOTS,
  MAX_SLIDES_SNAPSHOT_BYTES,
  type Slide,
  type SlideBlock,
  type SlidesDocument,
} from "./schema.ts";
import { slideTextSha256, type SlideStep } from "./steps.ts";
import { validateSlidesDocument } from "./validate.ts";

export type ApplySlideStepErrorCode =
  | "document_invalid"
  | "slide_not_found"
  | "slide_exists"
  | "block_not_found"
  | "index_out_of_range"
  | "range_invalid"
  | "hash_mismatch"
  | "target_invalid"
  | "no_change"
  | "result_invalid"
  | "too_large";

export type ApplySlideStep =
  { ok: true; doc: SlidesDocument } | { ok: false; error: ApplySlideStepErrorCode };
export type ApplySlideSteps =
  { ok: true; doc: SlidesDocument } | { ok: false; error: ApplySlideStepErrorCode; index: number };

/** SHA-256 (lowercase hex) of the JCS text of a slide or a block: the `removedSha256` of a removal. */
export function slideNodeSha256(node: Slide | SlideBlock): string {
  return createHash("sha256").update(canonicalizeJcs(node), "utf8").digest("hex");
}

type Fail = { error: ApplySlideStepErrorCode };

function fail(error: ApplySlideStepErrorCode): Fail {
  return { error };
}

function isFail(value: unknown): value is Fail {
  return typeof value === "object" && value !== null && "error" in value;
}

/** Applies one step to a draft (a deep copy that the caller owns). */
function mutate(doc: SlidesDocument, step: SlideStep): Fail | null {
  const slides = doc.slides;
  const at = slides.findIndex((slide) => slide.id === step.slideId);

  if (step.type === "slideAdd") {
    if (at !== -1) return fail("slide_exists");
    if (step.index > slides.length) return fail("index_out_of_range");
    slides.splice(step.index, 0, { id: step.slideId, layout: step.layout, blocks: [] });
    return null;
  }
  if (at === -1) return fail("slide_not_found");
  const slide = slides[at]!;

  switch (step.type) {
    case "slideRemove": {
      if (slideNodeSha256(slide) !== step.removedSha256) return fail("hash_mismatch");
      slides.splice(at, 1);
      return null;
    }
    case "slideMove": {
      if (step.toIndex >= slides.length) return fail("index_out_of_range");
      if (step.toIndex === at) return fail("no_change");
      slides.splice(at, 1);
      slides.splice(step.toIndex, 0, slide);
      return null;
    }
    case "layoutSet": {
      const slots = LAYOUT_SLOTS[step.layout] as readonly string[];
      // Blocks are never dropped or moved to another slot to make a layout fit.
      if (slide.blocks.some((block) => !slots.includes(block.slot))) return fail("target_invalid");
      slide.layout = step.layout;
      return null;
    }
    case "blockSet": {
      const old = slide.blocks.findIndex((block) => block.id === step.block.id);
      // `index` counts the blocks after the one with the same id (if any) is taken out.
      if (old !== -1) slide.blocks.splice(old, 1);
      if (step.index > slide.blocks.length) return fail("index_out_of_range");
      slide.blocks.splice(step.index, 0, step.block);
      return null;
    }
    case "blockRemove": {
      const old = slide.blocks.findIndex((block) => block.id === step.blockId);
      if (old === -1) return fail("block_not_found");
      if (slideNodeSha256(slide.blocks[old]!) !== step.removedSha256) return fail("hash_mismatch");
      slide.blocks.splice(old, 1);
      return null;
    }
    case "textEdit": {
      const block = slide.blocks.find((candidate) => candidate.id === step.blockId);
      if (block === undefined) return fail("block_not_found");
      const hasItem = step.item !== undefined;
      if (block.type === "image") return fail("target_invalid");
      if ((block.type === "list") !== hasItem) return fail("target_invalid");
      let current: string;
      if (block.type === "list") {
        const item = block.items[step.item!];
        if (item === undefined) return fail("index_out_of_range");
        current = item;
      } else {
        current = block.text;
      }
      const points = Array.from(current);
      if (step.to > points.length) return fail("range_invalid");
      const removed = points.slice(step.from, step.to).join("");
      if (step.removedSha256 !== undefined && slideTextSha256(removed) !== step.removedSha256) {
        return fail("hash_mismatch");
      }
      const next =
        points.slice(0, step.from).join("") + step.insert + points.slice(step.to).join("");
      if (next === current) return fail("no_change");
      if (block.type === "list") block.items[step.item!] = next;
      else block.text = next;
      return null;
    }
    case "notesSet": {
      slide.notes = step.notes;
      return null;
    }
    case "notesRemove": {
      if (slide.notes === undefined) return fail("target_invalid");
      if (slideTextSha256(slide.notes) !== step.removedSha256) return fail("hash_mismatch");
      delete slide.notes;
      return null;
    }
  }
}

/**
 * Applies steps in order, all or nothing. `doc` is revalidated first (a
 * document the validator refuses is `document_invalid`), the work is done on
 * a copy, and the result is validated again: the returned document is always
 * valid and is a fresh object that shares nothing with `doc` or the steps.
 * The first refused step is reported with its index.
 */
export function applySlideSteps(doc: SlidesDocument, steps: readonly SlideStep[]): ApplySlideSteps {
  const start = validateSlidesDocument(doc);
  if (!start.ok) return { ok: false, error: "document_invalid", index: 0 };
  let draft: SlidesDocument = start.doc; // a fresh copy built by the validator
  for (let index = 0; index < steps.length; index += 1) {
    // Steps may share objects with the caller (a block): copy before it enters the draft.
    const step = structuredClone(steps[index]!);
    const refused = mutate(draft, step);
    if (isFail(refused)) return { ok: false, error: refused.error, index };
    // Validating after every step also keeps the intermediate documents valid,
    // so a later step never sees a state the contract forbids.
    const checked = validateSlidesDocument(draft);
    if (!checked.ok) return { ok: false, error: "result_invalid", index };
    // The snapshot cap is not a structural rule of the validator; a document
    // that `verifySlidesSnapshot` would refuse as too large is never a result.
    if (Buffer.byteLength(canonicalizeJcs(checked.doc), "utf8") > MAX_SLIDES_SNAPSHOT_BYTES) {
      return { ok: false, error: "too_large", index };
    }
    draft = checked.doc;
  }
  return { ok: true, doc: draft };
}

/** Applies one step; see `applySlideSteps`. */
export function applySlideStep(doc: SlidesDocument, step: SlideStep): ApplySlideStep {
  const result = applySlideSteps(doc, [step]);
  return result.ok ? result : { ok: false, error: result.error };
}
