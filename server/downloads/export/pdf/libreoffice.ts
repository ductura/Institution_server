import { randomUUID } from "node:crypto";

import type { ConvertDocx } from "./snapshot-pdf.ts";

const MAX_PDF_BYTES = 16 * 1024 * 1024;

/** The deployment supplies a local Gotenberg endpoint with LibreOffice isolated from egress. */
export function localPdfConverter(origin: string | undefined): ConvertDocx | undefined {
  if (
    origin === undefined ||
    !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(origin)
  ) {
    return undefined;
  }
  const url = URL.parse(`${origin}/forms/libreoffice/convert`);
  if (url === null) return undefined;
  return async (docx, mode) => {
    const boundary = randomUUID();
    const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="work.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`;
    const archive =
      mode === "archive"
        ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="pdfa"\r\n\r\nPDF/A-2b`
        : "";
    const body = Buffer.concat([
      Buffer.from(prefix),
      docx,
      Buffer.from(`${archive}\r\n--${boundary}--\r\n`),
    ]);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (
      !response.ok ||
      response.body === null ||
      response.headers.get("content-type") !== "application/pdf"
    ) {
      await response.body?.cancel();
      throw new Error("PDF conversion failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error("PDF conversion returned too many bytes");
      }
      chunks.push(value);
    }
    const pdf = Buffer.concat(chunks, size);
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-")
      throw new Error("PDF conversion returned no PDF");
    return pdf;
  };
}
