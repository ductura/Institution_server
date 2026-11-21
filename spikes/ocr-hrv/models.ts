import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hrv models are fetched ONCE by `pnpm models` and pinned by SHA-256; the spike itself reads them from
// disk and never touches the network (no CDN at run time). The files are not committed (4 and 14 MB).
export const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "models");

export type ModelName = "fast" | "standard";

export const MODELS: Readonly<Record<ModelName, { url: string; sha256: string; bytes: number }>> = {
  fast: {
    url: "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/hrv.traineddata",
    sha256: "9e515d9832ce259dbab550b1cc6b998f8b929faf2edacaaca981b05adb130571",
    bytes: 4103348,
  },
  standard: {
    url: "https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/hrv.traineddata",
    sha256: "f7555706fe411515018883187a80bf78dcd6aee4cc4fbce84f8c6730ab594735",
    bytes: 13797409,
  },
};

export function modelDir(name: ModelName): string {
  return join(MODELS_DIR, name);
}

export function verifyModel(name: ModelName): void {
  const file = join(modelDir(name), "hrv.traineddata");
  if (!existsSync(file)) throw new Error(`missing ${file}; run "pnpm models" once`);
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (digest !== MODELS[name].sha256) throw new Error(`${file} does not match the pinned digest`);
}

export async function fetchModels(): Promise<void> {
  for (const name of Object.keys(MODELS) as ModelName[]) {
    const { url, sha256 } = MODELS[name];
    const dir = modelDir(name);
    mkdirSync(dir, { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(body).digest("hex") !== sha256)
      throw new Error(`${url}: digest mismatch`);
    writeFileSync(join(dir, "hrv.traineddata"), body);
    console.log(`${name}: ${body.length} bytes ok`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchModels();
