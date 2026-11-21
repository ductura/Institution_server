import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Text layer (no OCR) and page rasters through PDF.js, all local: no worker CDN, no fonts from the net.
// Why the same library renders: the OCR input is exactly what a reader sees.

export type PageText = { readonly text: string; readonly items: number };

export async function readTextLayer(data: Uint8Array): Promise<PageText[]> {
  const pdf = await getDocument({
    data: data.slice(),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const pages: PageText[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let text = "";
    let items = 0;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      items += 1;
      text += item.str + (item.hasEOL ? "\n" : "");
    }
    pages.push({ text, items });
  }
  await pdf.destroy();
  return pages;
}

export type Raster = { readonly png: Uint8Array; readonly width: number; readonly height: number };

export type Degrade = { readonly skewDegrees: number; readonly noise: number };

// `degrade` simulates a bad scan on the same canvas (skew, grey paper, seeded sensor noise); no decode/redraw step.
export async function renderPages(
  data: Uint8Array,
  dpi: number,
  degrade?: Degrade,
): Promise<Raster[]> {
  const pdf = await getDocument({ data: data.slice(), isEvalSupported: false, verbosity: 0 })
    .promise;
  const rasters: Raster[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = degrade ? "#f1efe9" : "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const angle = ((degrade?.skewDegrees ?? 0) * Math.PI) / 180;
    const transform = degrade
      ? [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]
      : undefined;
    // PDF.js types want a DOM canvas; the napi canvas has the same drawing surface.
    await page.render({
      canvasContext: context as never,
      viewport,
      canvas: canvas as never,
      ...(transform ? { transform } : {}),
    }).promise;
    if (degrade)
      addNoise(canvas.getContext("2d") as never, canvas.width, canvas.height, degrade.noise);
    rasters.push({
      png: new Uint8Array(canvas.toBuffer("image/png")),
      width: canvas.width,
      height: canvas.height,
    });
  }
  await pdf.destroy();
  return rasters;
}

function addNoise(
  context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  width: number,
  height: number,
  amplitude: number,
): void {
  const pixels = context.getImageData(0, 0, width, height);
  let seed = 1234567;
  for (let index = 0; index < pixels.data.length; index += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 2 ** 32 - 0.5) * amplitude;
    for (let channel = 0; channel < 3; channel += 1) {
      pixels.data[index + channel] = Math.max(
        0,
        Math.min(255, pixels.data[index + channel]! + noise),
      );
    }
  }
  context.putImageData(pixels, 0, 0);
}
