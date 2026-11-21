// SRV-1803 acceptance on the real RPCs in PostgreSQL, through the HTTP routes:
// (2) a work whose assignment does not allow import answers 403; (3) a file
// above the contract limit answers 413; (4) the imported text is marked
// evidenceKind imported and source import; plus the idempotent confirmation
// with one event and the refusals of another student. (1), append only, is
// db/main/tests/208-import-event.sql. Every person, document and text is
// invented; the documents are those of the shared pgTAP fixture.
import { readFileSync } from "node:fs";

import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createImportRoutesFor } from "./index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "D".repeat(43); // Ana, owner of doc-a
const OTHER_STUDENT = "E".repeat(43); // Dora, in K1 too
const TEACHER = "A".repeat(43); // Vesna, teacher of K1
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

const DOCX = Buffer.from(
  zipSync({
    "[Content_Types].xml": strToU8(
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `${HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Izmišljeni seminar</w:t></w:r></w:p><w:p><w:r><w:t>Uvezeni izmišljeni odlomak.</w:t></w:r></w:p></w:body></w:document>`,
    ),
  }),
).toString("base64");

async function pdf(): Promise<string> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("Izmisljeni PDF odlomak.", { font, x: 30, y: 70 });
  return Buffer.from(await document.save()).toString("base64");
}

it.each(["docx", "pdf"] as const)(
  "imports and confirms %s with the student gate",
  async (fileFormat) => {
    const fileBase64 = fileFormat === "docx" ? DOCX : await pdf();
    const fileName = `Seminar.${fileFormat}`;
    const nodes =
      fileFormat === "docx"
        ? [
            { type: "heading", level: 1, children: [{ text: "Izmišljeni seminar" }] },
            { type: "paragraph", children: [{ text: "Uvezeni izmišljeni odlomak." }] },
          ]
        : [{ type: "paragraph", children: [{ text: "Izmisljeni PDF odlomak." }] }];
    const db = await createTestDatabase("main", { authority: true });
    try {
      await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
      await db.exec(
        readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
          /^\\ir institution\.inc\r?\n/mu,
          "",
        ),
      );
      const withActor: WithActor = async (token, run) => {
        await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
        await db.exec("SET LOCAL ROLE ductus_app");
        try {
          return await run({
            async query<Row>(sql: string, args?: readonly unknown[]) {
              const { rows } = await db.query<Row>(sql, [...(args ?? [])]);
              return { rows, rowCount: rows.length };
            },
          });
        } finally {
          await db.exec("RESET ROLE");
        }
      };
      const server = await startServer({
        host: "127.0.0.1",
        port: 0,
        layers: createLayers({ expectedOrigin: ORIGIN }),
        databases: createDatabases(),
        routes: createImportRoutesFor({ withActor }),
      });
      try {
        const url = `http://127.0.0.1:${server.port}/api/v1/works/doc-a/imports`;
        const post = (token: string, target: string, body: unknown) =>
          fetch(target, {
            method: "POST",
            headers: {
              origin: ORIGIN,
              "content-type": "application/json",
              cookie: `__Host-ductus_session=${token}`,
            },
            body: JSON.stringify(body),
          });

        // (4) the preview: imported text over the database's revision.
        const prepared = await post(STUDENT, url, { fileBase64, fileName });
        expect(prepared.status).toBe(201);
        const preview = (await prepared.json()) as Record<string, unknown> & {
          importId: string;
          manifestSha256: string;
        };
        expect(preview).toMatchObject({
          source: "import",
          evidenceKind: "imported",
          baseRevision: 0,
          fileFormat,
          fileName,
          content: { nodes },
        });
        const stored = await db.query<{
          manifestSha256: string;
          fileName: string;
          fileFormat: string;
        }>(
          'SELECT manifest_sha256 AS "manifestSha256", file_name AS "fileName", file_format AS "fileFormat" FROM collaboration.import_event',
        );
        expect(stored.rows).toEqual([
          { manifestSha256: preview.manifestSha256, fileName, fileFormat },
        ]);

        // Only the student owner imports.
        for (const token of [OTHER_STUDENT, TEACHER]) {
          expect((await post(token, url, { fileBase64, fileName: null })).status).toBe(404);
        }

        // The idempotent confirmation: one event, the same for a retry; another student finds nothing.
        const confirmUrl = `${url}/${preview.importId}/confirm`;
        const body = { importId: preview.importId, manifestSha256: preview.manifestSha256 };
        expect((await post(OTHER_STUDENT, confirmUrl, body)).status).toBe(404);
        const first = await post(STUDENT, confirmUrl, body);
        expect(first.status).toBe(200);
        const event = ((await first.json()) as { eventId: string }).eventId;
        const again = await post(STUDENT, confirmUrl, body);
        expect(await again.json()).toEqual({ importId: preview.importId, eventId: event });
        const mismatch = await post(STUDENT, confirmUrl, {
          ...body,
          manifestSha256: "0".repeat(64),
        });
        expect(mismatch.status).toBe(409);
        const events = await db.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM collaboration.import_confirmation",
        );
        expect(events.rows).toEqual([{ n: 1 }]);

        // (3) a file one byte above the contract limit.
        const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x50).toString("base64");
        expect((await post(STUDENT, url, { fileBase64: tooLarge, fileName: null })).status).toBe(
          413,
        );

        // (2) the assignment's new version turns import off: 403, nothing prepared.
        await db.exec(`
        INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
          opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
        VALUES ('00000000-0000-4000-8000-0000000000a1', 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', now(),
          now() + interval '30 days', 'partially_allowed', '{proofreading}', 'extended', false,
          (SELECT created_by FROM institution.assignment WHERE id = '00000000-0000-4000-8000-0000000000a1'));
        UPDATE institution.assignment SET current_version = 3 WHERE id = '00000000-0000-4000-8000-0000000000a1';
      `);
        const refused = await post(STUDENT, url, { fileBase64, fileName: null });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: "import_not_allowed" });
        const count = await db.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM collaboration.import_event",
        );
        expect(count.rows).toEqual([{ n: 1 }]);
      } finally {
        await server.close();
      }
    } finally {
      await db.close();
    }
  },
);
