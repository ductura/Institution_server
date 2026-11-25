import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { jcsUtf8Bytes } from "../forensics/index.ts";
import {
  LAYOUT_SLOTS,
  MAX_ALT_CODE_POINTS,
  MAX_DOCUMENT_BLOCKS,
  MAX_DOCUMENT_IMAGES,
  MAX_NOTES_CODE_POINTS,
  MAX_SLIDES,
  MAX_SLIDES_SNAPSHOT_BYTES,
  SLIDES_REVISION_ZERO_JCS,
  SLIDES_REVISION_ZERO_SHA256,
  SLIDE_LAYOUTS,
  SLIDE_SLOTS,
  SLOT_BLOCK_TYPES,
  SLOT_CAPACITY,
  isSlideText,
  slidesDocumentsEqual,
  slidesRevisionZeroDocument,
  slidesSnapshotSha256,
  slidesSnapshotText,
  validateSlidesDocument,
  verifySlidesSnapshot,
  type SlidesDocument,
} from "./index.ts";

// Every document below is invented. The vectors file was derived outside this
// code (Python json and hashlib) and is compared as written.
type Accepted = { name: string; value: unknown; utf8Hex: string; sha256: string };
type Rejected = { name: string; value: unknown; errors: [string, string][] };
const VECTORS = (() => {
  const bytes = readFileSync(new URL("./golden-vectors-v1.json", import.meta.url));
  if (bytes.some((byte) => byte > 0x7e || byte === 0x0d))
    throw new Error("vectors must be ASCII with LF");
  return JSON.parse(bytes.toString("latin1")) as {
    slidesV1: Accepted[];
    rejectedSlidesV1: Rejected[];
  };
})();

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const HASH = "a".repeat(64);

function oneSlide(blocks: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    documentKind: "slides",
    schemaVersion: 1,
    slides: [{ id: id(1), layout: "titleContent", blocks, ...extra }],
  };
}

function errorsOf(value: unknown): [string, string][] {
  const outcome = validateSlidesDocument(value);
  return outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code]);
}

describe("golden vectors of slides v1", () => {
  it.each(VECTORS.slidesV1)("$name is accepted with the same bytes and hash", (vector) => {
    const bytes = Buffer.from(vector.utf8Hex, "hex");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    const outcome = validateSlidesDocument(vector.value);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Buffer.from(jcsUtf8Bytes(outcome.doc)).toString("hex")).toBe(vector.utf8Hex);
      expect(slidesSnapshotSha256(outcome.doc)).toBe(vector.sha256);
    }
    const verified = verifySlidesSnapshot(new Uint8Array(bytes));
    expect(verified.ok && verified.sha256).toBe(vector.sha256);
  });

  it.each(VECTORS.rejectedSlidesV1)("$name is refused with exactly its errors", (vector) => {
    expect(errorsOf(vector.value)).toEqual(vector.errors);
  });

  it("covers every layout, every block type and every slot of a layout", () => {
    const text = JSON.stringify(VECTORS.slidesV1.map((vector) => vector.value));
    for (const layout of SLIDE_LAYOUTS) expect(text, layout).toContain(`"layout":"${layout}"`);
    for (const type of ["heading", "paragraph", "list", "image"])
      expect(text, type).toContain(`"type":"${type}"`);
    expect(text).toContain('"notes"');
  });
});

describe("revision 0 of slides", () => {
  it("is one empty slide with the fixed id and these exact bytes", () => {
    const text =
      '{"documentKind":"slides","schemaVersion":1,"slides":[{"blocks":[],"id":"00000000-0000-4000-8000-000000000000","layout":"titleContent"}]}';
    expect(slidesSnapshotText(slidesRevisionZeroDocument())).toBe(text);
    expect(SLIDES_REVISION_ZERO_JCS).toBe(text);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(
      "f593200307d93c988cc050521ab02853510a424d59763d575de83fda1cf8a0d8",
    );
    expect(SLIDES_REVISION_ZERO_SHA256).toBe(
      "f593200307d93c988cc050521ab02853510a424d59763d575de83fda1cf8a0d8",
    );
  });

  it("is valid, and a caller cannot change it for others", () => {
    const first = slidesRevisionZeroDocument();
    first.slides.push(first.slides[0]!);
    expect(validateSlidesDocument(first).ok).toBe(false);
    expect(slidesSnapshotText(slidesRevisionZeroDocument())).toBe(SLIDES_REVISION_ZERO_JCS);
    expect(validateSlidesDocument(slidesRevisionZeroDocument()).ok).toBe(true);
  });
});

