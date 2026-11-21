// PDF.js behind a thread (SRV-1804B; import-contract D4): the file is read in
// a worker thread with a memory limit and a time limit, so a broken file
// (endless object references, a stack that grows, a parse that never ends)
// costs one thread, never the server. When the time is up, or the thread dies,
// the answer is PDF_INVALID and the thread is terminated; a result that comes
// in time is the answer of readPdf unchanged. The thread file is
// worker-thread.ts next to this one (the TypeScript source, as in tests and
// `node server/server.ts`) or pdf-import-worker.js next to dist/server.js (the
// bundle, scripts/build/server.ts); the choice is by the file that exists.
//
// This is the only file that may import `Worker` (scripts/lint-rules/dynamic-load.ts):
// it exports only `readPdfInWorker`, and `import.meta.url` stands only in the
// two `new URL` below.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { ImportReadLimitsV1 } from "../../contracts/index.ts";

import { PDF_READ_TIMEOUT_MS, type PdfRead } from "./read-pdf.ts";

const SOURCE_THREAD = new URL("./worker-thread.ts", import.meta.url);
const BUILT_THREAD = new URL("./pdf-import-worker.js", import.meta.url);

/** Memory of the thread (D4): a PDF that needs more is refused as broken. */
const RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
} as const;

const BROKEN: PdfRead = { ok: false, code: "PDF_INVALID" };

export async function readPdfInWorker(
  bytes: Uint8Array,
  limits: ImportReadLimitsV1,
  options: {
    readonly timeoutMs?: number;
    /** For tests: gets a promise of the thread's exit code as soon as it starts. */
    readonly onStart?: (exited: Promise<number>) => void;
  } = {},
): Promise<PdfRead> {
  const timeoutMs = options.timeoutMs ?? PDF_READ_TIMEOUT_MS;
  const url = existsSync(fileURLToPath(SOURCE_THREAD)) ? SOURCE_THREAD : BUILT_THREAD;
  const thread = new Worker(url, {
    // A copy: the caller keeps its bytes.
    workerData: { bytes: new Uint8Array(bytes), limits },
    resourceLimits: RESOURCE_LIMITS,
    stdout: false,
    stderr: false,
  });
  options.onStart?.(new Promise<number>((resolve) => void thread.once("exit", resolve)));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<PdfRead>((resolve) => {
      timer = setTimeout(() => resolve(BROKEN), timeoutMs);
      thread.once("message", (message: PdfRead) => resolve(message));
      thread.once("error", () => resolve(BROKEN));
      thread.once("exit", () => resolve(BROKEN));
    });
  } finally {
    clearTimeout(timer);
    // Also after an answer: the thread ends with its work, terminate() is the sure end.
    await thread.terminate();
  }
}
