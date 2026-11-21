import { createRequire } from "node:module";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PAGES, groundTruth } from "./corpus.ts";
import { measure, type Metrics } from "./metrics.ts";
import { MODELS, type ModelName } from "./models.ts";
import { startOcr } from "./ocr.ts";
import { buildPdf } from "./pdf-make.ts";
import { readTextLayer, renderPages, type Degrade } from "./pdf-read.ts";

const require = createRequire(import.meta.url);

export type Row = {
  readonly source: string;
  readonly page: string;
  readonly metrics: Metrics;
  readonly ms: number;
  readonly confidence?: number;
};

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

export async function runBenchmark(): Promise<{
  rows: Row[];
  initMs: Record<ModelName, number>;
  imageOnlyTextItems: number;
}> {
  const rows: Row[] = [];
  const pdf = await buildPdf();

  // 1. text layer (PDF.js), 5 runs, median
  const layerRuns: { text: string; ms: number }[][] = [];
  for (let run = 0; run < 5; run += 1) {
    const t0 = performance.now();
    const pages = await readTextLayer(pdf);
    const ms = (performance.now() - t0) / pages.length;
    layerRuns.push(pages.map((page) => ({ text: page.text, ms })));
  }
  PAGES.forEach((page, index) => {
    rows.push({
      source: "text layer (PDF.js)",
      page: page.id,
      metrics: measure(groundTruth(page), layerRuns[0]![index]!.text),
      ms: median(layerRuns.map((run) => run[index]!.ms)),
    });
  });

  // 2. OCR on rasters, both models
  const conditions: { name: string; dpi: number; bad?: Degrade }[] = [
    { name: "100 dpi", dpi: 100 },
    { name: "150 dpi", dpi: 150 },
    { name: "200 dpi", dpi: 200 },
    { name: "300 dpi", dpi: 300 },
    { name: "200 dpi, skos 2°, šum 120", dpi: 200, bad: { skewDegrees: 2, noise: 120 } },
    { name: "100 dpi, skos 2°, šum 120", dpi: 100, bad: { skewDegrees: 2, noise: 120 } },
  ];
  const rasters = new Map<string, Uint8Array[]>();
  for (const condition of conditions) {
    const pages = await renderPages(pdf, condition.dpi, condition.bad);
    rasters.set(
      condition.name,
      pages.map((page) => page.png),
    );
  }
  const initMs = {} as Record<ModelName, number>;
  for (const model of Object.keys(MODELS) as ModelName[]) {
    const engine = await startOcr(model);
    initMs[model] = engine.initMs;
    for (const condition of conditions) {
      for (const [index, png] of rasters.get(condition.name)!.entries()) {
        const result = await engine.recognise(png);
        rows.push({
          source: `OCR ${model}, ${condition.name}`,
          page: PAGES[index]!.id,
          metrics: measure(groundTruth(PAGES[index]!), result.text),
          ms: result.ms,
          confidence: result.confidence,
        });
      }
    }
    await engine.close();
  }

  // 3. an image-only PDF has no text layer: that is the signal to fall back to OCR
  const pages = await renderPages(pdf, 150);
  const { default: pdfDocument } = await import("pdfkit");
  const doc = new pdfDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  pages.forEach((page, index) => {
    if (index > 0) doc.addPage();
    doc.image(Buffer.from(page.png), 0, 0, { width: 595.28 });
  });
  doc.end();
  await finished;
  const imageOnly = await readTextLayer(new Uint8Array(Buffer.concat(chunks)));
  return { rows, initMs, imageOnlyTextItems: imageOnly.reduce((sum, page) => sum + page.items, 0) };
}

function dirSize(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce(
    (sum, entry) =>
      sum +
      (entry.isDirectory()
        ? dirSize(join(path, entry.name))
        : statSync(join(path, entry.name)).size),
    0,
  );
}

// What would ship: files the code reads at run time, not the whole node_modules tree.
export function bundleSizes(): Record<string, number> {
  const tesseract = dirname(require.resolve("tesseract.js/package.json"));
  const core = dirname(require.resolve("tesseract.js-core/package.json"));
  const pdfjs = dirname(require.resolve("pdfjs-dist/package.json"));
  const size = (path: string): number => statSync(path).size;
  return {
    "tesseract.js (src + dist worker)":
      dirSize(join(tesseract, "src")) + size(join(tesseract, "dist/worker.min.js")),
    "WASM jezgra, SIMD LSTM (.wasm.js)": size(join(core, "tesseract-core-simd-lstm.wasm.js")),
    "WASM jezgra, LSTM bez SIMD-a (.wasm.js)": size(join(core, "tesseract-core-lstm.wasm.js")),
    "PDF.js legacy (pdf.mjs + pdf.worker.mjs)":
      size(join(pdfjs, "legacy/build/pdf.mjs")) + size(join(pdfjs, "legacy/build/pdf.worker.mjs")),
    "model hrv fast": MODELS.fast.bytes,
    "model hrv standard": MODELS.standard.bytes,
  };
}

if (process.argv[1]?.endsWith("benchmark.ts")) {
  const result = await runBenchmark();
  const sizes = bundleSizes();
  writeFileSync(
    new URL("./results.json", import.meta.url),
    `${JSON.stringify({ ...result, sizes }, null, 2)}\n`,
  );
  const pct = (value: number): string => `${(value * 100).toFixed(2)} %`;
  console.log(
    "| Izvor | Stranica | CER | Dijakritici | Datumi | ms | Pouzdanost |\n|---|---|---:|---:|---:|---:|---:|",
  );
  for (const row of result.rows) {
    const { metrics } = row;
    console.log(
      `| ${row.source} | ${row.page} | ${pct(metrics.cer)} | ${metrics.diacriticRecall === 1 ? "100 %" : pct(metrics.diacriticRecall)} (${metrics.diacriticTotal}) | ${metrics.datesFound}/${metrics.datesTotal} | ${Math.round(row.ms)} | ${row.confidence ?? "-"} |`,
    );
  }
  console.log("init ms", result.initMs, "image-only text items", result.imageOnlyTextItems);
  console.log(sizes);
}
