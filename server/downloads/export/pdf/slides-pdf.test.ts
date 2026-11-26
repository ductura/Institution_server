import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { messagesHr } from "../../../../locales/index.ts";
import { slidesSnapshotText, type SlidesDocument } from "../../../domain/index.ts";
import {
  localSlidesPdfConverter,
  PPTX_TYPE,
  renderSlidesExport,
  slidesBodyKind,
  type ConvertPptx,
} from "./slides-pdf.ts";

// Every document below is invented.
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const DECK: SlidesDocument = {
  documentKind: "slides",
  schemaVersion: 1,
  slides: [
    {
      id: id(1),
      layout: "title",
      blocks: [{ type: "heading", id: id(10), slot: "title", text: "Demo" }],
    },
  ],
};
const BODY = slidesSnapshotText(DECK);
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const labels = messagesHr.slidesExport;
const base = { images: new Map<string, Uint8Array>(), labels };

describe("slidesBodyKind", () => {
  it("tells slides from a text work and a spreadsheet, and lists the images by first use", () => {
    expect(slidesBodyKind(BODY)).toEqual({ kind: "slides", attachmentIds: [] });
    expect(slidesBodyKind(JSON.stringify({ schemaVersion: 4, nodes: [], sources: [] }))).toEqual({
      kind: "not_slides",
    });
    expect(slidesBodyKind(JSON.stringify({ kind: "spreadsheet", sheets: [] }))).toEqual({
      kind: "not_slides",
    });
    expect(slidesBodyKind("[]")).toEqual({ kind: "not_slides" });
    expect(slidesBodyKind("null")).toEqual({ kind: "not_slides" });
    expect(slidesBodyKind("nije json")).toEqual({ kind: "unreadable", reason: "body_not_json" });
    const image = (n: number) => ({ type: "image", attachmentId: id(n) });
    const deck = {
      documentKind: "slides",
      slides: [{ blocks: [image(5), { type: "paragraph" }, image(6), image(5)] }, null, {}],
    };
    expect(slidesBodyKind(JSON.stringify(deck))).toEqual({
      kind: "slides",
      attachmentIds: [id(5), id(6)],
    });
  });
});

describe("renderSlidesExport", () => {
  it("returns the .pptx without the converter and the snapshot hash of the text", async () => {
    const result = await renderSlidesExport({
      ...base,
      body: BODY,
      format: "pptx",
      convert: undefined,
    });
    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") return;
    expect(Buffer.from(result.bytes).subarray(0, 2).toString()).toBe("PK");
    expect(result.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("converts exactly the .pptx it made and keeps the snapshot hash", async () => {
    const convert = vi.fn<ConvertPptx>(async () => PDF);
    const pptx = await renderSlidesExport({ ...base, body: BODY, format: "pptx", convert });
    const pdf = await renderSlidesExport({ ...base, body: BODY, format: "pdf", convert });
    if (pptx.status !== "rendered" || pdf.status !== "rendered") throw new Error("not rendered");
    expect(pdf.format).toBe("pdf");
    expect(pdf.snapshotSha256).toBe(pptx.snapshotSha256);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert.mock.calls[0]![0].equals(Buffer.from(pptx.bytes))).toBe(true);
  });

  it("keeps a missing converter, a timeout, a failure and a non-PDF apart", async () => {
    const run = (convert: ConvertPptx | undefined) =>
      renderSlidesExport({ ...base, body: BODY, format: "pdf", convert });
    expect(await run(undefined)).toEqual({ status: "pdf_unavailable" });
    expect(
      await run(() => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" }))),
    ).toEqual({ status: "pdf_timeout" });
    expect(
      await run(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }))),
    ).toEqual({ status: "pdf_timeout" });
    expect(await run(() => Promise.reject(new Error("x")))).toEqual({ status: "pdf_failed" });
    expect(await run(async () => Buffer.from("PK nije pdf"))).toEqual({ status: "pdf_failed" });
    const hostile = {
      get name(): string {
        throw new Error("izmišljeno");
      },
    };
    expect(await run(() => Promise.reject(hostile))).toEqual({ status: "pdf_failed" });
  });

  it("does not call the converter for a work that is not slides or a deck it cannot read", async () => {
    const convert = vi.fn<ConvertPptx>(async () => PDF);
    const text = JSON.stringify({ schemaVersion: 4, nodes: [], sources: [] });
    expect(await renderSlidesExport({ ...base, body: text, format: "pdf", convert })).toEqual({
      status: "not_slides",
    });
    expect(
      await renderSlidesExport({ ...base, body: "nije json", format: "pdf", convert }),
    ).toEqual({ status: "unreadable", reason: "body_not_json" });
    // Declares itself as slides but is not the canonical text of a valid deck.
    const loose = JSON.stringify(DECK, null, 2);
    expect(await renderSlidesExport({ ...base, body: loose, format: "pdf", convert })).toEqual({
      status: "unreadable",
      reason: "snapshot_invalid",
    });
    expect(convert).not.toHaveBeenCalled();
  });

  it("stops on an image the deck binds and the store cannot give", async () => {
    const withImage: SlidesDocument = {
      documentKind: "slides",
      schemaVersion: 1,
      slides: [
        {
          id: id(2),
          layout: "imageOnly",
          blocks: [
            {
              type: "image",
              id: id(20),
              slot: "image",
              attachmentId: id(21),
              attachmentSha256: "a".repeat(64),
              alt: "Graf",
            },
          ],
        },
      ],
    };
    const convert = vi.fn<ConvertPptx>(async () => PDF);
    const result = await renderSlidesExport({
      ...base,
      body: slidesSnapshotText(withImage),
      format: "pdf",
      convert,
    });
    expect(result).toEqual({
      status: "image_problem",
      reason: "image_missing",
      attachmentId: id(21),
    });
    expect(convert).not.toHaveBeenCalled();
  });
});

