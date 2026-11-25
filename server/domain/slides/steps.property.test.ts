import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applySlideStep,
  applySlideSteps,
  parseSlideStep,
  parseSlideSteps,
  slideNodeSha256,
  slidesDocumentsEqual,
  slidesRevisionZeroDocument,
  slidesSnapshotText,
  validateSlidesDocument,
  verifySlidesSnapshot,
  type SlideStep,
  type SlidesDocument,
} from "./index.ts";

// Invented text only; a mix of Croatian letters and an astral character.
const text = fc
  .array(fc.constantFrom("a", "b", "č", "ž", "đ", "1", "\u{1f600}"), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

const hex = (n: number) => n.toString(16).padStart(12, "0");
const slideId = (n: number) => `00000000-0000-4000-8000-${hex(n)}`;
const blockId = (n: number) => `00000000-0000-4000-9000-${hex(n)}`;

// A random, mostly sensible step over a document that is looked at when the
// step is built; many steps are refused, and that is part of what is checked.
type Pick = { kind: number; a: number; b: number; t: string };
const pick = fc.record({
  kind: fc.integer({ min: 0, max: 8 }),
  a: fc.integer({ min: 0, max: 6 }),
  b: fc.integer({ min: 0, max: 6 }),
  t: text,
});

function stepFor(doc: SlidesDocument, p: Pick, serial: number): SlideStep {
  const slide = doc.slides[p.a % doc.slides.length]!;
  switch (p.kind) {
    case 0:
      return {
        type: "slideAdd",
        slideId: slideId(serial + 1),
        layout: "titleContent",
        index: p.b % (doc.slides.length + 1),
      };
    case 1:
      return { type: "slideRemove", slideId: slide.id, removedSha256: slideNodeSha256(slide) };
    case 2:
      return { type: "slideMove", slideId: slide.id, toIndex: p.b % doc.slides.length };
    case 3:
      return {
        type: "layoutSet",
        slideId: slide.id,
        layout: p.b % 2 === 0 ? "twoColumns" : "titleContent",
      };
    case 4:
      return {
        type: "blockSet",
        slideId: slide.id,
        index: p.b % (slide.blocks.length + 1),
        block: {
          type: "paragraph",
          id: blockId(serial + 1),
          slot: p.b % 2 === 0 ? "body" : "left",
          text: p.t,
        },
      };
    case 5: {
      const block = slide.blocks[p.b % Math.max(slide.blocks.length, 1)];
      if (block === undefined) return { type: "notesSet", slideId: slide.id, notes: p.t };
      return {
        type: "blockRemove",
        slideId: slide.id,
        blockId: block.id,
        removedSha256: slideNodeSha256(block),
      };
    }
    case 6: {
      const block = slide.blocks.find((candidate) => candidate.type === "paragraph");
      if (block === undefined) return { type: "notesSet", slideId: slide.id, notes: p.t };
      return {
        type: "textEdit",
        slideId: slide.id,
        blockId: block.id,
        from: 0,
        to: 0,
        insert: p.t,
      };
    }
    case 7:
      return { type: "notesSet", slideId: slide.id, notes: p.t };
    default:
      return { type: "slideMove", slideId: slide.id, toIndex: 0 };
  }
}

/** Builds steps one after the other, keeping those that apply. */
function accepted(picks: Pick[]): { steps: SlideStep[]; doc: SlidesDocument } {
  let doc = slidesRevisionZeroDocument();
  const steps: SlideStep[] = [];
  picks.forEach((p, serial) => {
    const step = stepFor(doc, p, serial);
    const result = applySlideStep(doc, step);
    if (result.ok) {
      steps.push(step);
      doc = result.doc;
    }
  });
  return { steps, doc };
}

describe("slide steps, properties", () => {
  it("every document that steps produce is valid, canonical and verifiable", () => {
    fc.assert(
      fc.property(fc.array(pick, { maxLength: 40 }), (picks) => {
        const { doc } = accepted(picks);
        expect(validateSlidesDocument(doc).ok).toBe(true);
        const bytes = new TextEncoder().encode(slidesSnapshotText(doc));
        expect(verifySlidesSnapshot(bytes).ok).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it("order matters and replay is exact: the same steps on the same document give the same bytes", () => {
    fc.assert(
      fc.property(fc.array(pick, { maxLength: 30 }), (picks) => {
        const { steps, doc } = accepted(picks);
        // through the wire: JSON text and back, then parse, then apply as one event
        const wire: unknown = JSON.parse(JSON.stringify(steps));
        if (steps.length === 0) return;
        const parsed = parseSlideSteps(wire);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const first = applySlideSteps(slidesRevisionZeroDocument(), parsed.steps);
        const second = applySlideSteps(slidesRevisionZeroDocument(), parsed.steps);
        expect(first.ok && second.ok).toBe(true);
        if (first.ok && second.ok) {
          expect(slidesSnapshotText(first.doc)).toBe(slidesSnapshotText(second.doc));
          expect(slidesDocumentsEqual(first.doc, doc)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("splitting the steps into events changes nothing", () => {
    fc.assert(
      fc.property(fc.array(pick, { maxLength: 30 }), fc.nat(30), (picks, cut) => {
        const { steps, doc } = accepted(picks);
        const at = Math.min(cut, steps.length);
        const head = applySlideSteps(slidesRevisionZeroDocument(), steps.slice(0, at));
        expect(head.ok).toBe(true);
        if (!head.ok) return;
        const tail = applySlideSteps(head.doc, steps.slice(at));
        expect(tail.ok && slidesDocumentsEqual(tail.doc, doc)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("setting steps are idempotent; adding and removing are not", () => {
    fc.assert(
      fc.property(fc.array(pick, { maxLength: 25 }), pick, (picks, last) => {
        const { doc } = accepted(picks);
        const step = stepFor(doc, last, 1000);
        const once = applySlideStep(doc, step);
        if (!once.ok) return;
        const twice = applySlideStep(once.doc, step);
        if (step.type === "slideAdd") {
          expect(twice).toEqual({ ok: false, error: "slide_exists" });
        } else if (step.type === "slideRemove") {
          expect(twice).toEqual({ ok: false, error: "slide_not_found" });
        } else if (step.type === "blockRemove") {
          expect(twice).toEqual({ ok: false, error: "block_not_found" });
        } else if (step.type === "slideMove") {
          // a move to where the slide already is changes nothing and is refused
          expect(twice).toEqual({ ok: false, error: "no_change" });
        } else if (step.type === "textEdit") {
          // an insert at the same place makes more text, never a silent no-op
          expect(twice.ok && twice.doc).not.toEqual(once.doc);
        } else {
          expect(twice.ok).toBe(true);
          if (twice.ok) expect(slidesDocumentsEqual(twice.doc, once.doc)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("an unknown step type is refused whatever else it holds", () => {
    const known = new Set([
      "slideAdd",
      "slideRemove",
      "slideMove",
      "layoutSet",
      "blockSet",
      "blockRemove",
      "textEdit",
      "notesSet",
      "notesRemove",
    ]);
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 })),
        (type, rest) => {
          fc.pre(!known.has(type));
          expect(parseSlideStep({ ...rest, type })).toEqual({ ok: false, error: "unknown_step" });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("arbitrary JSON never makes the parser or the applier throw", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const parsed = parseSlideStep(value);
        if (parsed.ok) applySlideStep(slidesRevisionZeroDocument(), parsed.step);
        parseSlideSteps(value);
      }),
      { numRuns: 300 },
    );
  });
});
