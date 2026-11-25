import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LAYOUT_SLOTS,
  SLIDE_LAYOUTS,
  SLOT_CAPACITY,
  slidesDocumentsEqual,
  slidesSnapshotText,
  validateSlidesDocument,
  verifySlidesSnapshot,
  type Slide,
  type SlideBlock,
  type SlidesDocument,
} from "./index.ts";

// Invented text only; a mix of Croatian letters and an astral character.
const text = fc
  .array(fc.constantFrom("a", "b", "č", "ž", "đ", "1", " ", "\u{1f600}"), {
    minLength: 1,
    maxLength: 40,
  })
  .map((chars) => chars.join("").trim())
  .filter((value) => value.length > 0);

const hex = (n: number) => n.toString(16).padStart(12, "0");

const partArb = fc.tuple(
  fc.constantFrom(...SLIDE_LAYOUTS),
  fc.array(text, { minLength: 1, maxLength: 3 }),
  fc.option(text, { nil: undefined }),
);

function build(
  [layout, texts, notes]: readonly [(typeof SLIDE_LAYOUTS)[number], string[], string | undefined],
  index: number,
): Slide {
  let n = (index + 1) * 100;
  const blocks: SlideBlock[] = [];
  for (const slot of LAYOUT_SLOTS[layout]) {
    const count = Math.min(SLOT_CAPACITY[slot], texts.length);
    for (let k = 0; k < count; k += 1) {
      const bid = `00000000-0000-4000-8000-${hex(n++)}`;
      if (slot === "image") {
        blocks.push({
          type: "image",
          id: bid,
          slot,
          attachmentId: `00000000-0000-4000-8000-${hex(n++)}`,
          attachmentSha256: "b".repeat(64),
          alt: texts[k]!,
        });
      } else if (slot === "title") blocks.push({ type: "heading", id: bid, slot, text: texts[k]! });
      else if (slot === "subtitle")
        blocks.push({ type: "paragraph", id: bid, slot, text: texts[k]! });
      else blocks.push({ type: "list", id: bid, slot, items: texts });
    }
  }
  return {
    id: `00000000-0000-4000-8000-${hex(index + 1)}`,
    layout,
    blocks,
    ...(notes === undefined ? {} : { notes }),
  };
}

const docArb: fc.Arbitrary<SlidesDocument> = fc
  .array(partArb, { minLength: 1, maxLength: 6 })
  .map((parts) => ({
    documentKind: "slides" as const,
    schemaVersion: 1 as const,
    slides: parts.map(build),
  }));

describe("slides documents (property)", () => {
  it("a built document validates to itself and its JCS bytes verify", () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const outcome = validateSlidesDocument(doc);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(slidesDocumentsEqual(outcome.doc, doc)).toBe(true);
        const bytes = new TextEncoder().encode(slidesSnapshotText(doc));
        const verified = verifySlidesSnapshot(bytes);
        expect(verified.ok && verified.text).toBe(slidesSnapshotText(doc));
      }),
    );
  });

  it("an unknown key anywhere makes it invalid", () => {
    fc.assert(
      fc.property(docArb, fc.nat(), (doc, pick) => {
        const copy = JSON.parse(JSON.stringify(doc)) as SlidesDocument;
        const slide = copy.slides[pick % copy.slides.length]!;
        (slide as unknown as Record<string, unknown>).extra = 1;
        expect(validateSlidesDocument(copy).ok).toBe(false);
      }),
    );
  });

  it("never throws on arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => validateSlidesDocument(value)).not.toThrow();
      }),
    );
  });
});
