import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ActorTransaction, createWithActor } from "../../server/database/index.ts";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

// SRV-ED43-DORADA-POSALJI (QA FAIL on #796): pgTAP runs in one transaction and
// cannot race two calls. Here real connections race the student's send of a
// revision round (collaboration.send_revision, 20261220180000) against a
// teacher's request that is still open in another transaction, and against a
// second send. Every request writer holds the document FOR SHARE from before
// it draws its row_seq to its commit; the send takes it FOR NO KEY UPDATE, so
// it waits for them, and a request opened after a round always starts the
// next one. Every person, course and text is invented; random ids of one
// random institution, removed afterwards. Loopback only.
const SAFE_ADMIN_URL: string =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
requireLoopbackDatabaseUrl(
  SAFE_ADMIN_URL,
  "The revision send race test runs only against a loopback database (DATABASE_URL).",
);
const suffix = randomBytes(5).toString("hex");
const applicationName = `it_revision_send_${suffix}`;
const admin = new pg.Pool({ connectionString: SAFE_ADMIN_URL, max: 2 });
const app = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 6,
  application_name: applicationName,
});
const withActor = createWithActor(app);

const institutionId = randomUUID();
const courseId = randomUUID();
const assignmentId = randomUUID();
const names = ["vesna", "ana"] as const;
type Name = (typeof names)[number];
const people = Object.fromEntries(
  names.map((name) => [name, { id: randomUUID(), token: randomBytes(32).toString("base64url") }]),
) as Record<Name, { id: string; token: string }>;
const document = `doc-ana-${suffix}`;
const TEXT = `{"nodes":[{"children":[{"text":"Izmisljeni tekst ${suffix}.","type":"text"}],"id":"00000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}`;
const HASH = createHash("sha256").update(TEXT, "utf8").digest("hex");
const ANCHOR = {
  nodeId: "0f0e0d0c-0b0a-4000-8000-000000000001",
  quote: "prvi odlomak",
  prefix: "",
  suffix: " teksta",
  startHint: 0,
  endHint: 12,
};

/** A new revision request of Vesna; its id and counter. */
const create = async (tx: ActorTransaction) =>
  (
    await tx.query<{ request_id: string; row_seq: string }>(
      "SELECT request_id, row_seq FROM collaboration.create_revision_request($1, $2::jsonb, $3, 0)",
      [document, JSON.stringify(ANCHOR), "Izmisljena uputa za doradu."],
    )
  ).rows[0]!;
/** Ana's send; the round. */
const send = async (tx: ActorTransaction) =>
  (
    await tx.query<{ round: number }>("SELECT round FROM collaboration.send_revision($1, NULL)", [
      document,
    ])
  ).rows[0]!.round;

