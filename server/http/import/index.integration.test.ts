// POST /api/v1/works/{documentId}/imports and .../imports/{importId}/confirm
// (SRV-1803) on a real server with the real pipeline over a scripted
// transaction: the answers, the order of the checks before the database and
// the closed refusals. The database itself is db/main/tests/208-import-event.sql
// and import.pg.integration.test.ts. All values are invented.
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createImportRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-11-21T09:00:00.000Z");
const IMPORT_ID = "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c";
const EVENT_ID = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const HASH = "4f".repeat(32);
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function docx(text: string, extra: Record<string, Uint8Array> = {}): string {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `${HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
      ...extra,
    }),
  ).toString("base64");
}

const query = vi.fn<ActorTransaction["query"]>();
const withActor: WithActor = (_token, run) => run({ query: query as ActorTransaction["query"] });
let server: Running;

beforeEach(async () => {
  query.mockReset();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createImportRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const base = () => `http://127.0.0.1:${server.port}/api/v1/works/izmisljeni-rad/imports`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...cookie, ...headers },
    body,
  });
const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
const upload = (fileBase64: string, fileName: string | null = "Seminar.docx") =>
  post(base(), JSON.stringify({ fileBase64, fileName }));

async function pdf(variant: "text" | "empty" | "javascript"): Promise<string> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  if (variant !== "empty") {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("Izmisljeni PDF rad.", { font, x: 30, y: 70 });
  }
  if (variant === "javascript") document.addJavaScript("Izmisljena radnja", "");
  return Buffer.from(await document.save()).toString("base64");
}

it("prepares and confirms a PDF through the same upload routes", async () => {
  query
    .mockResolvedValueOnce(rows([{ outcome: "allowed" }]))
    .mockResolvedValueOnce(rows([{ outcome: "prepared", baseRevision: "4", preparedAt: AT }]))
    .mockResolvedValueOnce(rows([{ outcome: "confirmed", eventId: EVENT_ID }]));
  const response = await upload(await pdf("text"), "Izmisljeni rad.pdf");
  expect(response.status).toBe(201);
  const preview = (await response.json()) as { importId: string; manifestSha256: string };
  expect(preview).toMatchObject({
    source: "import",
    evidenceKind: "imported",
    fileFormat: "pdf",
    traces: [],
    content: { nodes: [{ children: [{ text: "Izmisljeni PDF rad." }] }] },
  });
  const [, , manifestText, hash] = query.mock.calls[1]![1]!;
  const manifest = JSON.parse(String(manifestText)) as Record<string, unknown>;
  expect(manifest).toMatchObject({ fileFormat: "pdf", importKind: "file-upload" });
  expect(manifest).not.toHaveProperty("traces");
  expect(hash).toBe(preview.manifestSha256);
  const confirmed = await confirm(
    { importId: preview.importId, manifestSha256: preview.manifestSha256 },
    preview.importId,
  );
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ importId: preview.importId, eventId: EVENT_ID });
}, 20_000);

it.each([
  ["empty", "pdf_no_text_layer"],
  ["javascript", "invalid_document"],
] as const)(
  "refuses %s PDF before preparing it",
  async (variant, code) => {
    query.mockResolvedValueOnce(rows([{ outcome: "allowed" }]));
    const response = await upload(await pdf(variant));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: code });
    expect(query).toHaveBeenCalledTimes(1);
  },
  20_000,
);

it("applies the student's import gate before reading a PDF", async () => {
  query.mockResolvedValueOnce(rows([{ outcome: "not_allowed" }]));
  const response = await upload(await pdf("empty"), "Izmisljeni.pdf");
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "import_not_allowed" });
  expect(query).toHaveBeenCalledTimes(1);
});

it("answers a preview marked imported, after the gate and with the database's revision", async () => {
  query
    .mockResolvedValueOnce(rows([{ outcome: "allowed" }]))
    .mockResolvedValueOnce(rows([{ outcome: "prepared", baseRevision: "4", preparedAt: AT }]));
  const response = await upload(docx("Izmišljeni uvezeni odlomak."), "C:\\Radovi\\Seminar.docx");
  expect(response.status).toBe(201);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    source: "import",
    evidenceKind: "imported",
    fileFormat: "docx",
    fileName: "Seminar.docx",
    baseRevision: 4,
    expiresAt: "2026-11-21T10:00:00.000Z",
    traces: [],
    content: {
      schemaVersion: 2,
      sources: [],
      nodes: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "Izmišljeni uvezeni odlomak.", marks: [] }],
        },
      ],
    },
  });
  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringContaining("collaboration.import_gate($1)"),
    expect.stringContaining("collaboration.prepare_import($1, $2, $3, $4, $5)"),
  ]);
  const [documentId, importId, manifest, manifestSha256, fileName] = query.mock.calls[1]![1]!;
  expect([documentId, importId, manifestSha256, fileName]).toEqual([
    "izmisljeni-rad",
    body.importId,
    body.manifestSha256,
    "Seminar.docx",
  ]);
  expect(manifest).not.toContain("Seminar");
});

