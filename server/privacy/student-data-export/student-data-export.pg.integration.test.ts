// SRV-1308 on a real database: the whole path over SRV-1307's RPCs and the
// worker reads of this task. Boris is appointed the clerk of the registry
// office of fak-a, Iva is its administrator (fixtures/institution.inc). Ana
// and Dora, two students of fak-a, each wrote a note and had their work
// opened by Vesna. Boris requests Ana's export, Iva approves it, the job
// builds and stores the package and marks it ready, and the link hands the
// ZIP out once and then answers 410 (acceptance 2). The package holds Ana's
// note and access log and nothing of Dora (acceptance 3); a second build of
// the same contents gives the same bytes (acceptance 1). All persons, texts
// and references are invented.
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestDatabase, exclusive } from "../../../test-support/database/index.ts";
import {
  LABELS,
  ORIGIN as RECEIPT_ORIGIN,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";
import {
  createStudentDataExports,
  createStudentDataExportWorker,
  type WithActor,
} from "../../database/index.ts";
import {
  createDatabases,
  createLayers,
  createStudentDataExportRoutes,
  startServer,
  studentDataExportStorage,
} from "../../http/index.ts";

import { buildStudentDataExportPackage, runStudentDataExportPass } from "./index.ts";

const institution = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const ORIGIN = "https://ductura.example.invalid";
const BASE = "/api/v1/institution/student-data-exports";
// Session tokens of institution.inc: one letter per person.
const IVA = "C";
const ANA = "D";
const BORIS = "F";
const VESNA = "A";
const LEA = "H";

it("requests, approves, prepares and hands out a student's package once", async () => {
  const db = await createTestDatabase("main", { authority: true });
  const directory = await mkdtemp(join(tmpdir(), "izvoz-podataka-"));
  try {
    await db.exec(institution);
    await db.exec(
      "SELECT app.appoint_registry_clerk(pg_temp.id('boris'), 'Zahtjev referada-a/2026')",
    );
    await db.exec(`
      SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text) VALUES
        (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'Izmišljena bilješka Ane.'),
        (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), 'Izmišljena bilješka Dore.');
      RESET ROLE;
      INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name) VALUES
        (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljena');
      INSERT INTO audit.access_log (institution_id, document_id, assignment_id, owner_id, reader_id, reader_role,
                                    surface, opened_at) VALUES
        (pg_temp.id('fak_a'), 'doc-ana', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'teacher',
         'live_view', '2026-10-19 12:00:00+00'),
        (pg_temp.id('fak_a'), 'doc-dora', pg_temp.id('z1'), pg_temp.id('dora'), pg_temp.id('vesna'), 'teacher',
         'process_summary', '2026-10-20 08:00:00+00');
    `);
    const { rows } = await db.query<{ name: string; val: string }>("SELECT name, val FROM ref");
    const ids = new Map(rows.map(({ name, val }) => [name, val]));
    const as =
      (role: string): WithActor =>
      (token, run) =>
        // One turn on the test's one connection: token, role and calls together.
        exclusive(db, async () => {
          await db.query("SELECT set_config('app.session_token', $1, true)", [token ?? ""]);
          await db.exec(`SET LOCAL ROLE ${role}`);
          try {
            return await run({
              async query<Row>(text: string, values?: readonly unknown[]) {
                const { rows: found } = await db.query<Row>(text, [...(values ?? [])]);
                return { rows: found, rowCount: found.length };
              },
            });
          } finally {
            await db.exec("RESET ROLE");
          }
        });
    const withActor = as("ductus_app");
    const storage = studentDataExportStorage(directory);
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      databases: createDatabases(),
      routes: createStudentDataExportRoutes({
        exports: createStudentDataExports(withActor),
        storage,
        // Session activity is not under test here (the problem-report inbox
        // and legal-hold tests count it).
        recordActivity: async () => undefined,
      }),
    });
    try {
      const call = async (actor: string, method: string, path: string, body?: unknown) => {
        const got = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
          headers: {
            cookie: `__Host-ductus_session=${actor.repeat(43)}`,
            ...(method === "POST"
              ? {
                  origin: ORIGIN,
                  "sec-fetch-site": "same-origin",
                  "content-type": "application/json",
                }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: got.status, body: (await got.json()) as Record<string, unknown> };
      };
      const asked = {
        studentId: ids.get("ana")!,
        identityCheckedBy: "identity_card",
        note: "Provjera 1/2026",
      };

      // Only the clerk requests: the administrator, a teacher and the student are 403.
      for (const actor of [IVA, VESNA, ANA])
        expect((await call(actor, "POST", BASE, asked)).status).toBe(403);
      expect(
        (await call(BORIS, "POST", BASE, { ...asked, studentId: ids.get("tomo") })).status,
      ).toBe(404);
      const made = await call(BORIS, "POST", BASE, asked);
      expect(made.status).toBe(201);
      const exportId = made.body.exportId as string;
      expect((await call(BORIS, "POST", BASE, asked)).status).toBe(409);
      const stored = await db.query<{ ref: string }>(
        "SELECT identity_check_ref AS ref FROM app.student_data_export WHERE id = $1",
        [exportId],
      );
      expect(stored.rows).toEqual([{ ref: "identity_card: Provjera 1/2026" }]);

      // Only another administrator approves; another institution's is 404.
      const approve = `${BASE}/${exportId}/approve`;
      const reference = { reference: "Posao 1/2026" };
      expect((await call(BORIS, "POST", approve, reference)).status).toBe(403);
      expect((await call(LEA, "POST", approve, reference)).status).toBe(404);
      expect(await call(IVA, "POST", approve, reference)).toEqual({
        status: 200,
        body: { exportId, state: "approved" },
      });
      expect((await call(IVA, "POST", approve, reference)).status).toBe(409);

      // The worker prepares the package and hands the token over.
      const links: { token: string }[] = [];
      const worker = createStudentDataExportWorker({
        // The worker reads side by side (Promise.all); each read is one turn,
        // so no RESET ROLE of one lands before another's query.
        query: (text: string, values?: unknown[]) =>
          exclusive(db, async () => {
            await db.exec("SET LOCAL ROLE ductus_worker");
            try {
              return await db.query(text, values ?? []);
            } finally {
              await db.exec("RESET ROLE");
            }
          }),
      } as never);
      const contents = await worker.contents(exportId);
      const pass = await runStudentDataExportPass({
        exports: worker,
        storage,
        deliver: async (link) => void links.push(link),
        origin: RECEIPT_ORIGIN,
        labels: LABELS,
      });
      expect(pass).toEqual({ ready: 1, expired: 0, failures: [] });
      expect(links).toHaveLength(1);

      // The list: the clerk and the administrator see it ready, Ana her own, Lea nothing.
      const listed = await call(BORIS, "GET", BASE);
      expect(listed.body.exports).toEqual([
        {
          exportId,
          state: "ready",
          requestedAt: expect.any(String),
          expiresAt: expect.any(String),
        },
      ]);
      expect((await call(ANA, "GET", BASE)).body.exports).toHaveLength(1);
      expect((await call(LEA, "GET", BASE)).body).toEqual({ exports: [] });

      // SRV-NF7-IZVOZ-STUDENT: who each export is for, with the list's reach.
      // Someone else's request is absent: a teacher of Ana and the
      // administrator of another institution see none.
      const STUDENTS = "/api/v1/institution/student-data-export-students";
      const forAna = { exports: [{ exportId, studentId: ids.get("ana"), state: "ready" }] };
      expect(await call(BORIS, "GET", STUDENTS)).toEqual({ status: 200, body: forAna });
      expect(await call(IVA, "GET", STUDENTS)).toEqual({ status: 200, body: forAna });
      expect(await call(ANA, "GET", STUDENTS)).toEqual({ status: 200, body: forAna });
      for (const actor of [VESNA, LEA])
        expect(await call(actor, "GET", STUDENTS)).toEqual({ status: 200, body: { exports: [] } });

      // The link without a session: the ZIP once, then 410.
      const link = `http://127.0.0.1:${server.port}/api/v1/student/data-export/${links[0]!.token}`;
      const first = await fetch(link);
      expect(first.status).toBe(200);
      const zip = new Uint8Array(await first.arrayBuffer());
      const second = await fetch(link);
      expect(second.status).toBe(410);
      expect(((await second.json()) as { error: string }).error).toBe("not_allowed");

      const files = unzipStored(zip);
      const all = [...files.values()]
        .map((bytes) => Buffer.from(bytes).toString("utf8"))
        .join("\n");
      expect(all).toContain("Izmišljena bilješka Ane.");
      expect(all).toContain("live_view");
      expect(all).not.toContain("Dore");
      expect(all).not.toContain("process_summary");
      expect(all).not.toContain(ids.get("dora"));

      // The same contents give the same bytes.
      if (contents.status !== "ok") throw new Error("contents unavailable");
      const again = await buildStudentDataExportPackage(contents.contents, RECEIPT_ORIGIN, LABELS);
      expect(again.status === "built" && Buffer.from(again.bytes).equals(Buffer.from(zip))).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
