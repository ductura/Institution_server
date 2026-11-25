import { describe, expect, it } from "vitest";

import {
  MAX_SLIDE_STEPS_PER_EVENT,
  SLIDE_STEP_FORMAT_V1,
  applySlideStep,
  applySlideSteps,
  parseSlideStep,
  parseSlideSteps,
  slideNodeSha256,
  slideTextSha256,
  slidesDocumentsEqual,
  slidesRevisionZeroDocument,
  slidesSnapshotText,
  validateSlidesDocument,
  type SlideBlock,
  type SlideStep,
  type SlidesDocument,
} from "./index.ts";

// Every document below is invented.
const S1 = "00000000-0000-4000-8000-000000000000"; // slide of revision zero
const S2 = "11111111-1111-4111-8111-111111111111";
const B1 = "22222222-2222-4222-8222-222222222222";
const B2 = "33333333-3333-4333-8333-333333333333";
const B3 = "44444444-4444-4444-8444-444444444444";
const IMG = "55555555-5555-4555-8555-555555555555";

const heading: SlideBlock = { type: "heading", id: B1, slot: "title", text: "Uvod" };
const paragraph: SlideBlock = { type: "paragraph", id: B2, slot: "body", text: "Prvi odlomak" };
const list: SlideBlock = { type: "list", id: B3, slot: "body", items: ["jedan", "dva"] };

function run(steps: SlideStep[], doc: SlidesDocument = slidesRevisionZeroDocument()) {
  return applySlideSteps(doc, steps);
}
function ok(steps: SlideStep[], doc?: SlidesDocument): SlidesDocument {
  const result = run(steps, doc);
  if (!result.ok) throw new Error(`refused: ${result.error} at ${result.index}`);
  return result.doc;
}

describe("format", () => {
  it("has its own name", () => {
    expect(SLIDE_STEP_FORMAT_V1).toBe("ductus-slide-steps-v1");
  });
});