it("refuses an import the assignment does not allow with 403, reading no file", async () => {
  query.mockResolvedValueOnce(rows([{ outcome: "not_allowed" }]));
  const response = await upload(Buffer.from("nije docx").toString("base64"));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "import_not_allowed" });
  expect(query).toHaveBeenCalledTimes(1);
});

it("answers 404 for another's work and 401 without a session, before reading", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("izmišljeno"), { code: "ZD403" }));
  expect((await upload(docx("x"))).status).toBe(404);
  const anonymous = await fetch(base(), {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ fileBase64: docx("x"), fileName: null }),
  });
  expect(anonymous.status).toBe(401);
});

it("refuses a file above the contract limit with 413 and a broken or unsafe file with 422", async () => {
  query.mockResolvedValue(rows([{ outcome: "allowed" }]));
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x50).toString("base64");
  const large = await upload(tooLarge);
  expect(large.status).toBe(413);
  expect(await large.json()).toMatchObject({ error: "body_too_large" });
  const broken = await upload(Buffer.from("izmišljeni tekst, nije docx").toString("base64"));
  expect(broken.status).toBe(422);
  expect(await broken.json()).toMatchObject({ error: "invalid_document" });
  const macro = await upload(docx("x", { "word/vbaProject.bin": new Uint8Array([1, 2, 3]) }));
  expect(macro.status).toBe(422);
  expect(await macro.json()).toMatchObject({ error: "invalid_document" });
  // Nothing was prepared: only the gate was asked.
  expect(query.mock.calls.every(([sql]) => String(sql).includes("import_gate"))).toBe(true);
});

it("refuses text that is not standard Base64, another media type and bad JSON", async () => {
  expect((await upload("YWJj\nZA==")).status).toBe(422);
  expect((await post(base(), "{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await post(base(), '{"fileBase64":')).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

const confirmUrl = (id = IMPORT_ID) => `${base()}/${id}/confirm`;
const confirm = (body: Record<string, unknown>, id = IMPORT_ID) =>
  post(confirmUrl(id), JSON.stringify(body));

it("confirms with the one event, the same for a retry", async () => {
  query
    .mockResolvedValueOnce(rows([{ outcome: "confirmed", eventId: EVENT_ID }]))
    .mockResolvedValueOnce(rows([{ outcome: "already-confirmed", eventId: EVENT_ID }]));
  for (let i = 0; i < 2; i += 1) {
    const response = await confirm({ importId: IMPORT_ID, manifestSha256: HASH });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ importId: IMPORT_ID, eventId: EVENT_ID });
  }
  expect(query.mock.calls[0]).toEqual([
    'SELECT outcome, event_id AS "eventId" FROM collaboration.confirm_import($1, $2, $3)',
    ["izmisljeni-rad", IMPORT_ID, HASH],
  ]);
});

it.each([
  ["NOT_FOUND", 404, "import_not_found"],
  ["MANIFEST_MISMATCH", 409, "import_manifest_mismatch"],
  ["EXPIRED", 410, "import_expired"],
  ["IMPORT_NOT_ALLOWED", 403, "import_not_allowed"],
  ["REVISION_CHANGED", 409, "import_revision_changed"],
])("answers %s as %i %s", async (outcome, status, code) => {
  query.mockResolvedValueOnce(rows([{ outcome, eventId: null }]));
  const response = await confirm({ importId: IMPORT_ID, manifestSha256: HASH });
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: code });
});

it("refuses a body whose import is not the path's, and a malformed import id, before the database", async () => {
  const other = "0b5c2a7e-3f1d-4c8e-9a6b-000000000002";
  expect((await confirm({ importId: other, manifestSha256: HASH })).status).toBe(422);
  expect((await confirm({ importId: IMPORT_ID, manifestSha256: HASH }, "nije-uuid")).status).toBe(
    404,
  );
  expect((await confirm({ importId: IMPORT_ID })).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});