describe("the validator refuses, never repairs", () => {
  it("rejects what is not a plain object, including a forged prototype", () => {
    for (const value of [null, 1, "slides", [], undefined]) {
      expect(errorsOf(value)).toEqual([["", "NOT_AN_OBJECT"]]);
    }
    const forged = JSON.parse(
      '{"__proto__":{"x":1},"documentKind":"slides","schemaVersion":1,"slides":[{"id":"00000000-0000-4000-8000-000000000001","layout":"title","blocks":[]}]}',
    );
    expect(errorsOf(forged)).toEqual([["", "UNKNOWN_FIELD"]]);
  });

  it("takes only whole, exact numbers for schemaVersion", () => {
    for (const version of [1.5, 2, 0, -0, "1", null, true, 1 + 1e-12]) {
      const value = { documentKind: "slides", schemaVersion: version, slides: [] };
      expect(errorsOf(value)).toContainEqual(["schemaVersion", "SCHEMA_VERSION_INVALID"]);
    }
  });

  it("returns a fresh copy that holds only known keys", () => {
    const input = oneSlide([{ type: "heading", id: id(2), slot: "title", text: "Naslov" }]);
    const outcome = validateSlidesDocument(input);
    expect(outcome.ok && outcome.doc).toEqual(input);
    expect(outcome.ok && outcome.doc).not.toBe(input);
  });

  it("checks ids: lowercase v4 only, unique over slides, blocks and nothing else", () => {
    const upper = "00000000-0000-4000-8000-00000000000A";
    expect(errorsOf(oneSlide([{ type: "heading", id: upper, slot: "title", text: "T" }]))).toEqual([
      ["slides[0].blocks[0].id", "SLIDE_ID_INVALID"],
    ]);
    const twice = {
      documentKind: "slides",
      schemaVersion: 1,
      slides: [
        { id: id(1), layout: "title", blocks: [] },
        { id: id(1), layout: "title", blocks: [] },
      ],
    };
    expect(errorsOf(twice)).toEqual([["slides[1].id", "ID_DUPLICATE"]]);
    const nil = "00000000-0000-0000-0000-000000000000";
    expect(errorsOf({ ...twice, slides: [{ id: nil, layout: "title", blocks: [] }] })).toEqual([
      ["slides[0].id", "SLIDE_ID_INVALID"],
    ]);
  });

  it("refuses text with edge white space, NFD, forbidden or lone code points", () => {
    expect(isSlideText("Naslov", 10, false)).toBe(true);
    expect(isSlideText("", 10, false)).toBe(false);
    expect(isSlideText("a ", 10, false)).toBe(false);
    expect(isSlideText("a\n", 10, true)).toBe(false);
    expect(isSlideText("a\nb", 10, false)).toBe(false);
    expect(isSlideText("a\nb", 3, true)).toBe(true);
    expect(isSlideText("a\nb", 2, true)).toBe(false);
    expect(isSlideText("a\r\nb", 10, true)).toBe(false);
    expect(isSlideText("č", 10, false)).toBe(false); // NFD
    expect(isSlideText("č", 10, false)).toBe(true); // NFC
    expect(isSlideText("a\ud800", 10, false)).toBe(false);
    expect(isSlideText("a​b", 10, false)).toBe(false);
    expect(isSlideText("\u{1f600}", 1, false)).toBe(true); // one code point
    expect(isSlideText("\u{1f600}　", 10, false)).toBe(false);
  });

  it("counts code points, not UTF-16 units, at the limit", () => {
    const atLimit = "\u{1f600}".repeat(MAX_ALT_CODE_POINTS);
    const image = (alt: string) => ({
      type: "image",
      id: id(2),
      slot: "body",
      attachmentId: id(3),
      attachmentSha256: HASH,
      alt,
    });
    expect(validateSlidesDocument(oneSlide([image(atLimit)])).ok).toBe(true);
    expect(errorsOf(oneSlide([image(atLimit + "a")]))).toEqual([
      ["slides[0].blocks[0].alt", "IMAGE_INVALID"],
    ]);
  });

  it("bounds notes and the number of slides, blocks and images", () => {
    expect(
      validateSlidesDocument(oneSlide([], { notes: "n".repeat(MAX_NOTES_CODE_POINTS) })).ok,
    ).toBe(true);
    expect(errorsOf(oneSlide([], { notes: "n".repeat(MAX_NOTES_CODE_POINTS + 1) }))).toEqual([
      ["slides[0].notes", "NOTES_INVALID"],
    ]);
    const slide = (n: number, blocks: unknown[] = []) => ({
      id: id(n),
      layout: "titleContent",
      blocks,
    });
    const many = (count: number) => ({
      documentKind: "slides",
      schemaVersion: 1,
      slides: Array.from({ length: count }, (_, n) => slide(n + 1)),
    });
    expect(validateSlidesDocument(many(MAX_SLIDES)).ok).toBe(true);
    expect(errorsOf(many(MAX_SLIDES + 1))).toEqual([["slides", "SLIDES_INVALID"]]);
    let next = 1000;
    const image = () => ({
      type: "image",
      id: id(next++),
      slot: "body",
      attachmentId: id(next++),
      attachmentSha256: HASH,
      alt: "Slika",
    });
    const withImages = (count: number) => ({
      documentKind: "slides",
      schemaVersion: 1,
      slides: Array.from({ length: Math.ceil(count / 8) }, (_, n) =>
        slide(n + 1, Array.from({ length: Math.min(8, count - n * 8) }, image)),
      ),
    });
    expect(validateSlidesDocument(withImages(MAX_DOCUMENT_IMAGES)).ok).toBe(true);
    expect(errorsOf(withImages(MAX_DOCUMENT_IMAGES + 1))).toEqual([["slides", "TOO_MANY_IMAGES"]]);
    expect(MAX_DOCUMENT_BLOCKS).toBeGreaterThan(MAX_DOCUMENT_IMAGES);
  });

  it("stops at the error cap and stays fast on hostile input", () => {
    const blocks = Array.from({ length: 5000 }, () => 7);
    const outcome = validateSlidesDocument(oneSlide(blocks));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.errors.length).toBeLessThanOrEqual(50);
  });

  it("keeps the slot tables consistent with each other", () => {
    for (const layout of SLIDE_LAYOUTS) {
      for (const slot of LAYOUT_SLOTS[layout]) expect(SLIDE_SLOTS).toContain(slot);
    }
    for (const slot of SLIDE_SLOTS) {
      expect(SLOT_BLOCK_TYPES[slot].length).toBeGreaterThan(0);
      expect(SLOT_CAPACITY[slot]).toBeGreaterThan(0);
    }
  });
});