describe("parseSlideStep", () => {
  const valid: unknown[] = [
    { type: "slideAdd", slideId: S2, layout: "title", index: 1 },
    { type: "slideRemove", slideId: S2, removedSha256: "a".repeat(64) },
    { type: "slideMove", slideId: S2, toIndex: 0 },
    { type: "layoutSet", slideId: S1, layout: "twoColumns" },
    { type: "blockSet", slideId: S1, index: 0, block: heading },
    { type: "blockRemove", slideId: S1, blockId: B1, removedSha256: "b".repeat(64) },
    { type: "textEdit", slideId: S1, blockId: B1, from: 0, to: 0, insert: "x" },
    {
      type: "textEdit",
      slideId: S1,
      blockId: B3,
      item: 1,
      from: 0,
      to: 2,
      insert: "",
      removedSha256: "c".repeat(64),
    },
    { type: "notesSet", slideId: S1, notes: "Bilješka" },
    { type: "notesRemove", slideId: S1, removedSha256: "d".repeat(64) },
  ];
  it.each(valid.map((value, i) => [i, value] as const))("accepts form %i", (_i, value) => {
    const parsed = parseSlideStep(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.step).toEqual(value);
  });

  it("refuses an unknown step type, never skips it", () => {
    expect(parseSlideStep({ type: "slideDuplicate", slideId: S1 })).toEqual({
      ok: false,
      error: "unknown_step",
    });
    expect(parseSlideStep({ slideId: S1 })).toEqual({ ok: false, error: "unknown_step" });
    expect(parseSlideStep({ type: "constructor", slideId: S1 })).toEqual({
      ok: false,
      error: "unknown_step",
    });
    expect(parseSlideStep({ type: "toString" }).ok).toBe(false);
  });

  it("refuses what is not a plain object", () => {
    for (const value of [null, undefined, 1, "x", [], () => 1]) {
      expect(parseSlideStep(value)).toEqual({ ok: false, error: "not_an_object" });
    }
  });

  it("refuses unknown and time fields and a hostile key", () => {
    const base = { type: "slideMove", slideId: S1, toIndex: 0 };
    expect(parseSlideStep({ ...base, at: 5 }).ok).toBe(false);
    expect(parseSlideStep({ ...base, time: "2026-01-01" }).ok).toBe(false);
    expect(
      parseSlideStep(
        JSON.parse(`{"type":"slideMove","slideId":"${S1}","toIndex":0,"__proto__":{"x":1}}`),
      ).ok,
    ).toBe(false);
  });

  it("refuses bad ids, hashes, indexes and layouts", () => {
    const refused: unknown[] = [
      { type: "slideAdd", slideId: "nope", layout: "title", index: 0 },
      { type: "slideAdd", slideId: B1.replace("2222", "ABCD"), layout: "title", index: 0 },
      { type: "slideAdd", slideId: S2, layout: "grid", index: 0 },
      { type: "slideAdd", slideId: S2, layout: "title", index: -1 },
      { type: "slideAdd", slideId: S2, layout: "title", index: 1.5 },
      { type: "slideAdd", slideId: S2, layout: "title", index: "1" },
      { type: "slideAdd", slideId: S2, layout: "title", index: Number.MAX_SAFE_INTEGER + 1 },
      { type: "slideMove", slideId: S1, toIndex: NaN },
      { type: "slideRemove", slideId: S1, removedSha256: "A".repeat(64) },
      { type: "slideRemove", slideId: S1, removedSha256: "a".repeat(63) },
      { type: "slideRemove", slideId: S1 },
      { type: "layoutSet", slideId: S1 },
    ];
    for (const value of refused)
      expect(parseSlideStep(value)).toEqual({ ok: false, error: "step_invalid" });
  });

  it("checks a block with the document validator and copies it", () => {
    const refused: unknown[] = [
      { ...heading, text: "" },
      { ...heading, text: " rubni razmak" },
      { ...heading, slot: "body", extra: 1 },
      { ...heading, slot: "nowhere" },
      { ...heading, slot: "subtitle" }, // slot does not take a heading
      {
        type: "image",
        id: IMG,
        slot: "image",
        attachmentId: IMG,
        attachmentSha256: "zz",
        alt: "x",
      },
      "block",
      null,
    ];
    for (const block of refused) {
      expect(parseSlideStep({ type: "blockSet", slideId: S1, index: 0, block }).ok).toBe(false);
    }
    const input = { ...paragraph };
    const parsed = parseSlideStep({ type: "blockSet", slideId: S1, index: 0, block: input });
    expect(parsed.ok && parsed.step.type === "blockSet" && parsed.step.block).toEqual(paragraph);
    if (parsed.ok && parsed.step.type === "blockSet") expect(parsed.step.block).not.toBe(input);
  });

  it("holds a text step to its shape", () => {
    const base = { type: "textEdit", slideId: S1, blockId: B1 };
    const refused: unknown[] = [
      { ...base, from: 2, to: 1, insert: "x" },
      { ...base, from: 1, to: 1, insert: "" }, // changes nothing
      { ...base, from: 0, to: 1, insert: "x" }, // removes text but has no hash
      { ...base, from: 0, to: 0, insert: "x", removedSha256: "a".repeat(64) }, // hash without removal
      { ...base, from: 0, to: 0, insert: "a\ud800" }, // lone surrogate
      { ...base, from: 0, to: 0, insert: "a\u0000" },
      { ...base, from: 0, to: 0, insert: 1 },
      { ...base, item: -1, from: 0, to: 0, insert: "x" },
      { ...base, from: 0, to: 0, insert: "x".repeat(4001) },
    ];
    for (const value of refused) expect(parseSlideStep(value).ok).toBe(false);
  });

  it("refuses empty notes", () => {
    expect(parseSlideStep({ type: "notesSet", slideId: S1, notes: "" }).ok).toBe(false);
  });
});

