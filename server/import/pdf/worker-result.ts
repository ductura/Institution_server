import type { PdfRead } from "./read-pdf.ts";

type PdfWorker = {
  once(event: "message", listener: (result: PdfRead) => void): unknown;
  once(event: "error" | "exit", listener: () => void): unknown;
  terminate(): Promise<number>;
};

const INVALID: PdfRead = { ok: false, code: "PDF_INVALID" };

export async function waitForPdfWorker(worker: PdfWorker, timeoutMs: number): Promise<PdfRead> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<PdfRead>((resolve) => {
      timeout = setTimeout(() => resolve(INVALID), timeoutMs);
      worker.once("message", resolve);
      worker.once("error", () => resolve(INVALID));
      worker.once("exit", () => resolve(INVALID));
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}
