// The thread PDF.js runs in (SRV-1804B, import-contract D4). server/import/pdf/worker.ts
// starts it with the bytes and the limits in `workerData`; it reads the file
// with readPdf and posts the one result back. Loaded anywhere else it throws
// instead of waiting. The thread is built as dist/pdf-import-worker.js next to
// dist/server.js (scripts/build/server.ts). It exports nothing.
//
// Erasable TypeScript only: the thread runs this file in plain node.
import { parentPort, workerData } from "node:worker_threads";

import { readPdf } from "./read-pdf.ts";

type Input = { bytes: Uint8Array; limits: Parameters<typeof readPdf>[1] };

const data: unknown = workerData;
const input = data as Partial<Input> | null;
if (
  parentPort === null ||
  input === null ||
  typeof input !== "object" ||
  !(input.bytes instanceof Uint8Array) ||
  typeof input.limits !== "object" ||
  input.limits === null
) {
  throw new Error("pdf_import_worker_misused");
}
parentPort.postMessage(await readPdf(input.bytes, input.limits));
