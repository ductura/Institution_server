import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../../test-support/database/index.ts";
import { createWorkVersionsReader, type WithActor } from "../../database/index.ts";
import { STORAGE_NOT_CONFIGURED } from "../index.ts";

import { createTimeMachineStore } from "./store.ts";

const fixtures = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`${name}.inc`, fixtures), "utf8");
const document =
  '{"nodes":[{"children":[{"marks":[],"text":"Izmišljeni tekst.","type":"text"}],"id":"a0000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}';

async function setup(db: TestDatabase) {
  await db.exec(
    fixture("evidence-acceptance").replace(/^\\ir institution\.inc$/mu, () =>
      fixture("institution"),
    ),
  );
  await db.exec("SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED");
  await db.exec(fixture("mentorship"));
  await db.exec(`
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
      VALUES ('project-m1', pg_temp.id('fak_a'), pg_temp.id('zm1'), pg_temp.id('ana'));
    INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
      VALUES ('doc-m1', pg_temp.id('fak_a'), 'project-m1', pg_temp.id('ana'), pg_temp.h('a'));
    INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      VALUES ('doc-m1', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), pg_temp.h('a'));
    INSERT INTO evidence.package (id, institution_id, evidence_domain_id, document_id, project_id,
                                  principal_id, evidence_profile_id, max_payload_bytes)
      SELECT 'pkg-m1', institution_id, evidence_domain_id, 'doc-m1', 'project-m1', principal_id,
             evidence_profile_id, max_payload_bytes FROM evidence.package WHERE id = 'pkg-a';
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;
  `);
  const { rows } = await db.query<{ outcome: string }>(
    `SELECT pg_temp.call('ana', 'pkg-m1', 'zahtjev-m1',
       pg_temp.descriptor(p_package => 'pkg-m1', p_document => 'doc-m1', p_segment => 'segment-m1'),
       0, repeat('a', 64), $1, repeat('b', 64)) AS outcome`,
    [document],
  );
  expect(rows[0]?.outcome).toBe("reserved");
  const recorded = await db.query<{ outcome: string }>(
    `SELECT pg_temp.ask_as('ductus_worker', 'anon', format(
       'SELECT app.worker_record_reconstruction_checkpoint(%L::uuid, %L, 1, %L, %L)',
       '00000000-0000-4000-8000-0000000000d1', 'pkg-m1', repeat('b', 64), $1::text)) AS outcome`,
    [document],
  );
  expect(recorded.rows[0]?.outcome).toBe("recorded");
}

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

it("reads an exact checkpoint for the owner and only a submitted revision for the active mentor", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await setup(db);
    const withActor = actingIn(db);
    const store = createTimeMachineStore(withActor, STORAGE_NOT_CONFIGURED);
    const list = createWorkVersionsReader(withActor);
    expect(await store.read("anon", "doc-m1", [1])).toEqual({ status: "unauthenticated" });
    expect(await store.read("ana", "doc-m1", [1])).toMatchObject({
      status: "found",
      snapshots: [{ body: document }],
    });
    expect(await store.read("marko", "doc-m1", [1])).toEqual({ status: "not_found" });
    expect(await store.read("ana", "doc-m1", [1, 2])).toEqual({ status: "not_found" });
    for (const [actor, work] of [
      ["vesna", "doc-a"],
      ["vesna", "doc-m1"],
      ["tomo", "doc-m1"],
    ] as const) {
      expect(await store.read(actor, work, [1])).toEqual({ status: "not_found" });
    }

    const requested = await db.query<{ outcome: string }>(
      `SELECT pg_temp.ask('ana', 'SELECT outcome FROM app.request_submission(''doc-m1'', 1)') AS outcome`,
    );
    expect(requested.rows[0]?.outcome).toBe("requested");
    const submitted = await db.query<{ outcome: string }>(
      `SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
        (SELECT id FROM evidence.submission_request WHERE document_id = 'doc-m1'), pg_temp.sha($1))) AS outcome`,
      [document],
    );
    expect(submitted.rows[0]?.outcome).toBe("recorded");
    const ownerList = await list("ana", "doc-m1", null);
    expect(ownerList).toMatchObject({
      status: "found",
      nextBeforeRevision: null,
    });
    expect(await list("marko", "doc-m1", null)).toEqual(ownerList);
    expect(await store.read("marko", "doc-m1", [1])).toMatchObject({
      status: "found",
      snapshots: [{ body: document }],
    });
    await db.exec(
      "UPDATE institution.mentorship SET ended_at = now() WHERE id = pg_temp.id('ms1')",
    );
    expect(await store.read("marko", "doc-m1", [1])).toEqual({ status: "not_found" });
  } finally {
    await db.close();
  }
});