describe("localSlidesPdfConverter", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1] & object): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("takes only a loopback origin", () => {
    for (const origin of [
      undefined,
      "",
      "https://127.0.0.1:3000",
      "http://example.invalid:3000",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://127.0.0.1:3000/path",
      "http://10.0.0.1:3000",
    ]) {
      expect(localSlidesPdfConverter(origin)).toBeUndefined();
    }
    expect(localSlidesPdfConverter("http://127.0.0.1:3000")).toBeTypeOf("function");
    expect(localSlidesPdfConverter("http://[::1]:3000")).toBeTypeOf("function");
  });

  it("posts the .pptx as work.pptx and returns the PDF", async () => {
    let seen: { url: string | undefined; type: string | undefined; body: Buffer } | undefined;
    const origin = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen = {
          url: request.url,
          type: request.headers["content-type"],
          body: Buffer.concat(chunks),
        };
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(PDF);
      });
    });
    const convert = localSlidesPdfConverter(origin)!;
    const pptx = Buffer.from("PK\u0003\u0004 izmišljeno");
    expect((await convert(pptx)).equals(PDF)).toBe(true);
    expect(seen?.url).toBe("/forms/libreoffice/convert");
    expect(seen?.type).toMatch(/^multipart\/form-data; boundary=/u);
    const text = seen!.body.toString("latin1");
    expect(text).toContain('name="files"; filename="work.pptx"');
    expect(text).toContain(`Content-Type: ${PPTX_TYPE}`);
    expect(text).not.toContain("pdfa");
    expect(seen!.body.includes(pptx)).toBe(true);
  });

  it.each([
    ["an error status", 500, "application/pdf", PDF],
    ["another content type", 200, "text/html", PDF],
    ["bytes that are not a PDF", 200, "application/pdf", Buffer.from("nije pdf")],
  ])("rejects %s", async (_name, status, type, body) => {
    const origin = await listen((_request, response) => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    });
    await expect(localSlidesPdfConverter(origin)!(Buffer.from("PK"))).rejects.toThrow();
  });

  it("rejects with a timeout when the converter does not answer in time", async () => {
    const origin = await listen(() => undefined);
    const converted = localSlidesPdfConverter(origin, { timeoutMs: 50 })!(Buffer.from("PK"));
    await expect(converted).rejects.toMatchObject({ name: "TimeoutError" });
    server!.closeAllConnections();
  });
});
