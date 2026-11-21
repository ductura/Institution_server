import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAssistantRequests,
  createWithActor,
  type BeginRequestInput,
} from "../../server/database/index.ts";
import { buildPortInput } from "../../server/domain/index.ts";
import { createSyntheticAssistant } from "../../server/external/assistant/index.ts";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

// SRV-1203 (Val 12 / M9.0-S2, Ductus#2052): idempotency, the conversation
// and the transitions of the assistant under concurrency (Ductus
// docs/contracts/ai-request-v1.md, "Idempotencija", "Stanja", "Matrica
// pristupa"; plan of attack Ductus#1662 I2, I3, I6, R3 to R5, R7). Requests
// go through several real connections at once; the barrier, the route
// (`flow`, over the synthetic port) and the world of one invented institution
// are those of assistant-budget.integration.test.ts, repeated here so each
// file stands alone. After every scenario the counters equal the ledger.
//
// Every institution, person and text is invented; amounts are invented test
// values (T8), providers and models provider-test-a and model-test-1 (S4).
// This file takes its service caps and every row it wrote away at the end.
// Loopback only.
const SAFE_ADMIN_URL: string =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
requireLoopbackDatabaseUrl(
  SAFE_ADMIN_URL,
  "The assistant idempotency test runs only against a loopback database (DATABASE_URL).",
);
const suffix = randomBytes(5).toString("hex");
const applicationName = `it_assistant_idem_${suffix}`;
const admin = new pg.Pool({ connectionString: SAFE_ADMIN_URL, max: 4 });
const app = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 16,
  application_name: applicationName,
});
const withActor = createWithActor(app);
const port = createAssistantRequests(withActor);

const R = 7n; // one reservation, an invented amount
const HUGE = 1_000_000_000_000n;
const institutions: string[] = [];
const serviceVersions: string[] = [];

type Person = { id: string; token: string };
type World = {
  institutionId: string;
  assignmentId: string;
  secondAssignmentId: string;
  admin: Person;
  students: Person[];
};

const token = () => randomBytes(32).toString("base64url");

async function person(client: pg.PoolClient, institutionId: string, name: string): Promise<Person> {
  const p = { id: randomUUID(), token: token() };
  await client.query(
    `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      p.id,
      institutionId,
      `https://issuer-${suffix}.test`,
      `sub-${name}-${p.id}`,
      `${name}-${p.id}@${suffix}.invalid`,
    ],
  );
  await client.query(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
    [p.token, p.id, institutionId],
  );
  return p;
}

