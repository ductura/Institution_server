import { describe, expect, it } from "vitest";

import { validateDocumentV4 } from "./validate-v4.ts";

// Document v4 image and cover (docs/contracts/document-schema-v4.md §5.2 and
// §7, classes 58 and 59; SRV-10A). Invented data only.

const P = "11111111-1111-4111-8111-111111111111";
const F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const HASH = "0".repeat(64);

const doc = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 4,
  sources: [],
  nodes: [{ type: "pageBreak", id: P }],
  ...extra,
});
const bareImage = (fields: Record<string, unknown> = {}) =>
  doc({
    nodes: [
      { type: "image", id: P, widthPercent: 60, align: "center", landscape: false, ...fields },
    ],
  });
const image = (fields: Record<string, unknown> = {}) =>
  bareImage({ attachmentId: F, attachmentSha256: HASH, ...fields });
const errorsOf = (value: unknown) => {
  const outcome = validateDocumentV4(value);
  return outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code]);
};
const accepts = (value: unknown) =>
  expect(validateDocumentV4(value)).toEqual({ ok: true, doc: value });
const at = (field: string, code: string) => [[`$.nodes[0]${field}`, code]];
const crop = (left: number, right: number, top: number, bottom: number) => ({
  bottom,
  left,
  right,
  top,
});

describe("image (§5.2, class 58)", () => {
  it("accepts an image with an attachment, a crop and every field, and one without attachment", () => {
    accepts(
      image({ crop: crop(10, 5, 0, 0), title: "Kompostište u dvorištu", source: "izrada autora" }),
    );
    accepts(image({ crop: crop(45, 45, 45, 45), widthPercent: 100, align: "left" }));
    accepts(bareImage({ widthPercent: 20, align: "right", landscape: true }));
  });

  it("requires both attachment fields together and in their form", () => {
    expect(errorsOf(image({ attachmentSha256: undefined }))).toEqual(
      at(".attachmentSha256", "IMAGE_ATTACHMENT_INVALID"),
    );
    expect(errorsOf(bareImage({ attachmentSha256: HASH }))).toEqual(
      at(".attachmentId", "IMAGE_ATTACHMENT_INVALID"),
    );
    for (const hash of [HASH.toUpperCase().replace(/0/g, "A"), "0".repeat(63), 1]) {
      expect(errorsOf(image({ attachmentSha256: hash }))).toEqual(
        at(".attachmentSha256", "IMAGE_ATTACHMENT_INVALID"),
      );
    }
    for (const id of [F.toUpperCase(), "00000000-0000-0000-0000-000000000000", ""]) {
      expect(errorsOf(image({ attachmentId: id }))).toEqual(
        at(".attachmentId", "IMAGE_ATTACHMENT_INVALID"),
      );
    }
    expect(errorsOf(image({ img: "data:image/png;base64,AAAA" }))).toEqual(
      at(".img", "UNKNOWN_FIELD"),
    );
  });

  it("refuses a crop without attachment, of all zeros, over 45, partial or fractional", () => {
    expect(errorsOf(bareImage({ crop: crop(10, 0, 0, 0) }))).toEqual(
      at(".crop", "IMAGE_CROP_INVALID"),
    );
    for (const value of [
      crop(0, 0, 0, 0),
      crop(46, 0, 0, 0),
      crop(-1, 0, 0, 0),
      crop(10.5, 0, 0, 0),
      { left: 10 },
      [10, 0, 0, 0],
    ]) {
      expect(errorsOf(image({ crop: value }))).toEqual(at(".crop", "IMAGE_CROP_INVALID"));
    }
    expect(errorsOf(image({ crop: { ...crop(10, 0, 0, 0), middle: 1 } }))).toEqual(
      at(".crop.middle", "UNKNOWN_FIELD"),
    );
  });

  it("refuses a width outside 20 to 100 or not an integer, and an unknown alignment", () => {
    for (const widthPercent of [19, 101, 60.5, "60", -0]) {
      expect(errorsOf(image({ widthPercent }))).toEqual(
        at(".widthPercent", "IMAGE_LAYOUT_INVALID"),
      );
    }
    for (const align of ["centre", "c", undefined]) {
      expect(errorsOf(image({ align }))).toEqual(at(".align", "IMAGE_LAYOUT_INVALID"));
    }
    expect(errorsOf(image({ landscape: "false" }))).toEqual(at(".landscape", "BLOCK_FLAG_INVALID"));
    expect(errorsOf(image({ title: "" }))).toEqual(at(".title", "FIGURE_TITLE_INVALID"));
  });
});

describe("cover (§7, class 59)", () => {
  it("accepts each field up to its limit, alone or together", () => {
    accepts(
      doc({ cover: { study: "x".repeat(200), place: "x".repeat(100), date: "x".repeat(50) } }),
    );
    accepts(doc({ cover: { date: "studeni 2026." } }));
    accepts(doc({ cover: { place: "Zagreb", study: "Diplomski studij politologije" } }));
  });

  it("refuses an empty cover, a field over its limit or untidy, and an unknown field", () => {
    for (const cover of [{}, [], "Zagreb", null]) {
      expect(errorsOf(doc({ cover }))).toEqual([["$.cover", "COVER_INVALID"]]);
    }
    for (const [key, value] of [
      ["study", "x".repeat(201)],
      ["place", "x".repeat(101)],
      ["date", "x".repeat(51)],
      ["place", "Zagreb "],
      ["date", ""],
    ] as const) {
      expect(errorsOf(doc({ cover: { [key]: value } }))).toEqual([
        [`$.cover.${key}`, "COVER_FIELD_INVALID"],
      ]);
    }
    expect(errorsOf(doc({ cover: { place: "Zagreb", student: "Student A" } }))).toEqual([
      ["$.cover.student", "UNKNOWN_FIELD"],
    ]);
  });
});
