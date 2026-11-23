import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createWorkInterviewRoutesFor } from "./index.ts";

// PIL-K-RAZGOVOR-SRV (Ductus#2052): the student's note attached to the
// interview, through the HTTP route and the live database roles. Every person,
// work and file is invented (db/main/tests/fixtures/institution.inc: Vesna (A)
// teaches K1, Ana (D) and Dora (E) are students in K1).
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const VESNA = "A".repeat(43);
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const PATH = "/api/v1/works/doc-a/interview";

it("keeps the owner's note after the invitation and refuses everyone else", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(`SET CONSTRAINTS ALL DEFERRED;
      SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.domain (id, institution_id, region)
        VALUES ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1');
      INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
        VALUES ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'));
      INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
        VALUES ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64));
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
        VALUES ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), repeat('a', 64));
      SET CONSTRAINTS ALL IMMEDIATE;
      RESET ROLE;`);

    // One connection: the calls, the activity touch included, go one after another.
    let queue: Promise<unknown> = Promise.resolve();
    const withActor: WithActor = (token, run) => {
      const next = queue.then(async () => {
        await db.query("SELECT set_config('app.session_token', $1, true)", [token ?? ""]);
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
      });
      queue = next.catch(() => undefined);
      return next;
    };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createWorkInterviewRoutesFor({ withActor }),
    });
    try {
      const call = (method: string, path: string, token: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
          headers: {
            origin: ORIGIN,
            cookie: `__Host-ductus_session=${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const bytes = Buffer.from("Moja bilješka uz razgovor.\n", "utf8");
      const note = {
        fileName: "biljeska.txt",
        mediaType: "text/plain",
        contentBase64: bytes.toString("base64"),
      };
      const attach = (token: string, body: unknown = note) =>
        call("POST", `${PATH}/notes`, token, body);

      // Before the invitation the owner attaches nothing (403).
      expect((await attach(ANA)).status).toBe(403);
      expect(
        (await call("POST", `${PATH}/questions`, VESNA, { questionText: "Kako si radila?" }))
          .status,
      ).toBe(201);
      expect((await attach(ANA)).status).toBe(403);
      expect((await call("POST", `${PATH}/invite`, VESNA)).status).toBe(200);

      // (1) After the invitation the owner keeps a note (201).
      const kept = await attach(ANA);
      expect(kept.status).toBe(201);
      const body = (await kept.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        fileName: "biljeska.txt",
        mediaType: "text/plain",
        byteSize: bytes.length,
        sha256: (
          await db.query<{ h: string }>("SELECT encode(sha256($1::bytea), 'hex') AS h", [bytes])
        ).rows[0]!.h,
      });
      const pdf = await attach(ANA, {
        fileName: "skica.pdf",
        mediaType: "application/pdf",
        contentBase64: Buffer.from("%PDF-1.4\n%izmisljeni\n", "latin1").toString("base64"),
      });
      expect(pdf.status).toBe(201);

      // (2) Another student and the teacher are refused (403).
      expect((await attach(DORA)).status).toBe(403);
      expect((await attach(VESNA)).status).toBe(403);

      const trail = await db.query<{ kinds: string }>(
        "SELECT string_agg(kind, ',' ORDER BY occurred_at, kind) AS kinds FROM audit.work_interview_event",
      );
      expect(trail.rows[0]!.kinds).toBe("invited,note_attached,note_attached");

      // (3) A held interview takes no new note (409).
      expect(
        (
          await call("POST", `${PATH}/held`, VESNA, {
            date: new Date().toISOString().slice(0, 10),
          })
        ).status,
      ).toBe(200);
      const late = await attach(ANA, {
        ...note,
        contentBase64: Buffer.from("Kasna bilješka.").toString("base64"),
      });
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ code: "conflict" });
      const count = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM institution.work_interview_note",
      );
      expect(count.rows[0]!.n).toBe(2);
    } finally {
      await server.close();
      await queue;
    }
  } finally {
    await db.close();
  }
});
