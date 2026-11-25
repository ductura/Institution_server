// SRV-NF4-IZNIMKA-PREDAJA (Ductus#2055; NF-4, NZ-5 B): submitWork over the real
// database. On an assignment that does not allow late submission, a student's
// own lasting late-submission exception lets the request through after the
// deadline, and the request still pins that deadline (afterDeadline). An
// expired exception and another student's exception do not: the click is the
// existing not_open (409 on the wire) and nothing is written. Only the
// fixtures of db/main/tests (invented people, documents and texts) are used.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";
import type { WithActor } from "../database/index.ts";

import { type SubmissionDependencies, submitWork } from "./submission.ts";

const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);
const ANA = "D".repeat(43);

// Z1 gets a version 3 whose deadline passed yesterday, acknowledged by Ana and
// Dora; Vesna does not allow late submission.
const PASSED_DEADLINE = `
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
) VALUES (pg_temp.id('z1'), 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', now() - interval '2 days',
          now() - interval '1 day', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
SELECT pg_temp.id('z1'), 3, pg_temp.id(s), pg_temp.id('fak_a') FROM unnest(ARRAY['ana', 'dora']) AS s;
RESET ROLE;`;

let db: TestDatabase;

async function ask(actor: string, sql: string): Promise<string | null> {
  const { rows } = await db.query<{ answer: string | null }>(
    "SELECT pg_temp.ask($1, $2) AS answer",
    [actor, sql],
  );
  return rows[0]?.answer ?? null;
}

beforeEach(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(institution);
  await db.exec(evidence);
  await db.exec(PASSED_DEADLINE);
  const committed = await db.query<{ outcome: string }>(`SELECT pg_temp.call('ana', 'pkg-a',
    'req-exception-http', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64), repeat('b', 64)) AS outcome`);
  expect(committed.rows[0]?.outcome).toBe("reserved");
  expect(
    await ask(
      "vesna",
      "SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({z1}, false)",
    ),
  ).toBe("false");
});
afterEach(async () => {
  await db.close();
});

// Fixture writes and reads share the rollback-only test transaction.
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
// A refusal returns before the record is read or signed; past the request the
// reconstruction is not under test here, so the readers only fail.
const deps = {
  withActor,
  payloads: { read: () => Promise.reject(new Error("not under test")) },
  signer: { current: () => Promise.reject(new Error("not under test")) },
} as unknown as SubmissionDependencies;

const grant = (student: string) =>
  ask(
    "vesna",
    `SELECT reason_id FROM institution.grant_late_submission_exception({z1}, {${student}},
       now() + interval '1 day', 'technical')`,
  );
// Ana's requests: whether each is after the deadline it pins.
async function requests(): Promise<string[]> {
  const { rows } = await db.query<{ after: string }>(
    `SELECT (requested_at > due_at)::text AS after FROM evidence.submission_request
      WHERE document_id = 'doc-a'`,
  );
  return rows.map((row) => row.after);
}
// Past the request only the request row matters here, so a throw there counts as past it.
const submit = () =>
  submitWork(deps, ANA, { documentId: "doc-a", revision: 1 }).catch(() => ({
    status: "past_request",
  }));

describe("a late submission with a late-submission exception", () => {
  it("is refused as not_open without an exception, and nothing is written", async () => {
    expect(await submit()).toEqual({ status: "not_open" });
    expect(await requests()).toEqual([]);
  });

  it("goes through with the student's own lasting exception, still after the deadline", async () => {
    expect(await grant("ana")).toBe("technical");
    expect((await submit()).status).not.toBe("not_open");
    expect(await requests()).toEqual(["true"]);
  });

  it("is refused when the student's exception has expired", async () => {
    await db.exec(`SET LOCAL ROLE ductus_identity;
      INSERT INTO institution.late_submission_exception
        (institution_id, assignment_id, student_id, until_at, reason_id, created_by, created_at)
      VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), now() - interval '1 hour',
              'justified', pg_temp.id('vesna'), now() - interval '2 days');
      RESET ROLE;`);
    expect(await submit()).toEqual({ status: "not_open" });
    expect(await requests()).toEqual([]);
  });

  it("is refused when only another student has an exception", async () => {
    expect(await grant("dora")).toBe("technical");
    expect(await submit()).toEqual({ status: "not_open" });
    expect(await requests()).toEqual([]);
  });
});
