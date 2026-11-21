import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createWorker } from "tesseract.js";
import { modelDir, verifyModel, type ModelName } from "./models.ts";

const require = createRequire(import.meta.url);
// Everything resolves to local files: worker script, WASM core and language data (no jsdelivr, no tessdata CDN).
const CORE_PATH = dirname(require.resolve("tesseract.js-core/package.json"));

export type OcrResult = { readonly text: string; readonly confidence: number; readonly ms: number };

export type OcrEngine = {
  readonly initMs: number;
  recognise(png: Uint8Array): Promise<OcrResult>;
  close(): Promise<void>;
};

export async function startOcr(model: ModelName): Promise<OcrEngine> {
  verifyModel(model);
  const started = performance.now();
  const worker = await createWorker("hrv", 1, {
    langPath: modelDir(model),
    gzip: false,
    cachePath: modelDir(model),
    cacheMethod: "none",
    corePath: CORE_PATH,
  });
  const initMs = performance.now() - started;
  return {
    initMs,
    async recognise(png) {
      const t0 = performance.now();
      const { data } = await worker.recognize(Buffer.from(png));
      return { text: data.text, confidence: data.confidence, ms: performance.now() - t0 };
    },
    close: async () => {
      await worker.terminate();
    },
  };
}
