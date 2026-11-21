import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createLiveStates, createMentorNotesStore, type WithActor } from "../../database/index.ts";

import {
  createDatabases,
  createLayers,
  createWorkExportRouteFor,
  createWorkPdfRouteFor,
  startServer,
} from "../index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const MENTORSHIP = "00000000-0000-4000-8000-0000000000aa";
const DOC = "doc-a";
const OWNER = "D".repeat(43);
const MENTOR = "B".repeat(43);
const PRIVATE_NOTE = "SRV-1413 marker of an invented private mentor note.";
const WORK_TEXT = "Izmisljeni tekst rada za izvoz.";
const BODY = `{"nodes":[{"children":[{"marks":[],"text":"${WORK_TEXT}","type":"text"}],"id":"00000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}`;

it("exports the student's saved work without the real note stored against its mentorship", async () => {
  const db = await createTestDatabase("main", { authority: true });
  const renderer = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.7\n%%EOF");
    });
  });
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
    expect(await createLiveStates(withActor).publish(OWNER, DOC, null, BODY)).toMatchObject({
      status: "accepted",
    });
    const revision = await db.query<{ outcome: string }>(
      `SELECT pg_temp.call('ana', 'pkg-a', 'demo-export', pg_temp.descriptor(),
                           0, repeat('a', 64), $1, repeat('b', 64)) AS outcome`,
      [BODY],
    );
    expect(revision.rows[0]?.outcome).toBe("reserved");
    await db.exec(`SET LOCAL ROLE ductus_identity;
      INSERT INTO institution.mentorship (id, institution_id, mentor_id, student_id, work_type)
      VALUES ('${MENTORSHIP}', pg_temp.id('fak_a'), pg_temp.id('marko'), pg_temp.id('ana'), 'bachelor_thesis');
      UPDATE institution.assignment SET course_id = NULL, mentorship_id = '${MENTORSHIP}'
      WHERE id = pg_temp.id('z1');
      RESET ROLE;`);
    renderer.listen(0, "127.0.0.1");
    await once(renderer, "listening");
    const address = renderer.address();
    if (address === null || typeof address === "string") throw new Error("no test renderer port");
    const running = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
      routes: [
        createWorkPdfRouteFor({ withActor }, `http://127.0.0.1:${address.port}`),
        createWorkExportRouteFor({ withActor }),
      ],
    });
    try {
      const exportWork = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${running.port}${path}`, {
          headers: { cookie: `__Host-ductus_session=${OWNER}` },
        });
        expect(response.status).toBe(200);
        return Buffer.from(await response.arrayBuffer());
      };
      const pdfPath = `/api/v1/assignments/${ASSIGNMENT}/works/${DOC}/export/pdf`;
      const docxPath = `/api/v1/works/${DOC}/export?format=docx`;
      const pdfBefore = await exportWork(pdfPath);
      const docxBefore = await exportWork(docxPath);
      const store = createMentorNotesStore(withActor);
      const note = await store.create(MENTOR, MENTORSHIP, PRIVATE_NOTE);
      expect(await store.read(MENTOR, MENTORSHIP)).toEqual({ status: "found", notes: [note] });
      expect(await store.read(OWNER, MENTORSHIP)).toEqual({ status: "not_found" });
      const pdfAfter = await exportWork(pdfPath);
      const docxAfter = await exportWork(docxPath);
      expect(pdfAfter.equals(pdfBefore)).toBe(true);
      expect(docxAfter.equals(docxBefore)).toBe(true);
      const pdfExport = JSON.parse(pdfAfter.toString("utf8")) as { docxBase64: string };
      for (const docx of [docxAfter, Buffer.from(pdfExport.docxBase64, "base64")]) {
        expect(docx.toString("utf8")).toContain(WORK_TEXT);
        expect(docx.toString("utf8")).not.toContain(PRIVATE_NOTE);
      }
    } finally {
      await running.close();
    }
  } finally {
    renderer.close();
    await db.close();
  }
});
