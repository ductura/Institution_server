// SRV-1804B (import-contract D4): the PDF reader behind a thread, with a time
// limit that ends the thread. Every PDF is built in memory from invented text.
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS } from "../../contracts/index.ts";

import { scannedPdf, textPdf } from "./fixtures.test-support.ts";
import { readPdf } from "./read-pdf.ts";
import { readPdfInWorker } from "./worker.ts";

const LIMITS = IMPORT_READ_LIMITS;
const texts = (read: Awaited<ReturnType<typeof readPdf>>): string[] =>
  read.ok
    ? read.content.nodes.map((n) =>
        "children" in n ? n.children.map((c) => ("text" in c ? c.text : "")).join("") : "",
      )
    : [];

describe("readPdfInWorker", () => {
  it("answers as readPdf does, with the text of the file", async () => {
    const bytes = textPdf([["Izmisljeni naslov", "", "Prvi izmisljeni odlomak."]]);
    const read = await readPdfInWorker(bytes, LIMITS);
    expect(read.ok).toBe(true);
    expect(texts(read)).toEqual(texts(await readPdf(bytes, LIMITS)));
    expect(texts(read)).toContain("Prvi izmisljeni odlomak.");
  });

  it("gives the refusal codes of readPdf, also for a scan and a broken file", async () => {
    expect(await readPdfInWorker(scannedPdf(), LIMITS)).toEqual({
      ok: false,
      code: "PDF_NO_TEXT_LAYER",
    });
    expect(await readPdfInWorker(new Uint8Array(0), LIMITS)).toEqual({
      ok: false,
      code: "FILE_EMPTY",
    });
    const broken = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 99 >>\nxxxx\n"));
    expect(await readPdfInWorker(broken, LIMITS)).toEqual({ ok: false, code: "PDF_INVALID" });
  });

  it("leaves the caller's bytes whole", async () => {
    const bytes = textPdf([["Izmisljeni tekst."]]);
    const before = Buffer.from(bytes).toString("hex");
    await readPdfInWorker(bytes, LIMITS);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(bytes).toString("hex")).toBe(before);
  });

  it("ends the thread after its answer", async () => {
    let exited: Promise<number> | undefined;
    await readPdfInWorker(textPdf([["Izmisljeni tekst."]]), LIMITS, {
      onStart: (p) => void (exited = p),
    });
    expect(exited).toBeDefined();
    await expect(exited).resolves.toBeTypeOf("number");
  });

  it("answers PDF_INVALID when the time is up and terminates the thread", async () => {
    let exited: Promise<number> | undefined;
    const started = Date.now();
    const read = await readPdfInWorker(textPdf([["Izmisljeni tekst."]]), LIMITS, {
      timeoutMs: 1,
      onStart: (p) => void (exited = p),
    });
    expect(read).toEqual({ ok: false, code: "PDF_INVALID" });
    // terminate() was awaited: the thread is gone by the time the answer is out.
    await expect(exited).resolves.toBeTypeOf("number");
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
