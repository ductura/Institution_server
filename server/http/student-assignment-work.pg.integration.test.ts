import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import { createMyAssignmentWorkReader, type WithActor } from "../database/index.ts";

const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);

it("reads the stored submission and each student's own workspace under ductus_app", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
    await db.exec(evidence);
    // Both fixture writes and reads use the rollback-only test transaction.
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const reader = createMyAssignmentWorkReader(withActor);
    const assignmentId = "00000000-0000-4000-8000-0000000000a1";
    const ana = "D".repeat(43);
    const dora = "E".repeat(43);
    expect(await reader.read(ana)).toEqual({
      ok: true,
      value: [{ assignmentId, workState: "in_progress" }],
    });

    const record = await db.query<{ outcome: string }>(`SELECT
        pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0,
          repeat('a', 64), repeat('d', 64), repeat('b', 64)) AS outcome`);
    expect(record.rows[0]?.outcome).toBe("reserved");
    await db.exec(
      `SELECT pg_temp.ask('ana', 'SELECT outcome FROM app.request_submission(''doc-a'', 1)')`,
    );
    const submission = await db.query<{ outcome: string }>(`SELECT pg_temp.ask('ana', format(
        'SELECT outcome FROM app.record_submission(%L::uuid, %L)',
        (SELECT id::text FROM evidence.submission_request WHERE document_id = 'doc-a'), pg_temp.h('d')
      )) AS outcome`);
    expect(submission.rows[0]?.outcome).toBe("recorded");
    expect(await reader.read(ana)).toEqual({
      ok: true,
      value: [{ assignmentId, workState: "submitted" }],
    });
    expect(await reader.read(dora)).toEqual({
      ok: true,
      value: [{ assignmentId, workState: "not_started" }],
    });
    expect(await reader.read("A".repeat(43))).toEqual({ ok: true, value: [] });
  } finally {
    await db.close();
  }
});

// SRV-NF4-IZNIMKA-PREDAJA: the student sees the own late-submission exception
// (its time), never another student's; a student without one sees no field.
it("shows each student only the own late-submission exception", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
    await db.exec(evidence);
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const reader = createMyAssignmentWorkReader(withActor);
    const assignmentId = "00000000-0000-4000-8000-0000000000a1";
    const granted = await db.query<{ answer: string }>(`SELECT pg_temp.ask('vesna',
        $q$ SELECT to_char(until_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              FROM institution.grant_late_submission_exception({z1}, {ana},
                     date_trunc('milliseconds', now()) + interval '400 days', 'agreement') $q$) AS answer`);
    const untilAt = granted.rows[0]?.answer ?? "";
    expect(untilAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(await reader.read("D".repeat(43))).toEqual({
      ok: true,
      value: [{ assignmentId, workState: "in_progress", lateException: { untilAt } }],
    });
    const dora = await reader.read("E".repeat(43));
    expect(dora).toEqual({ ok: true, value: [{ assignmentId, workState: "not_started" }] });
    expect(dora.ok && Object.hasOwn(dora.value[0] ?? {}, "lateException")).toBe(false);
  } finally {
    await db.close();
  }
});