/** A new institution: an administrator, a teacher, a course with two assignments, n students. */
async function world(students: number, coursePolicy = "encouraged"): Promise<World> {
  const institutionId = randomUUID();
  institutions.push(institutionId);
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      institutionId,
      `it-assistant-i-${suffix}-${institutions.length}`,
    ]);
    await client.query(
      `INSERT INTO institution.institution_settings (institution_id, display_name) VALUES ($1, 'Izmišljeni fakultet')`,
      [institutionId],
    );
    const adm = await person(client, institutionId, "admin");
    const teacher = await person(client, institutionId, "teacher");
    const people: Person[] = [];
    for (let i = 0; i < students; i += 1)
      people.push(await person(client, institutionId, `student${i}`));
    await client.query("SELECT institution.appoint_institution_admin($1, $2)", [
      adm.id,
      `Zahtjev ${suffix}`,
    ]);
    await client.query(
      `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
       VALUES ($1, $2, 'teacher', $3, now())`,
      [institutionId, teacher.id, adm.id],
    );
    const course = randomUUID();
    await client.query(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, 'Izmišljeni kolegij', '2026/2027', $3, $4)`,
      [course, institutionId, coursePolicy, teacher.id],
    );
    for (const [user, role] of [
      [teacher, "teacher"],
      ...people.map((p) => [p, "student"] as const),
    ] as const) {
      await client.query(
        `INSERT INTO institution.course_member (course_id, institution_id, user_id, role) VALUES ($1, $2, $3, $4)`,
        [course, institutionId, user.id, role],
      );
    }
    const assignments = [randomUUID(), randomUUID()];
    for (const id of assignments) {
      await client.query(
        `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
         VALUES ($1, $2, $3, 1, $4)`,
        [id, course, institutionId, teacher.id],
      );
      await client.query(
        `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type, opens_at,
           due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
         VALUES ($1, 1, 'Izmišljeni zadatak', 'Izmišljene upute.', 'essay', now(), now() + interval '30 days',
                 'encouraged', '{proofreading,translation}', 'basic', false, $2)`,
        [id, teacher.id],
      );
    }
    await client.query("COMMIT");
    return {
      institutionId,
      assignmentId: assignments[0]!,
      secondAssignmentId: assignments[1]!,
      admin: adm,
      students: people,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const versionOf = async (institutionId: string | null) =>
  Number(
    (
      await admin.query<{ n: number }>(
        "SELECT coalesce(max(version_no), 0) AS n FROM assistant.cost_config_version WHERE institution_id IS NOT DISTINCT FROM $1",
        [institutionId],
      )
    ).rows[0]!.n,
  );

/** The operator's cap of an institution, or of the service for null. */
async function cap(institutionId: string | null, micro: bigint, period: "day" | "month") {
  const version = await versionOf(institutionId);
  await admin.query("SELECT assistant.publish_cost_cap($1, $2, $3, $4, $5)", [
    institutionId,
    version,
    micro.toString(),
    period,
    `Zahtjev ${suffix}/${version + 1}`,
  ]);
  if (institutionId === null) {
    serviceVersions.push(
      (
        await admin.query<{ id: string }>(
          "SELECT id FROM assistant.cost_config_version WHERE institution_id IS NULL AND version_no = $1",
          [version + 1],
        )
      ).rows[0]!.id,
    );
  }
}

/** The administrator's limits; null switches one off. */
async function limits(
  w: World,
  studentDay: bigint | null,
  studentAssignmentDay: bigint | null,
  reserve: bigint | null,
) {
  const answer = await port.publishCostConfig(w.admin.token, {
    expectedVersion: await versionOf(w.institutionId),
    studentDayMicro: studentDay,
    studentAssignmentDayMicro: studentAssignmentDay,
    reserveMicro: reserve,
  });
  expect(answer).toMatchObject({ status: "published" });
}

async function configured(
  students: number,
  opts: { cap?: bigint; period?: "day" | "month"; day?: bigint; assignmentDay?: bigint } = {},
) {
  const w = await world(students);
  const top = opts.cap ?? HUGE;
  await cap(w.institutionId, top, opts.period ?? "day");
  await limits(w, opts.day ?? top, opts.assignmentDay ?? top, R);
  return w;
}

let n = 0;
const input = (w: World, over: Partial<BeginRequestInput> = {}): BeginRequestInput => ({
  idempotencyKey: randomUUID(),
  assignmentId: w.assignmentId,
  conversationId: null,
  purposeCatalogVersion: 1,
  purposeKey: "proofreading",
  paragraph: `Izmišljeni odlomak broj ${(n += 1)}.`,
  providerId: "provider-test-a",
  modelId: "model-test-1",
  configVersion: "test-1",
  ...over,
});

type Flow = { begun: string; final: string; portCalled: boolean; requestId: string | null };

/** The route of step 4 over the synthetic port: begin, mark_sent, port, outcome. */
async function flow(
  student: Person,
  req: BeginRequestInput,
  assistant = createSyntheticAssistant({ branch: "success", actualMicro: R }),
): Promise<Flow> {
  const begun = await port.begin(student.token, req);
  if (begun.status !== "ok")
    return { begun: begun.status, final: begun.status, portCalled: false, requestId: null };
  const base = { begun: begun.state, requestId: begun.requestId, portCalled: false };
  if (begun.state !== "reserved" || begun.replayed)
    return { ...base, final: begun.reason ?? begun.state };
  const sent = await port.markSent(student.token, begun.requestId);
  if (sent.status !== "ok" || sent.state !== "sent") {
    return { ...base, final: sent.status === "ok" ? `${sent.state}:${sent.reason}` : sent.status };
  }
  const outcome = await assistant.complete(
    buildPortInput({
      instructions: "Izmišljene upute poslužitelja.",
      paragraph: req.paragraph,
      purposeKey: req.purposeKey,
      modelId: req.modelId,
      maxResponseCodePoints: 2000,
    }),
  );
  const called = { ...base, portCalled: true };
  if (outcome.kind === "success") {
    const done = await port.complete(
      student.token,
      begun.requestId,
      outcome.text,
      outcome.actualMicro,
    );
    return { ...called, final: done.status === "ok" ? done.state : done.status };
  }
  if (outcome.kind === "provider_error") {
    const done = await port.fail(student.token, begun.requestId, outcome.actualMicro ?? null);
    return { ...called, final: done.status === "ok" ? done.state : done.status };
  }
  const done = await port.markOutcomeUnknown(student.token, begun.requestId);
  return { ...called, final: done.status === "ok" ? done.state : done.status };
}

/** The current period of the service cap, and its counter row (made if missing). */
async function serviceCounterPeriod(): Promise<string> {
  const row = (
    await admin.query<{ p: string }>(
      `SELECT assistant.period_start(assistant.budget_day(now()), v.cap_period)::text AS p
         FROM assistant.cost_config_version v WHERE v.institution_id IS NULL ORDER BY v.version_no DESC LIMIT 1`,
    )
  ).rows[0]!;
  await admin.query(
    `INSERT INTO assistant.budget_counter (scope, scope_key, institution_id, period_start, used_micro)
     VALUES ('service_cap', '', NULL, $1, 0) ON CONFLICT DO NOTHING`,
    [row.p],
  );
  return row.p;
}

/**
 * Starts every call while an admin transaction holds the service counter row,
 * waits until `waiting` of them wait on a lock in PostgreSQL, then lets go.
 */
async function race<T>(calls: (() => Promise<T>)[], waiting = calls.length): Promise<T[]> {
  const period = await serviceCounterPeriod();
  const holder = await admin.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM assistant.budget_counter WHERE scope = 'service_cap' AND scope_key = '' AND period_start = $1 FOR UPDATE",
      [period],
    );
    const running = calls.map((call) => call());
    running.forEach((p) => void p.catch(() => undefined));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const blocked = Number(
        (
          await admin.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock'`,
            [applicationName],
          )
        ).rows[0]!.n,
      );
      if (blocked >= waiting) break;
      if (Date.now() > deadline)
        throw new Error(`only ${blocked} of ${waiting} calls reached PostgreSQL and waited`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await holder.query("COMMIT");
    return await Promise.all(running);
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}