describe("parseSlideSteps", () => {
  const step = { type: "slideMove", slideId: S1, toIndex: 0 };
  it("reads an array and copies it", () => {
    const parsed = parseSlideSteps([step, step]);
    expect(parsed).toEqual({ ok: true, steps: [step, step] });
  });
  it("refuses empty, non-array, holes, too many and one bad step", () => {
    expect(parseSlideSteps([]).ok).toBe(false);
    expect(parseSlideSteps({ 0: step, length: 1 }).ok).toBe(false);
    expect(parseSlideSteps(new Array(1))).toEqual({ ok: false, error: "step_invalid", index: 0 });
    expect(parseSlideSteps(new Array(MAX_SLIDE_STEPS_PER_EVENT + 1).fill(step))).toEqual({
      ok: false,
      error: "too_many_steps",
    });
    expect(parseSlideSteps([step, { type: "boom" }])).toEqual({
      ok: false,
      error: "unknown_step",
      index: 1,
    });
  });
  it("refuses an array over the byte limit", () => {
    const big = (n: number): SlideStep => ({
      type: "textEdit",
      slideId: S1,
      blockId: B1,
      from: 0,
      to: 0,
      insert: "\u{1f600}".repeat(n),
    });
    // 1000 steps of 4000 emoji (16000 bytes each) is over 2 MiB.
    const steps = new Array(MAX_SLIDE_STEPS_PER_EVENT).fill(big(4000));
    expect(parseSlideSteps(steps)).toEqual({ ok: false, error: "too_large" });
  });
});