/** Waits until a call matching `pattern` is in PostgreSQL and blocked by another transaction. */
async function waitForBlocked(pattern: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await admin.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity a
          WHERE a.application_name = $1 AND a.state = 'active' AND a.query ILIKE $2
            AND a.wait_event_type = 'Lock' AND cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0
       ) AS blocked`,
      [applicationName, `%${pattern}%`],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`The call ${pattern} did not reach PostgreSQL and wait on another transaction.`);
}

/** Runs `first` and keeps its transaction open until `release` is called. */
function hold<T>(token: string, first: (tx: ActorTransaction) => Promise<T>) {
  let started!: (value: T) => void;
  let failed!: (error: unknown) => void;
  let release!: () => void;
  const answered = new Promise<T>((resolve, reject) => {
    started = resolve;
    failed = reject;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = withActor(token, async (tx) => {
    const value = await first(tx);
    started(value);
    await held;
    return value;
  });
  void done.catch(failed);
  return { answered, release, done };
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, code: null as string | null }),
    (error: { code?: string }) => ({ value: null, code: error.code ?? "no code" }),
  );

/** The rounds of the work as stored: round and the counter it answered. */
const rounds = async () =>
  (
    await admin.query<{ round: number; answered: string }>(
      "SELECT round, answered_seq AS answered FROM collaboration.revision_send WHERE document_id = $1 ORDER BY round",
      [document],
    )
  ).rows.map((row) => [row.round, Number(row.answered)]);

beforeAll(async () => {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      institutionId,
      `it-revision-send-${suffix}`,
    ]);
    for (const name of names) {
      const { id, token } = people[name];
      await client.query(
        `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          institutionId,
          `https://issuer-${suffix}.test`,
          `sub-${name}`,
          `${name}@${suffix}.example`,
        ],
      );
      await client.query(
        `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
         VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
        [token, id, institutionId],
      );
    }
    await client.query(
      "INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_at) VALUES ($1, $2, 'teacher', now())",
      [institutionId, people.vesna.id],
    );
    await client.query(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, $3, '2026/2027', 'partially_allowed', $4)`,
      [courseId, institutionId, `Izmisljeni kolegij ${suffix}`, people.vesna.id],
    );
    for (const name of names)
      await client.query(
        "INSERT INTO institution.course_member (course_id, institution_id, user_id, role) VALUES ($1, $2, $3, $4)",
        [courseId, institutionId, people[name].id, name === "vesna" ? "teacher" : "student"],
      );
    await client.query(
      "INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by) VALUES ($1, $2, $3, 1, $4)",
      [assignmentId, courseId, institutionId, people.vesna.id],
    );
    await client.query(
      `INSERT INTO institution.assignment_version
         (assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy,
          ai_purposes, evidence_profile, import_allowed, created_by)
       VALUES ($1, 1, 'Izmisljeni zadatak', 'Sinteticki zadatak.', 'essay', now() - interval '1 day', now() + interval '1 day',
               'partially_allowed', ARRAY[]::text[], 'extended', false, $2)`,
      [assignmentId, people.vesna.id],
    );
    await client.query(
      "INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id) VALUES ($1, 1, $2, $3)",
      [assignmentId, people.ana.id, institutionId],
    );
    await client.query(
      "INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES ($1, $2, $3, $4)",
      [`project-${document}`, institutionId, assignmentId, people.ana.id],
    );
    await client.query(
      `INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision, current_content_hash)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [document, institutionId, `project-${document}`, people.ana.id, HASH],
    );
    await client.query(
      `INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
       VALUES ($1, $2, 0, NULL, $3, $4), ($1, $2, 1, 0, $3, $5)`,
      [document, institutionId, people.ana.id, "a".repeat(64), HASH],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  try {
    await app.end();
  } finally {
    await cleanUp();
  }
});

async function cleanUp() {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    // Disposable synthetic rows only; the append-only triggers stay active in normal operation.
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "collaboration.revision_send",
      "collaboration.revision_response",
      "collaboration.revision_request_version",
      "collaboration.revision_request",
      "audit.access_log",
      "evidence.document_revision",
      "evidence.document",
      "evidence.project",
      "institution.notice_acknowledgment",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = $1`, [institutionId]);
    }
    await client.query("DELETE FROM institution.assignment_version WHERE assignment_id = $1", [
      assignmentId,
    ]);
    for (const table of [
      "institution.assignment",
      "institution.course_member",
      "institution.course",
      "institution.institution_role",
      "identity.session",
      "identity.user_account",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = $1`, [institutionId]);
    }
    await client.query("DELETE FROM identity.institution WHERE id = $1", [institutionId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await admin.end();
  }
}

describe("a student's revision send, over real connections", () => {
  it("a teacher's request still open in another transaction is waited for, so the next request is never lost (QA #796)", async () => {
    const first = await withActor(people.vesna.token, create);
    expect(await withActor(people.ana.token, send)).toBe(1);
    // T1 draws the lower counter and stays open; T2 draws the higher one and commits.
    const slow = hold(people.vesna.token, create);
    let sending: ReturnType<typeof settle<number>>;
    let fast: { request_id: string; row_seq: string };
    try {
      const pending = await slow.answered;
      fast = await withActor(people.vesna.token, create);
      expect(Number(pending.row_seq)).toBeLessThan(Number(fast.row_seq));
      sending = settle(withActor(people.ana.token, send));
      // Without the send lock the send would not wait here and would answer
      // the higher counter before the lower one is visible.
      await waitForBlocked("send_revision");
    } finally {
      slow.release();
    }
    const pending = await slow.done;
    expect(await sending).toEqual({ value: 2, code: null });
    // Round 2 answered both requests, the one it waited for included.
    expect(await rounds()).toEqual([
      [1, Number(first.row_seq)],
      [2, Math.max(Number(pending.row_seq), Number(fast!.row_seq))],
    ]);
    expect(await settle(withActor(people.ana.token, send))).toEqual({ value: null, code: "ZD409" });
    // A request opened afterwards starts round 3.
    await withActor(people.vesna.token, create);
    expect(await withActor(people.ana.token, send)).toBe(3);
  });

  it("a request created while a send is open waits for it, then starts the next round", async () => {
    await withActor(people.vesna.token, create);
    const before = (await rounds()).length;
    const sending = hold(people.ana.token, send);
    let creating: ReturnType<typeof settle<{ request_id: string; row_seq: string }>>;
    try {
      expect(await sending.answered).toBe(before + 1);
      creating = settle(withActor(people.vesna.token, create));
      await waitForBlocked("create_revision_request");
    } finally {
      sending.release();
    }
    await sending.done;
    expect((await creating).code).toBeNull();
    expect(await withActor(people.ana.token, send)).toBe(before + 2);
  });

  it("two sends of the same work: the second waits, then is not allowed; one round is written", async () => {
    await withActor(people.vesna.token, create);
    const before = (await rounds()).length;
    const first = hold(people.ana.token, send);
    let second: ReturnType<typeof settle<number>>;
    try {
      expect(await first.answered).toBe(before + 1);
      second = settle(withActor(people.ana.token, send));
      await waitForBlocked("send_revision");
    } finally {
      first.release();
    }
    expect(await first.done).toBe(before + 1);
    expect(await second).toEqual({ value: null, code: "ZD409" });
    expect((await rounds()).length).toBe(before + 1);
  });
});