/** Counters whose used amount is not the sum of the ledger rows they hold (the invariant of the contract). */
async function drift(): Promise<string[]> {
  return (
    await admin.query<{ k: string }>(
      `SELECT b.scope || ' ' || b.scope_key || ' ' || b.period_start || ' ' || b.used_micro AS k
         FROM assistant.budget_counter b
        WHERE b.used_micro <> coalesce((
          SELECT sum(coalesce(l.actual_micro, l.reserved_micro)) FROM assistant.cost_ledger l
           WHERE l.state IN ('reserved', 'settled') AND CASE b.scope
             WHEN 'service_cap' THEN l.service_cap_period_start = b.period_start
             WHEN 'institution_cap' THEN l.institution_id::text = b.scope_key AND l.institution_cap_period_start = b.period_start
             WHEN 'student_day' THEN l.institution_id || ':' || l.student_id = b.scope_key AND l.budget_day = b.period_start
             ELSE l.institution_id || ':' || l.student_id || ':' || l.assignment_id = b.scope_key AND l.budget_day = b.period_start
           END), 0)`,
    )
  ).rows.map((r) => r.k);
}

const used = async (scope: string, key: string) =>
  BigInt(
    (
      await admin.query<{ u: string }>(
        "SELECT coalesce(sum(used_micro), 0)::text AS u FROM assistant.budget_counter WHERE scope = $1 AND scope_key = $2",
        [scope, key],
      )
    ).rows[0]!.u,
  );
const count = (flows: Flow[], final: string) => flows.filter((f) => f.final === final).length;

beforeAll(async () => {
  await cap(null, HUGE, "month");
});

