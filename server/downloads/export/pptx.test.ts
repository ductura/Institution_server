import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { messagesHr } from "../../../locales/index.ts";
import {
  slidesSnapshotText,
  type Slide,
  type SlideBlock,
  type SlidesDocument,
} from "../../domain/index.ts";
import {
  buildSlidesExportModel,
  renderSlidesPptx,
  type SlidesExportLabels,
  type SlidesPptx,
} from "./index.ts";

// Every document below is invented.
const LABELS: SlidesExportLabels = messagesHr.slidesExport;
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// A 2x1 PNG header is enough: the writer reads only the signature and the size.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 4, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
]);

const heading = (n: number, slot: SlideBlock["slot"], text: string): SlideBlock => ({
  type: "heading",
  id: id(n),
  slot,
  text,
});
const paragraph = (n: number, slot: SlideBlock["slot"], text: string): SlideBlock => ({
  type: "paragraph",
  id: id(n),
  slot,
  text,
});
const image = (n: number, slot: SlideBlock["slot"], bytes: Uint8Array): SlideBlock => ({
  type: "image",
  id: id(n),
  slot,
  attachmentId: id(n + 1000),
  attachmentSha256: sha(bytes),
  alt: 'Graf "A" & <B>',
});

const SLIDES: Slide[] = [
  {
    id: id(1),
    layout: "title",
    blocks: [
      heading(10, "title", 'Kompost <1> & "gradovi"'),
      paragraph(11, "subtitle", "Demo Student"),
    ],
    notes: "Pozdrav.\nDruga linija",
  },
  {
    id: id(2),
    layout: "titleContent",
    blocks: [
      heading(20, "title", "Uvod"),
      paragraph(21, "body", "a\nb"),
      { type: "list", id: id(22), slot: "body", items: ["jedan", "dva & tri"] },
      image(23, "body", PNG),
    ],
  },
  {
    id: id(3),
    layout: "twoColumns",
    blocks: [
      heading(30, "title", "Dva stupca"),
      paragraph(31, "left", "lijevo"),
      image(32, "right", JPEG),
    ],
    notes: "Samo bilješka",
  },
  { id: id(4), layout: "imageOnly", blocks: [image(40, "image", PNG)] },
  { id: id(5), layout: "titleContent", blocks: [] },
];
const DOC: SlidesDocument = { documentKind: "slides", schemaVersion: 1, slides: SLIDES };
const IMAGES = new Map<string, Uint8Array>([
  [id(1023), PNG],
  [id(1032), JPEG],
  [id(1040), PNG],
]);
const snapshotOf = (doc: SlidesDocument): Uint8Array =>
  new TextEncoder().encode(slidesSnapshotText(doc));

function rendered(result: SlidesPptx): Uint8Array {
  if (result.status !== "rendered") throw new Error(`not rendered: ${result.status}`);
  return result.bytes;
}

function entries(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 22, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const data = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 30 + nameLen + size;
  }
  expect(view.getUint32(at, true)).toBe(0x02014b50);
  return out;
}
const text = (parts: Map<string, Uint8Array>, name: string): string =>
  new TextDecoder().decode(parts.get(name));

/** Well-formedness: every start tag is closed in order and no raw `&` or `<` stays in text. */
function assertWellFormed(xml: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?xml[^>]*\?>/g;
  let last = 0;
  for (const m of xml.matchAll(tag)) {
    const between = xml.slice(last, m.index);
    expect(between).not.toMatch(/[<>]|&(?!(amp|lt|gt|quot|apos);)/);
    last = (m.index ?? 0) + m[0].length;
    if (m[2] === undefined) continue;
    if (m[4] === "/") continue;
    if (m[1] === "/") expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2]);
  }
  expect(xml.slice(last)).toBe("");
  expect(stack).toEqual([]);
}

