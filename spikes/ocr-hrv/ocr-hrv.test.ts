import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGES, extractDates, groundTruth } from "./corpus.ts";
import { measure } from "./metrics.ts";
import { MODELS, verifyModel, type ModelName } from "./models.ts";
import { startOcr } from "./ocr.ts";
import { buildPdf } from "./pdf-make.ts";
import { readTextLayer, renderPages } from "./pdf-read.ts";

test("metrics: perfect text scores zero and a lost diacritic is counted", () => {
  const reference = "Šima Đurđević, 15. 12. 2026.";
  assert.deepEqual(measure(reference, reference), {
    cer: 0,
    diacriticRecall: 1,
    diacriticTotal: 4,
    datesFound: 1,
    datesTotal: 1,
  });
  const broken = measure(reference, "Sima Đurđević, 15. 12. 2026.");
  assert.equal(broken.diacriticRecall, 0.75);
  assert.ok(broken.cer > 0);
  assert.equal(measure(reference, "Šima Đurđević, 15.12.2026.").datesFound, 0);
});

test("corpus: dates are recognised in both numeric and word form", () => {
  assert.deepEqual(extractDates("do 15. 12. 2026. i 12. siječnja 2027. te 3.5.2025."), [
    "15. 12. 2026.",
    "12. siječnja 2027",
    "3.5.2025.",
  ]);
  assert.equal(PAGES.flatMap((page) => extractDates(groundTruth(page))).length, 7);
});

test("corpus: every address is on the reserved .invalid domain", () => {
  for (const page of PAGES)
    for (const address of groundTruth(page).match(/\S+@\S+/gu) ?? [])
      assert.match(address, /\.invalid\b/u);
});

test("text layer: PDF.js returns the exact text, all diacritics and dates, without OCR", async () => {
  const layer = await readTextLayer(await buildPdf());
  assert.equal(layer.length, PAGES.length);
  layer.forEach((page, index) => {
    const metrics = measure(groundTruth(PAGES[index]!), page.text);
    assert.equal(metrics.diacriticRecall, 1);
    assert.equal(metrics.datesFound, metrics.datesTotal);
    assert.ok(metrics.cer < 0.005, `cer ${metrics.cer}`);
  });
});

test("image-only PDF has no text layer, which is the signal to fall back to OCR", async () => {
  const pages = await renderPages(await buildPdf(), 100);
  assert.ok(pages.length === PAGES.length && pages.every((page) => page.png.length > 1000));
  const { default: pdfDocument } = await import("pdfkit");
  const doc = new pdfDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  doc.image(Buffer.from(pages[0]!.png), 0, 0, { width: 595.28 });
  doc.end();
  await finished;
  const layer = await readTextLayer(new Uint8Array(Buffer.concat(chunks)));
  assert.equal(layer[0]!.items, 0);
});

test("models are local and pinned by digest", () => {
  for (const name of Object.keys(MODELS) as ModelName[]) verifyModel(name);
});

for (const model of ["fast", "standard"] as const) {
  test(`OCR ${model}: clean 200 dpi pages keep every diacritic and date, CER under 2 %`, async () => {
    const engine = await startOcr(model);
    try {
      const pages = await renderPages(await buildPdf(), 200);
      for (const [index, page] of pages.entries()) {
        const metrics = measure(
          groundTruth(PAGES[index]!),
          (await engine.recognise(page.png)).text,
        );
        assert.equal(metrics.diacriticRecall, 1);
        assert.equal(metrics.datesFound, metrics.datesTotal);
        assert.ok(metrics.cer < 0.02, `cer ${metrics.cer}`);
      }
    } finally {
      await engine.close();
    }
  });
}
