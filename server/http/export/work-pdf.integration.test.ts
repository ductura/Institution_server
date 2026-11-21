import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createDatabases, createLayers, startServer } from "../index.ts";
import { createWorkPdfRoute } from "./index.ts";
import type { PdfSource } from "./read-source.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const BODY =
  '{"nodes":[{"children":[{"marks":[],"text":"Izmišljeni tekst rada.","type":"text"}],"id":"00000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}';
const PDF = Buffer.from("%PDF-1.7\n%%EOF");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const OWNER = "A".repeat(43);
const MENTOR = "B".repeat(43);
const NO_ACCESS = "C".repeat(43);
const ENDED = "D".repeat(43);

it("downloads a private PDF and same-snapshot DOCX only after the reader authorizes the request", async () => {
  const read = vi.fn(async (token: string): Promise<PdfSource> => {
    if (token === ENDED) return { status: "unauthorized" };
    if (![OWNER, MENTOR].includes(token)) return { status: "not_found" };
    return {
      status: "found",
      kind: "saved",
      body: BODY,
      hash: sha(BODY),
      title: "Demo",
      institution: "demo",
      student: "Demo Student",
    };
  });
  const convert = vi.fn(async (_docx: Buffer) => PDF);
  const running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://demo.invalid" }),
    routes: [createWorkPdfRoute(read, convert)],
  });
  const path = `http://127.0.0.1:${running.port}/api/v1/assignments/${ASSIGNMENT}/works/demo-work/export/pdf`;
  const cookie = (token: string) => `__Host-ductus_session=${token}`;
  const get = (token: string) => fetch(path, { headers: { cookie: cookie(token) } });
  try {
    expect((await fetch(path)).status).toBe(401);
    expect(
      (await fetch(path, { headers: { cookie: cookie(OWNER), "sec-fetch-site": "cross-site" } }))
        .status,
    ).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect((await get(NO_ACCESS)).status).toBe(404);
    expect((await get(ENDED)).status).toBe(401);
    expect(convert).not.toHaveBeenCalled();
    for (const token of [OWNER, MENTOR]) {
      const response = await get(token);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        format: "pdf",
        reportHash: null,
        outputSha256: sha(PDF),
        pdfBase64: PDF.toString("base64"),
        noticeKey: "workExport.plainPdf",
        docxBase64: convert.mock.lastCall?.[0].toString("base64"),
      });
      expect(read).toHaveBeenLastCalledWith(token, ASSIGNMENT, "demo-work");
    }
  } finally {
    await running.close();
  }
});
