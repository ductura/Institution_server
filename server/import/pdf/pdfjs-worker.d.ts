// PDF.js ships no types for its worker module; only the handler is used
// (server/import/pdf/read-pdf.ts, SRV-1804B).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