describe("buildSlidesExportModel", () => {
  const model = buildSlidesExportModel(DOC, LABELS);
  it("takes the title from the first slide that has one and numbers from the order", () => {
    expect(model.title).toBe('Kompost <1> & "gradovi"');
    expect(model.slides.map((s) => [s.number, s.title])).toEqual([
      [1, 'Kompost <1> & "gradovi"'],
      [2, "Uvod"],
      [3, "Dva stupca"],
      [4, "Slajd 4"],
      [5, "Slajd 5"],
    ]);
  });
  it("lists a region for every slot of the layout, empty ones too", () => {
    expect(model.slides[4]?.regions.map((r) => [r.slot, r.blocks.length])).toEqual([
      ["title", 0],
      ["body", 0],
    ]);
    expect(model.slides[1]?.regions[1]?.blocks).toHaveLength(3);
  });
  it("falls back to the presentation label when no slide has a title", () => {
    const empty: SlidesDocument = { ...DOC, slides: [SLIDES[4] as Slide] };
    expect(buildSlidesExportModel(empty, LABELS).title).toBe("Prezentacija");
  });
});

describe("renderSlidesPptx", () => {
  const input = { snapshot: snapshotOf(DOC), images: IMAGES, labels: LABELS };
  const result = renderSlidesPptx(input);
  const bytes = rendered(result);
  const parts = entries(bytes);

  it("gives the same bytes for the same snapshot and images", () => {
    expect(sha(rendered(renderSlidesPptx(input)))).toBe(sha(bytes));
    expect(result.status === "rendered" && result.snapshotSha256).toBe(sha(snapshotOf(DOC)));
  });

  it("changes when a slide changes", () => {
    const other: SlidesDocument = {
      ...DOC,
      slides: [{ ...SLIDES[4]!, blocks: [heading(50, "title", "Novo")] }],
    };
    const changed = rendered(renderSlidesPptx({ ...input, snapshot: snapshotOf(other) }));
    expect(sha(changed)).not.toBe(sha(bytes));
  });

  it("has the package parts of a presentation", () => {
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/theme/theme1.xml",
      "ppt/theme/theme2.xml",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      ...[1, 2, 3, 4].flatMap((n) => [
        `ppt/slideLayouts/slideLayout${n}.xml`,
        `ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`,
      ]),
      "ppt/notesMasters/notesMaster1.xml",
      "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      ...[1, 2, 3, 4, 5].flatMap((n) => [
        `ppt/slides/slide${n}.xml`,
        `ppt/slides/_rels/slide${n}.xml.rels`,
        ...(n === 1 || n === 3
          ? [`ppt/notesSlides/notesSlide${n}.xml`, `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`]
          : []),
      ]),
      "ppt/media/image1.png",
      "ppt/media/image2.jpg",
    ]);
  });

  it("writes only well-formed XML and escapes text", () => {
    for (const [name] of parts) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) assertWellFormed(text(parts, name));
    }
    expect(text(parts, "ppt/slides/slide1.xml")).toContain(
      "Kompost &lt;1&gt; &amp; &quot;gradovi&quot;",
    );
    expect(text(parts, "ppt/slides/slide2.xml")).toContain("dva &amp; tri");
    expect(text(parts, "ppt/slides/slide2.xml")).toContain(
      '<a:t>a</a:t></a:r><a:br/><a:r><a:rPr lang=""/><a:t>b</a:t>'.replace(
        '<a:rPr lang=""/>',
        '<a:rPr lang="" sz="2400"/>',
      ),
    );
    expect(text(parts, "docProps/core.xml")).toContain(
      "<dc:title>Kompost &lt;1&gt; &amp; &quot;gradovi&quot;</dc:title>",
    );
  });

  it("keeps slide order and prints notes only where there are some", () => {
    const presentation = text(parts, "ppt/presentation.xml");
    expect(
      [...presentation.matchAll(/<p:sldId id="(\d+)" r:id="(rId\d+)"/g)].map((m) => m[2]),
    ).toEqual(["rId4", "rId5", "rId6", "rId7", "rId8"]);
    const notes = text(parts, "ppt/notesSlides/notesSlide1.xml");
    expect(notes.indexOf("Pozdrav.")).toBeLessThan(notes.indexOf("Druga linija"));
    expect(text(parts, "ppt/slides/_rels/slide1.xml.rels")).toContain("notesSlide1.xml");
    expect(text(parts, "ppt/slides/_rels/slide2.xml.rels")).not.toContain("notesSlide");
    expect(parts.has("ppt/notesSlides/notesSlide2.xml")).toBe(false);
  });

  it("uses the layout of each slide", () => {
    for (const [n, layout] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 2],
    ] as const) {
      expect(text(parts, `ppt/slides/_rels/slide${n}.xml.rels`)).toContain(
        `slideLayouts/slideLayout${layout}.xml`,
      );
    }
    expect(text(parts, "ppt/slides/slide1.xml")).toContain('<p:ph type="ctrTitle"/>');
    expect(text(parts, "ppt/slides/slide3.xml")).toContain('<p:ph idx="1"/>');
  });

  it("embeds each image once, byte for byte, with alt text and a kept aspect ratio", () => {
    expect(parts.get("ppt/media/image1.png")).toEqual(PNG);
    expect(parts.get("ppt/media/image2.jpg")).toEqual(JPEG);
    expect([...parts.keys()].filter((n) => n.startsWith("ppt/media/"))).toHaveLength(2);
    const slide4 = text(parts, "ppt/slides/slide4.xml");
    expect(slide4).toContain('descr="Graf &quot;A&quot; &amp; &lt;B&gt;"');
    // 2:1 image in a 10972800 x 5943600 box: full width, half as high, centred.
    expect(slide4).toContain('<a:off x="609600" y="685800"/><a:ext cx="10972800" cy="5486400"/>');
    expect(text(parts, "ppt/slides/_rels/slide4.xml.rels")).toContain("../media/image1.png");
    expect(text(parts, "[Content_Types].xml")).toContain('Extension="jpg"');
  });

  it("refuses an image that is missing, replaced or not a picture, and names it", () => {
    const missing = new Map(IMAGES);
    missing.delete(id(1040));
    expect(renderSlidesPptx({ ...input, images: missing })).toEqual({
      status: "image_problem",
      reason: "image_missing",
      attachmentId: id(1040),
    });
    const replaced = new Map(IMAGES).set(id(1040), new Uint8Array([...PNG, 1]));
    expect(renderSlidesPptx({ ...input, images: replaced })).toMatchObject({
      status: "image_problem",
      reason: "image_hash_mismatch",
      attachmentId: id(1040),
    });
    const junk = new Uint8Array([1, 2, 3]);
    const doc: SlidesDocument = {
      ...DOC,
      slides: [{ id: id(9), layout: "imageOnly", blocks: [image(90, "image", junk)] }],
    };
    expect(
      renderSlidesPptx({
        ...input,
        snapshot: snapshotOf(doc),
        images: new Map([[id(1090), junk]]),
      }),
    ).toMatchObject({ status: "image_problem", reason: "image_unsupported" });
  });

  it("refuses a snapshot that is not the exact bytes of a slides document", () => {
    const bad = (snapshot: Uint8Array) =>
      renderSlidesPptx({ ...input, snapshot }).status === "unreadable";
    expect(bad(new TextEncoder().encode("{}"))).toBe(true);
    expect(bad(new TextEncoder().encode(JSON.stringify(DOC, null, 1)))).toBe(true);
    expect(bad(new Uint8Array([0xff, 0xfe]))).toBe(true);
    expect(renderSlidesPptx({ ...input, snapshot: new Uint8Array(3 * 1024 * 1024) })).toEqual({
      status: "unreadable",
      reason: "snapshot_too_large",
    });
  });

  it("renders revision 0 (one empty slide) as a valid package", () => {
    const zero: SlidesDocument = { ...DOC, slides: [SLIDES[4] as Slide] };
    const out = entries(rendered(renderSlidesPptx({ ...input, snapshot: snapshotOf(zero) })));
    expect(out.has("ppt/slides/slide1.xml")).toBe(true);
    expect(out.has("ppt/media/image1.png")).toBe(false);
    expect(text(out, "[Content_Types].xml")).not.toContain("image/png");
  });
});
