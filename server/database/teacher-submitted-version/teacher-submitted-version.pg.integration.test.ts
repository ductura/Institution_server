import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../index.ts";

import { createTeacherSubmittedVersion } from "./index.ts";

// F4-NAS-R20-SRV: the course teacher's read of the submitted revision against the
// migrated database, not a mock: the real app.teacher_work_get, app.assignment_submissions
// and collaboration.read_live_state decide. Ana (student of K1) owns doc-a of the
// assignment z1 of K1; Vesna teaches K1, Marko teaches K2 (no course of Ana's), Petra and
// Tomo are of another institution. Every person and text is invented.
const fixtures = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`${name}.inc`, fixtures), "utf8");
const document =
  '{"nodes":[{"children":[{"marks":[],"text":"Izmišljeni tekst.","type":"text"}],"id":"a0000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}';

function actingIn(db: TestDatabase): WithActor {
  return async (actor, read) => {
    const { rows } = await db.query<{ token: string }>("SELECT token FROM tok WHERE name = $1", [
      actor,
    ]);
    await db.exec("SET LOCAL ROLE ductus_app");
    try {
      await db.query("SELECT set_config('app.session_token', $1, true)", [rows[0]?.token ?? ""]);
      return await read({
        async query<Row>(sql: string, parameters?: readonly unknown[]) {
          const { rows } = await db.query<Row>(
            sql,
            parameters === undefined ? undefined : [...parameters],
          );
          return { rows, rowCount: rows.length };
        },
      });
    } finally {
      await db.exec("RESET ROLE");
    }
  };
}

it("gives the submitted revision only to a teacher of the course of the work", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(
      fixture("evidence-acceptance").replace(/^\\ir institution\.inc$/mu, () =>
        fixture("institution"),
      ),
    );
    const committed = await db.query<{ outcome: string }>(
      `SELECT pg_temp.call('ana', 'pkg-a', 'zahtjev-a', pg_temp.descriptor(), 0, repeat('a', 64), $1, repeat('b', 64)) AS outcome`,
      [document],
    );
    expect(committed.rows[0]?.outcome).toBe("reserved");
    const recorded = await db.query<{ outcome: string }>(
      `SELECT pg_temp.ask_as('ductus_worker', 'anon', format(
         'SELECT app.worker_record_reconstruction_checkpoint(%L::uuid, %L, 1, %L, %L)',
         '00000000-0000-4000-8000-0000000000d1', 'pkg-a', repeat('b', 64), $1::text)) AS outcome`,
      [document],
    );
    expect(recorded.rows[0]?.outcome).toBe("recorded");

    const route = createTeacherSubmittedVersion(actingIn(db));
    const readAs = (actor: string, revision = 1) => route.get(actor, "doc-a", revision);

    // Not submitted yet: nobody reads a revision as the submission.
    for (const actor of ["vesna", "ana", "marko", "petra", "tomo"]) {
      expect(await readAs(actor)).toEqual({ status: "not_found" });
    }
    expect(await readAs("anon")).toEqual({ status: "unauthenticated" });

    const requested = await db.query<{ outcome: string }>(
      `SELECT pg_temp.ask('ana', 'SELECT outcome FROM app.request_submission(''doc-a'', 1)') AS outcome`,
    );
    expect(requested.rows[0]?.outcome).toBe("requested");
    const submitted = await db.query<{ outcome: string }>(
      `SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
        (SELECT id FROM evidence.submission_request WHERE document_id = 'doc-a'), pg_temp.sha($1))) AS outcome`,
      [document],
    );
    expect(submitted.rows[0]?.outcome).toBe("recorded");

    // The teacher of the course: 200 for the submitted revision, 404 for any other.
    expect(await readAs("vesna")).toMatchObject({
      status: "ok",
      revision: 1,
      body: document,
    });
    expect(await readAs("vesna", 0)).toEqual({ status: "not_found" });
    expect(await readAs("vesna", 2)).toEqual({ status: "not_found" });
    // Another teacher (of another course and of another institution), the student
    // of the work and an unknown work all read the same not_found.
    for (const actor of ["marko", "petra", "tomo", "ana", "lea"]) {
      expect(await readAs(actor)).toEqual({ status: "not_found" });
    }
    expect(await route.get("vesna", "doc-nepostojeci", 1)).toEqual({ status: "not_found" });
    // Vesna's read of the text is logged as a read of the submitted text.
    const logged = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit.access_log WHERE document_id = 'doc-a' AND surface = 'submitted_text'",
    );
    expect(Number(logged.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  } finally {
    await db.close();
  }
});