afterAll(async () => {
  try {
    await app.end();
  } finally {
    // The ledger and the trail are append-only even for the superuser: this
    // file's rows go with the triggers off, in one transaction. The shared
    // service counter gives back exactly what this file's ledger rows put on it.
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE assistant.budget_counter b SET used_micro = b.used_micro - s.total
           FROM (SELECT service_cap_period_start AS p, sum(coalesce(actual_micro, reserved_micro)) AS total
                   FROM assistant.cost_ledger WHERE institution_id = ANY ($1) AND state IN ('reserved', 'settled')
                  GROUP BY 1) s
          WHERE b.scope = 'service_cap' AND b.period_start = s.p`,
        [institutions],
      );
      await client.query(
        "DELETE FROM assistant.budget_counter WHERE scope = 'service_cap' AND used_micro = 0",
      );
      await client.query(
        "DELETE FROM audit.assistant_cost_config_event WHERE config_version_id = ANY ($1)",
        [serviceVersions],
      );
      await client.query("DELETE FROM assistant.cost_config_version WHERE id = ANY ($1)", [
        serviceVersions,
      ]);
      const tables = await client.query<{ t: string }>(
        `SELECT format('%I.%I', c.table_schema, c.table_name) AS t FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.column_name = 'institution_id' AND t.table_type = 'BASE TABLE'
            AND c.table_schema NOT IN ('pg_catalog', 'information_schema', 'public', 'pgboss')`,
      );
      for (const { t } of tables.rows) {
        await client.query(`DELETE FROM ${t} WHERE institution_id = ANY ($1)`, [institutions]);
      }
      await client.query("DELETE FROM identity.institution WHERE id = ANY ($1)", [institutions]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await admin.end();
    }
  }
});

const rowsOf = async (sql: string, values: unknown[]) => (await admin.query(sql, values)).rows;

describe("assistant idempotency: the same key at once (I2)", () => {
  it("one request row, one reservation, one port call; the others get the existing request", async () => {
    const w = await configured(1);
    const student = w.students[0]!;
    const req = input(w);
    const assistant = createSyntheticAssistant({ branch: "success", actualMicro: R });
    const flows = await race(Array.from({ length: 4 }, () => () => flow(student, req, assistant)));
    expect(flows.filter((f) => f.portCalled)).toHaveLength(1);
    expect(assistant.calls).toHaveLength(1);
    expect(new Set(flows.map((f) => f.requestId)).size).toBe(1);
    expect(
      await rowsOf("SELECT 1 FROM assistant.request WHERE student_id = $1", [student.id]),
    ).toHaveLength(1);
    expect(
      await rowsOf("SELECT 1 FROM assistant.cost_ledger WHERE student_id = $1", [student.id]),
    ).toHaveLength(1);
    expect(
      await rowsOf(
        "SELECT role FROM assistant.message m JOIN assistant.request r ON r.id = m.request_id WHERE r.student_id = $1",
        [student.id],
      ),
    ).toEqual([{ role: "student_paragraph" }, { role: "provider_response" }]);
    expect(await drift()).toEqual([]);
  });

  it("the same key with another request at once: one goes through, the other is idempotency_conflict", async () => {
    const w = await configured(1);
    const student = w.students[0]!;
    const key = randomUUID();
    const flows = await race([
      () => flow(student, input(w, { idempotencyKey: key, paragraph: "Izmišljeni prvi odlomak." })),
      () =>
        flow(student, input(w, { idempotencyKey: key, paragraph: "Izmišljeni drugi odlomak." })),
    ]);
    expect(flows.map((f) => f.final).sort()).toEqual(["completed", "idempotency_conflict"]);
    expect(
      await rowsOf("SELECT 1 FROM assistant.cost_ledger WHERE student_id = $1", [student.id]),
    ).toHaveLength(1);
    expect(await drift()).toEqual([]);
  });
});

describe("assistant idempotency: replays (R3 to R5)", () => {
  it("after completed the same key returns the same response, with no second reservation or message (R4)", async () => {
    const w = await configured(1);
    const student = w.students[0]!;
    const req = input(w);
    expect((await flow(student, req)).final).toBe("completed");
    const again = await port.begin(student.token, req);
    expect(again).toMatchObject({ status: "ok", state: "completed", replayed: true });
    const stored = await rowsOf(
      "SELECT m.id, m.content FROM assistant.message m JOIN assistant.request r ON r.id = m.request_id WHERE r.student_id = $1 AND m.role = 'provider_response'",
      [student.id],
    );
    expect(again.status === "ok" && again.response).toEqual({
      id: stored[0]!.id,
      text: stored[0]!.content,
    });
    expect(
      await rowsOf(
        "SELECT 1 FROM assistant.message m JOIN assistant.request r ON r.id = m.request_id WHERE r.student_id = $1",
        [student.id],
      ),
    ).toHaveLength(2);
    expect(
      await rowsOf("SELECT 1 FROM assistant.cost_ledger WHERE student_id = $1", [student.id]),
    ).toHaveLength(1);
  });

  it("the key is the account's: the same key of another student is another request (R3)", async () => {
    const w = await configured(2);
    const [ana, dora] = w.students as [Person, Person];
    const key = randomUUID();
    const a = await flow(
      ana,
      input(w, { idempotencyKey: key, paragraph: "Isti izmišljeni odlomak." }),
    );
    const d = await flow(
      dora,
      input(w, { idempotencyKey: key, paragraph: "Isti izmišljeni odlomak." }),
    );
    expect([a.final, d.final]).toEqual(["completed", "completed"]);
    expect(a.requestId).not.toBe(d.requestId);
    expect(await drift()).toEqual([]);
  });

  it("after rejected the same key keeps the reason; a new attempt needs a new key and reserves anew (R5)", async () => {
    const w = await configured(1, { day: R });
    const student = w.students[0]!;
    expect((await flow(student, input(w))).final).toBe("completed");
    const refused = input(w);
    expect((await flow(student, refused)).final).toBe("budget_exceeded");
    await limits(w, 3n * R, 3n * R, R);
    expect(await port.begin(student.token, refused)).toMatchObject({
      state: "rejected",
      reason: "budget_exceeded",
      replayed: true,
    });
    expect((await flow(student, { ...refused, idempotencyKey: randomUUID() })).final).toBe(
      "completed",
    );
    expect(
      await rowsOf("SELECT 1 FROM assistant.cost_ledger WHERE student_id = $1", [student.id]),
    ).toHaveLength(2);
    expect(await drift()).toEqual([]);
  });

  it("after outcome_unknown the same key answers outcome_unknown; a new key reserves anew (R5)", async () => {
    const w = await configured(1);
    const student = w.students[0]!;
    const req = input(w);
    expect(
      (await flow(student, req, createSyntheticAssistant({ branch: "aborted_after_send" }))).final,
    ).toBe("outcome_unknown");
    expect(await port.begin(student.token, req)).toMatchObject({
      state: "outcome_unknown",
      replayed: true,
    });
    expect((await flow(student, { ...req, idempotencyKey: randomUUID() })).final).toBe("completed");
    expect(
      await rowsOf(
        "SELECT state FROM assistant.cost_ledger WHERE student_id = $1 ORDER BY reserved_at",
        [student.id],
      ),
    ).toEqual([{ state: "reserved" }, { state: "settled" }]);
    expect(await drift()).toEqual([]);
  });
});

describe("assistant idempotency: revocation between reservation and sending (I3)", () => {
  it.each([
    [
      "the course becomes prohibited",
      "UPDATE institution.course SET ai_policy = 'prohibited' WHERE institution_id = $1",
      "rejected:purpose_not_allowed",
    ],
    [
      "the student leaves the course",
      "UPDATE institution.course_member SET member_to = now() WHERE institution_id = $1 AND role = 'student'",
      "rejected:forbidden",
    ],
  ])("%s: no port call, the reservation is released", async (_why, sql, final) => {
    const w = await configured(1);
    const student = w.students[0]!;
    const assistant = createSyntheticAssistant({ branch: "success", actualMicro: R });
    const begun = await port.begin(student.token, input(w));
    expect(begun).toMatchObject({ status: "ok", state: "reserved" });
    await admin.query(sql, [w.institutionId]);
    const sent = await port.markSent(student.token, begun.status === "ok" ? begun.requestId : "");
    expect(sent.status === "ok" ? `${sent.state}:${sent.reason}` : sent.status).toBe(final);
    expect(assistant.calls).toHaveLength(0);
    expect(
      await rowsOf("SELECT state FROM assistant.cost_ledger WHERE student_id = $1", [student.id]),
    ).toEqual([{ state: "released" }]);
    expect(await used("student_day", `${w.institutionId}:${student.id}`)).toBe(0n);
    expect(await drift()).toEqual([]);
  });
});

describe("assistant idempotency: two tabs in one conversation (I6)", () => {
  it("gives seq without a gap or a duplicate and charges each request once", async () => {
    const N = 6;
    const w = await configured(1);
    const student = w.students[0]!;
    const first = await port.begin(student.token, input(w));
    expect(first).toMatchObject({ state: "reserved" });
    const conversationId = first.status === "ok" ? first.conversationId : null;
    const flows = await race(
      Array.from({ length: N }, () => () => flow(student, input(w, { conversationId }))),
    );
    expect(count(flows, "completed")).toBe(N);
    const seqs = (
      await rowsOf("SELECT seq FROM assistant.message WHERE conversation_id = $1 ORDER BY seq", [
        conversationId,
      ])
    ).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 1 + 2 * N }, (_, i) => i + 1));
    expect(
      await rowsOf("SELECT 1 FROM assistant.cost_ledger WHERE student_id = $1", [student.id]),
    ).toHaveLength(1 + N);
    const read = await port.readConversation(student.token, conversationId!);
    expect(read.status === "ok" && read.messages.map((m) => m.seq)).toEqual(seqs);
    expect(await drift()).toEqual([]);
  });
});

describe("assistant idempotency: a late response after outcome_unknown (R7)", () => {
  it("is dropped: no message, no change of cost", async () => {
    const w = await configured(1);
    const student = w.students[0]!;
    const assistant = createSyntheticAssistant({
      branch: "late_answer",
      actualMicro: 3n,
      text: "Zakašnjeli izmišljeni odgovor.",
    });
    const lost = await flow(student, input(w), assistant);
    expect(lost.final).toBe("outcome_unknown");
    const late = assistant.deliverLate();
    expect(late?.kind).toBe("success");
    const answer = await port.complete(
      student.token,
      lost.requestId!,
      late?.kind === "success" ? late.text : "",
      3n,
    );
    expect(answer).toEqual({
      status: "ok",
      state: "outcome_unknown",
      accepted: false,
      responseId: null,
    });
    expect(
      await rowsOf("SELECT role FROM assistant.message WHERE request_id = $1", [lost.requestId]),
    ).toEqual([{ role: "student_paragraph" }]);
    expect(
      await rowsOf(
        'SELECT state, actual_micro AS "actualMicro" FROM assistant.cost_ledger WHERE request_id = $1',
        [lost.requestId],
      ),
    ).toEqual([{ state: "reserved", actualMicro: null }]);
    expect(await drift()).toEqual([]);
  });

  it("racing the timeout, exactly one of them wins and the rows agree with it", async () => {
    const w = await configured(1);
    const student = w.students[0]!;
    for (let round = 0; round < 5; round += 1) {
      const begun = await port.begin(student.token, input(w));
      const id = begun.status === "ok" ? begun.requestId : "";
      expect(await port.markSent(student.token, id)).toMatchObject({ state: "sent" });
      const [unknown, done] = await Promise.all([
        port.markOutcomeUnknown(student.token, id),
        port.complete(student.token, id, "Izmišljeni odgovor u utrci.", R + 1n),
      ]);
      const [row] = await rowsOf(
        "SELECT r.state, l.state AS ledger, (SELECT count(*)::int FROM assistant.message m WHERE m.request_id = r.id) AS messages FROM assistant.request r JOIN assistant.cost_ledger l ON l.request_id = r.id WHERE r.id = $1",
        [id],
      );
      if (row!.state === "completed") {
        expect(done).toMatchObject({ state: "completed", accepted: true });
        expect(unknown).toEqual({ status: "conflict" });
        expect(row).toMatchObject({ ledger: "settled", messages: 2 });
      } else {
        expect(unknown).toEqual({ status: "ok", state: "outcome_unknown" });
        expect(done).toMatchObject({ state: "outcome_unknown", accepted: false });
        expect(row).toMatchObject({ state: "outcome_unknown", ledger: "reserved", messages: 1 });
      }
    }
    expect(await drift()).toEqual([]);
  });
});
