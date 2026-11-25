// SRV-NF4-KASNA-PROVEDBA (Ductus#2055, decision A): submitWork over the real
// database. When the teacher does not allow late submission, a click after the
// student's deadline comes back as the existing not_open (409 on the wire,
// submission-route.ts) and no request is written; an extension or allowing it
// again lets the request through. Only the fixtures of db/main/tests
// (invented people, documents and texts) are used.
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

// Z1 gets a version 3 whose deadline passed yesterday, acknowledged by Ana.
const PASSED_DEADLINE = `
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
) VALUES (pg_temp.id('z1'), 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', now() - interval '2 days',
          now() - interval '1 day', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
VALUES (pg_temp.id('z1'), 3, pg_temp.id('ana'), pg_temp.id('fak_a'));
RESET ROLE;`;

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(institution);
  await db.exec(evidence);
  await db.exec(PASSED_DEADLINE);
  const committed = await db.query<{ outcome: string }>(`SELECT pg_temp.call('ana', 'pkg-a',
    'req-late-http', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64), repeat('b', 64)) AS outcome`);
  expect(committed.rows[0]?.outcome).toBe("reserved");
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
  payloads: {
    read: () => Promise.reject(new Error("not under test")),
  },
  signer: {
    current: () => Promise.reject(new Error("not under test")),
  },
} as unknown as SubmissionDependencies;

async function ask(actor: string, sql: string): Promise<string | null> {
  const { rows } = await db.query<{ answer: string | null }>(
    "SELECT pg_temp.ask($1, $2) AS answer",
    [actor, sql],
  );
  return rows[0]?.answer ?? null;
}
const allowLate = (value: boolean) =>
  ask(
    "vesna",
    `SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({z1}, ${value})`,
  );
async function requests(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM evidence.submission_request WHERE document_id = 'doc-a'",
  );
  return Number(rows[0]?.n);
}
// Past the request only the request row matters here, so a throw there counts as past it.
const submit = () =>
  submitWork(deps, ANA, { documentId: "doc-a", revision: 1 }).catch(() => ({
    status: "past_request",
  }));

describe("a submission after the deadline", () => {
  it("is refused as not_open when the teacher does not allow it, and nothing is written", async () => {
    expect(await allowLate(false)).toBe("false");
    expect(await submit()).toEqual({ status: "not_open" });
    expect(await requests()).toBe(0);
  });

  it("goes through by default (allowed), as before", async () => {
    expect((await submit()).status).not.toBe("not_open");
    expect(await requests()).toBe(1);
  });

  it("goes through when the student's deadline is extended past the click", async () => {
    expect(await allowLate(false)).toBe("false");
    expect(
      await ask(
        "vesna",
        `SELECT earlier_submissions::text FROM institution.extend_assignment_deadline(
           {z1}, {ana}, now() + interval '1 day', 'justified')`,
      ),
    ).toBe("false");
    expect((await submit()).status).not.toBe("not_open");
    expect(await requests()).toBe(1);
  });

  it("goes through once the teacher allows it again", async () => {
    expect(await allowLate(false)).toBe("false");
    expect(await submit()).toEqual({ status: "not_open" });
    expect(await allowLate(true)).toBe("true");
    expect((await submit()).status).not.toBe("not_open");
    expect(await requests()).toBe(1);
  });
});