describe("snapshot", () => {
  const doc = validateSlidesDocument(VECTORS.slidesV1[1]!.value);
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("accepts only the exact JCS bytes", () => {
    if (!doc.ok) throw new Error("vector must be valid");
    const text = slidesSnapshotText(doc.doc);
    expect(verifySlidesSnapshot(bytes(text)).ok).toBe(true);
    expect(verifySlidesSnapshot(bytes(JSON.stringify(doc.doc, null, 1)))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(verifySlidesSnapshot(bytes("﻿" + text))).toEqual({ ok: false, reason: "invalid" });
    expect(verifySlidesSnapshot(bytes(text.replace('"title"', '"title" ')))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(verifySlidesSnapshot(new Uint8Array([0xff, 0xfe]))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(verifySlidesSnapshot("x" as unknown as Uint8Array)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a snapshot above 2 MiB before parsing it", () => {
    expect(verifySlidesSnapshot(new Uint8Array(MAX_SLIDES_SNAPSHOT_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("refuses a valid document written in another key order", () => {
    expect(
      verifySlidesSnapshot(
        bytes(
          '{"slides":[{"id":"00000000-0000-4000-8000-000000000000","layout":"titleContent","blocks":[]}],"schemaVersion":1,"documentKind":"slides"}',
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("equality", () => {
  const base = (): SlidesDocument => slidesRevisionZeroDocument();

  it("is true for the same bytes whatever the key order of the input", () => {
    const a = validateSlidesDocument(VECTORS.slidesV1[1]!.value);
    const b = validateSlidesDocument(VECTORS.slidesV1[1]!.value);
    expect(a.ok && b.ok && slidesDocumentsEqual(a.doc, b.doc)).toBe(true);
  });

  it("counts ids, layout, notes and slide order as content", () => {
    const changed: SlidesDocument[] = [];
    const id2 = base();
    id2.slides[0]!.id = id(5);
    changed.push(id2);
    const layout = base();
    layout.slides[0]!.layout = "title";
    changed.push(layout);
    const notes = base();
    notes.slides[0]!.notes = "Bilješka";
    changed.push(notes);
    const extra = base();
    extra.slides.push({ id: id(6), layout: "title", blocks: [] });
    changed.push(extra);
    for (const doc of changed) expect(slidesDocumentsEqual(base(), doc)).toBe(false);
    const ab = base();
    ab.slides.push({ id: id(6), layout: "title", blocks: [] });
    const ba: SlidesDocument = { ...ab, slides: [ab.slides[1]!, ab.slides[0]!] };
    expect(slidesDocumentsEqual(ab, ba)).toBe(false);
  });
});
