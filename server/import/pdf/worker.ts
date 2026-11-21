import { existsSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import type { ImportReadLimitsV1 } from "../../contracts/index.ts";

import { readPdf, type PdfRead } from "./read-pdf.ts";
import { waitForPdfWorker } from "./worker-result.ts";

type PdfWorkerInput = { bytes: Uint8Array; limits: ImportReadLimitsV1 };
type PdfWorkerData = PdfWorkerInput & { kind: "ductura-pdf-import" };

const PDF_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_PDF_WORKERS = 2;
const PDF_WORKER_MEMORY = { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 };
let activeWorkers = 0;

export async function readPdfInWorker(
  input: PdfWorkerInput,
): Promise<PdfRead | { ok: false; code: "PDF_BUSY" }> {
  if (activeWorkers >= MAX_CONCURRENT_PDF_WORKERS) return { ok: false, code: "PDF_BUSY" };
  activeWorkers += 1;
  try {
    const bundled = new URL("./pdf-import-worker.js", import.meta.url);
    const source = new URL("./worker.ts", import.meta.url);
    const url = existsSync(bundled) ? bundled : source;
    const data: PdfWorkerData = { ...input, kind: "ductura-pdf-import" };
    const worker = new Worker(url, {
      workerData: data,
      resourceLimits: PDF_WORKER_MEMORY,
      env: {},
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return await waitForPdfWorker(worker, PDF_TIMEOUT_MS);
  } finally {
    activeWorkers -= 1;
  }
}

const input = workerData as PdfWorkerData | undefined;
if (!isMainThread && parentPort !== null && input?.kind === "ductura-pdf-import") {
  parentPort.postMessage(await readPdf(input.bytes, input.limits));
}