describe("applySlideSteps", () => {
  it("builds a deck from revision zero, step by step", () => {
    const doc = ok([
      { type: "blockSet", slideId: S1, index: 0, block: heading },
      { type: "blockSet", slideId: S1, index: 1, block: paragraph },
      { type: "slideAdd", slideId: S2, layout: "title", index: 1 },
      { type: "notesSet", slideId: S2, notes: "Reci nešto" },
      { type: "slideMove", slideId: S2, toIndex: 0 },
    ]);
    expect(doc.slides.map((slide) => slide.id)).toEqual([S2, S1]);
    expect(doc.slides[0]!.notes).toBe("Reci nešto");
    expect(doc.slides[1]!.blocks.map((block) => block.id)).toEqual([B1, B2]);
    expect(validateSlidesDocument(doc).ok).toBe(true);
  });

  it("never changes its input or shares objects with it or the step", () => {
    const base = slidesRevisionZeroDocument();
    const before = slidesSnapshotText(base);
    const block = { ...heading };
    const step: SlideStep = { type: "blockSet", slideId: S1, index: 0, block };
    const result = ok([step], base);
    expect(slidesSnapshotText(base)).toBe(before);
    result.slides[0]!.blocks[0] = paragraph;
    expect(block).toEqual(heading);
    expect(step.type === "blockSet" && step.block).toEqual(heading);
  });

  it("is atomic: a refused step leaves no trace and reports its index", () => {
    const base = ok([{ type: "blockSet", slideId: S1, index: 0, block: heading }]);
    const before = slidesSnapshotText(base);
    const result = run(
      [
        { type: "notesSet", slideId: S1, notes: "ide" },
        { type: "slideMove", slideId: S1, toIndex: 7 },
      ],
      base,
    );
    expect(result).toEqual({ ok: false, error: "index_out_of_range", index: 1 });
    expect(slidesSnapshotText(base)).toBe(before);
  });

  it("refuses a slide that is missing or already there", () => {
    expect(
      applySlideStep(slidesRevisionZeroDocument(), { type: "notesSet", slideId: S2, notes: "x" }),
    ).toEqual({
      ok: false,
      error: "slide_not_found",
    });
    expect(
      applySlideStep(slidesRevisionZeroDocument(), {
        type: "slideAdd",
        slideId: S1,
        layout: "title",
        index: 0,
      }),
    ).toEqual({ ok: false, error: "slide_exists" });
    expect(
      applySlideStep(slidesRevisionZeroDocument(), {
        type: "slideAdd",
        slideId: S2,
        layout: "title",
        index: 2,
      }),
    ).toEqual({ ok: false, error: "index_out_of_range" });
  });

  it("removes a slide only with the hash of exactly that slide", () => {
    const two = ok([{ type: "slideAdd", slideId: S2, layout: "imageOnly", index: 1 }]);
    const wrong = slideNodeSha256(two.slides[0]!);
    expect(applySlideStep(two, { type: "slideRemove", slideId: S2, removedSha256: wrong })).toEqual(
      {
        ok: false,
        error: "hash_mismatch",
      },
    );
    const removed = applySlideStep(two, {
      type: "slideRemove",
      slideId: S2,
      removedSha256: slideNodeSha256(two.slides[1]!),
    });
    expect(removed.ok && removed.doc.slides.map((slide) => slide.id)).toEqual([S1]);
  });

  it("never removes the last slide", () => {
    const result = run([
      {
        type: "slideRemove",
        slideId: S1,
        removedSha256: slideNodeSha256(slidesRevisionZeroDocument().slides[0]!),
      },
    ]);
    expect(result).toEqual({ ok: false, error: "result_invalid", index: 0 });
  });

  it("sets a layout only when every block still has its slot", () => {
    const doc = ok([{ type: "blockSet", slideId: S1, index: 0, block: heading }]);
    expect(
      ok([{ type: "layoutSet", slideId: S1, layout: "twoColumns" }], doc).slides[0]!.layout,
    ).toBe("twoColumns");
    const withBody = ok([{ type: "blockSet", slideId: S1, index: 1, block: paragraph }], doc);
    expect(
      applySlideStep(withBody, { type: "layoutSet", slideId: S1, layout: "imageOnly" }),
    ).toEqual({
      ok: false,
      error: "target_invalid",
    });
    expect(applySlideStep(withBody, { type: "layoutSet", slideId: S1, layout: "title" })).toEqual({
      ok: false,
      error: "target_invalid",
    });
  });

  it("refuses a block the layout cannot hold or in the wrong order", () => {
    const sub: SlideBlock = { type: "paragraph", id: B2, slot: "subtitle", text: "x" };
    expect(
      applySlideStep(slidesRevisionZeroDocument(), {
        type: "blockSet",
        slideId: S1,
        index: 0,
        block: sub,
      }),
    ).toEqual({
      ok: false,
      error: "result_invalid",
    });
    const doc = ok([{ type: "blockSet", slideId: S1, index: 0, block: paragraph }]);
    // a title block after the body breaks the canonical order
    expect(
      applySlideStep(doc, { type: "blockSet", slideId: S1, index: 1, block: heading }),
    ).toEqual({
      ok: false,
      error: "result_invalid",
    });
    expect(
      applySlideStep(doc, { type: "blockSet", slideId: S1, index: 5, block: heading }),
    ).toEqual({
      ok: false,
      error: "index_out_of_range",
    });
  });

  it("refuses a block id that already belongs to another slide", () => {
    const doc = ok([
      { type: "blockSet", slideId: S1, index: 0, block: heading },
      { type: "slideAdd", slideId: S2, layout: "title", index: 1 },
    ]);
    expect(
      applySlideStep(doc, { type: "blockSet", slideId: S2, index: 0, block: heading }),
    ).toEqual({
      ok: false,
      error: "result_invalid",
    });
  });

  it("replaces a block that has the same id", () => {
    const doc = ok([{ type: "blockSet", slideId: S1, index: 0, block: heading }]);
    const next = ok(
      [{ type: "blockSet", slideId: S1, index: 0, block: { ...heading, text: "Drugi naslov" } }],
      doc,
    );
    expect(next.slides[0]!.blocks).toEqual([{ ...heading, text: "Drugi naslov" }]);
  });

  it("removes a block only with its own hash and only from its own slide", () => {
    const doc = ok([{ type: "blockSet", slideId: S1, index: 0, block: heading }]);
    const hash = slideNodeSha256(heading);
    expect(
      applySlideStep(doc, {
        type: "blockRemove",
        slideId: S1,
        blockId: B1,
        removedSha256: "0".repeat(64),
      }),
    ).toEqual({
      ok: false,
      error: "hash_mismatch",
    });
    expect(
      applySlideStep(doc, { type: "blockRemove", slideId: S1, blockId: B2, removedSha256: hash }),
    ).toEqual({
      ok: false,
      error: "block_not_found",
    });
    const gone = applySlideStep(doc, {
      type: "blockRemove",
      slideId: S1,
      blockId: B1,
      removedSha256: hash,
    });
    expect(gone.ok && gone.doc.slides[0]!.blocks).toEqual([]);
  });

  describe("textEdit", () => {
    const doc = ok([
      { type: "blockSet", slideId: S1, index: 0, block: heading },
      { type: "blockSet", slideId: S1, index: 1, block: paragraph },
      { type: "blockSet", slideId: S1, index: 2, block: list },
    ]);
    it("inserts, replaces and deletes by code points", () => {
      const emoji = ok(
        [{ type: "textEdit", slideId: S1, blockId: B1, from: 4, to: 4, insert: "\u{1f600}" }],
        doc,
      );
      expect(emoji.slides[0]!.blocks[0]).toMatchObject({ text: "Uvod\u{1f600}" });
      // offsets count code points, not UTF-16 units: "\u{1f600}" is one
      const replaced = ok(
        [
          {
            type: "textEdit",
            slideId: S1,
            blockId: B1,
            from: 4,
            to: 5,
            insert: "!",
            removedSha256: slideTextSha256("\u{1f600}"),
          },
        ],
        emoji,
      );
      expect(replaced.slides[0]!.blocks[0]).toMatchObject({ text: "Uvod!" });
    });
    it("edits one item of a list and refuses item on a text block and none on a list", () => {
      const next = ok(
        [{ type: "textEdit", slideId: S1, blockId: B3, item: 1, from: 0, to: 0, insert: "ta " }],
        doc,
      );
      expect(next.slides[0]!.blocks[2]).toMatchObject({ items: ["jedan", "ta dva"] });
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B2,
          item: 0,
          from: 0,
          to: 0,
          insert: "x",
        }),
      ).toEqual({
        ok: false,
        error: "target_invalid",
      });
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B3,
          from: 0,
          to: 0,
          insert: "x",
        }),
      ).toEqual({
        ok: false,
        error: "target_invalid",
      });
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B3,
          item: 2,
          from: 0,
          to: 0,
          insert: "x",
        }),
      ).toEqual({
        ok: false,
        error: "index_out_of_range",
      });
    });
    it("refuses a range outside the text, a wrong hash and a text that breaks the rules", () => {
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B1,
          from: 5,
          to: 5,
          insert: "x",
        }),
      ).toEqual({
        ok: false,
        error: "range_invalid",
      });
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B1,
          from: 0,
          to: 1,
          insert: "",
          removedSha256: slideTextSha256("X"),
        }),
      ).toEqual({ ok: false, error: "hash_mismatch" });
      // a heading holds one line, and cannot end with a space
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B1,
          from: 0,
          to: 0,
          insert: "a\nb",
        }).ok,
      ).toBe(false);
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B1,
          from: 4,
          to: 4,
          insert: " ",
        }),
      ).toEqual({
        ok: false,
        error: "result_invalid",
      });
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: B1,
          from: 0,
          to: 4,
          insert: "",
          removedSha256: slideTextSha256("Uvod"),
        }),
      ).toEqual({ ok: false, error: "result_invalid" }); // a heading is never empty
    });
    it("refuses an image block and an unknown block", () => {
      const img: SlideBlock = {
        type: "image",
        id: IMG,
        slot: "body",
        attachmentId: IMG,
        attachmentSha256: "e".repeat(64),
        alt: "slika",
      };
      const withImage = ok([{ type: "blockSet", slideId: S1, index: 3, block: img }], doc);
      expect(
        applySlideStep(withImage, {
          type: "textEdit",
          slideId: S1,
          blockId: IMG,
          from: 0,
          to: 0,
          insert: "x",
        }),
      ).toEqual({
        ok: false,
        error: "target_invalid",
      });
      expect(
        applySlideStep(doc, {
          type: "textEdit",
          slideId: S1,
          blockId: IMG,
          from: 0,
          to: 0,
          insert: "x",
        }),
      ).toEqual({
        ok: false,
        error: "block_not_found",
      });
    });
  });

  it("sets and removes notes", () => {
    const withNotes = ok([{ type: "notesSet", slideId: S1, notes: "a\nb" }]);
    expect(withNotes.slides[0]!.notes).toBe("a\nb");
    expect(
      applySlideStep(withNotes, {
        type: "notesRemove",
        slideId: S1,
        removedSha256: "0".repeat(64),
      }),
    ).toEqual({
      ok: false,
      error: "hash_mismatch",
    });
    const removed = ok(
      [{ type: "notesRemove", slideId: S1, removedSha256: slideTextSha256("a\nb") }],
      withNotes,
    );
    expect("notes" in removed.slides[0]!).toBe(false);
    expect(slidesDocumentsEqual(removed, slidesRevisionZeroDocument())).toBe(true);
    expect(
      applySlideStep(slidesRevisionZeroDocument(), {
        type: "notesRemove",
        slideId: S1,
        removedSha256: "0".repeat(64),
      }),
    ).toEqual({
      ok: false,
      error: "target_invalid",
    });
    expect(
      applySlideStep(slidesRevisionZeroDocument(), {
        type: "notesSet",
        slideId: S1,
        notes: " rub",
      }),
    ).toEqual({
      ok: false,
      error: "result_invalid",
    });
  });

  it("refuses a document that is not valid", () => {
    const bad = {
      documentKind: "slides",
      schemaVersion: 1,
      slides: [],
    } as unknown as SlidesDocument;
    expect(applySlideSteps(bad, [])).toEqual({ ok: false, error: "document_invalid", index: 0 });
  });

  it("keeps the 100 slide limit", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const steps: SlideStep[] = Array.from({ length: 99 }, (_, n) => ({
      type: "slideAdd",
      slideId: id(n + 1),
      layout: "title",
      index: n + 1,
    }));
    const full = ok(steps);
    expect(full.slides).toHaveLength(100);
    expect(
      applySlideStep(full, { type: "slideAdd", slideId: id(500), layout: "title", index: 0 }),
    ).toEqual({
      ok: false,
      error: "result_invalid",
    });
  });

  it("accepts a block whose id equals the parser's probe slide id", () => {
    for (const id of [
      "00000000-0000-4000-8000-0000000000aa",
      "00000000-0000-4000-8000-0000000000bb",
    ]) {
      const block: SlideBlock = { ...heading, id };
      const parsed = parseSlideStep({ type: "blockSet", slideId: S1, index: 0, block });
      expect(parsed.ok).toBe(true);
      if (parsed.ok)
        expect(applySlideStep(slidesRevisionZeroDocument(), parsed.step).ok).toBe(true);
    }
  });

  it("refuses a step whose result is over the snapshot byte limit", () => {
    const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const bid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
    const filler = "\u{1f600}".repeat(1200); // 4800 bytes of UTF-8, JCS keeps them as is
    const paragraphAt = (n: number): SlideBlock => ({
      type: "paragraph",
      id: bid(n),
      slot: "body",
      text: filler,
    });
    // A valid deck close to the cap, built directly: 50 slides of 8 paragraphs
    // is 400 blocks, about 1.92 MB, under 2 MiB.
    const slides = Array.from({ length: 50 }, (_, s) => ({
      id: s === 0 ? S1 : sid(s),
      layout: "titleContent" as const,
      blocks: Array.from({ length: 8 }, (_, b) => paragraphAt(s * 8 + b + 1)),
    }));
    const doc = validateSlidesDocument({ documentKind: "slides", schemaVersion: 1, slides });
    if (!doc.ok) throw new Error("fixture invalid");
    let current = doc.doc;
    expect(Buffer.byteLength(slidesSnapshotText(current), "utf8")).toBeLessThan(2 * 1024 * 1024);
    let refused: ReturnType<typeof applySlideStep> | null = null;
    for (let s = 50; s < 60 && refused === null; s += 1) {
      const added = applySlideStep(current, {
        type: "slideAdd",
        slideId: sid(s),
        layout: "titleContent",
        index: s,
      });
      if (!added.ok) throw new Error("add refused");
      current = added.doc;
      for (let b = 0; b < 8 && refused === null; b += 1) {
        const step: SlideStep = {
          type: "blockSet",
          slideId: sid(s),
          index: b,
          block: paragraphAt(s * 8 + b + 1),
        };
        const result = applySlideStep(current, step);
        if (result.ok) current = result.doc;
        else refused = result;
      }
    }
    expect(refused).toEqual({ ok: false, error: "too_large" });
    expect(Buffer.byteLength(slidesSnapshotText(current), "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
  });
});
