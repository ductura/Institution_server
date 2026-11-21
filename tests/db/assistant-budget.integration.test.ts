import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAssistantRequests,
  createWithActor,
  sweepAndSettle,
  type BeginRequestInput,
} from "../../server/database/index.ts";
import { buildPortInput } from "../../server/domain/index.ts";
import {
  createSyntheticAssistant,
  type SyntheticBranch,
} from "../../server/external/assistant/index.ts";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

// SRV-1203 (Val 12 / M9.0-S2, Ductus#2052): the budget of the assistant
// (Ductus docs/contracts/ai-request-v1.md, "RPC-ovi", "Matrica pristupa",
// "Testovi prije koda"; plan of attack Ductus#1662 I1, I4, R6, T1 to T7).
// pgTAP runs in one transaction and cannot race; here requests go through
// several real connections at once. A barrier holds the row of the service
// counter in an admin transaction until every request waits on a lock, then
// lets them all go, so they really meet in PostgreSQL.
//
// The route of step 4 is played by `flow`: begin_request, mark_sent, the
// synthetic port (no network, no secret), then complete, fail or
// outcome_unknown. After every scenario the counters equal the ledger.
//
// Every institution, person and text is invented; amounts are invented test
// values (T8), providers and models provider-test-a and model-test-1 (S4).
// The service scope is shared by the whole database, so this file publishes
// its own service caps and takes them, and every row it wrote, away at the
// end (pgTAP 170 and 171 run on the same database afterwards). Loopback only.
const SAFE_ADMIN_URL: string =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
requireLoopbackDatabaseUrl(
  SAFE_ADMIN_URL,
  "The assistant budget test runs only against a loopback database (DATABASE_URL).",
);
const suffix = randomBytes(5).toString("hex");
const applicationName = `it_assistant_budget_${suffix}`;
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
      `it-assistant-${suffix}-${institutions.length}`,
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

describe("assistant budget: empty configuration (P1, Z13)", () => {
  it("refuses with ai_disabled before any reservation, then with any limit missing", async () => {
    const w = await world(1);
    const student = w.students[0]!;
    expect((await flow(student, input(w))).final).toBe("ai_disabled");
    await cap(w.institutionId, HUGE, "day");
    expect((await flow(student, input(w))).final).toBe("ai_disabled");
    await limits(w, HUGE, HUGE, null);
    expect((await flow(student, input(w))).final).toBe("ai_disabled");
    await limits(w, null, HUGE, R);
    expect((await flow(student, input(w))).final).toBe("ai_disabled");
    await limits(w, HUGE, HUGE, R);
    expect((await flow(student, input(w))).final).toBe("completed");
    const rows = await admin.query(
      "SELECT 1 FROM assistant.cost_ledger WHERE institution_id = $1",
      [w.institutionId],
    );
    expect(rows.rowCount).toBe(1);
    expect(await drift()).toEqual([]);
  });
});

describe("assistant budget: k left, many at once (I1), for each of the four limits", () => {
  const K = 2;
  const N = 6;

  async function check(w: World, flows: Flow[]) {
    expect(count(flows, "completed")).toBe(K);
    expect(count(flows, "budget_exceeded")).toBe(N - K);
    expect(flows.filter((f) => f.portCalled)).toHaveLength(K);
    const reserved = await admin.query(
      "SELECT 1 FROM assistant.cost_ledger WHERE institution_id = $1",
      [w.institutionId],
    );
    expect(reserved.rowCount).toBe(K);
    expect(await drift()).toEqual([]);
  }

  it("student_assignment_day: one student, one assignment", async () => {
    const w = await configured(1, { assignmentDay: BigInt(K) * R });
    const student = w.students[0]!;
    await check(w, await race(Array.from({ length: N }, () => () => flow(student, input(w)))));
    expect(
      await used("student_assignment_day", `${w.institutionId}:${student.id}:${w.assignmentId}`),
    ).toBe(BigInt(K) * R);
  });

  it("student_day: one student over two assignments", async () => {
    const w = await configured(1, { day: BigInt(K) * R });
    const student = w.students[0]!;
    const flows = await race(
      Array.from(
        { length: N },
        (_, i) => () =>
          flow(student, input(w, { assignmentId: i % 2 ? w.secondAssignmentId : w.assignmentId })),
      ),
    );
    await check(w, flows);
    expect(await used("student_day", `${w.institutionId}:${student.id}`)).toBe(BigInt(K) * R);
  });

  it.each(["day", "month"] as const)(
    "institution_cap with a %s period: many students",
    async (period) => {
      const w = await configured(N, { cap: BigInt(K) * R, period });
      await check(w, await race(w.students.map((s) => () => flow(s, input(w)))));
      expect(await used("institution_cap", w.institutionId)).toBe(BigInt(K) * R);
      const ledger = await admin.query<{ p: string; d: string }>(
        "SELECT DISTINCT institution_cap_period_start::text AS p, budget_day::text AS d FROM assistant.cost_ledger WHERE institution_id = $1",
        [w.institutionId],
      );
      const { p, d } = ledger.rows[0]!;
      expect(p).toBe(period === "day" ? d : `${d.slice(0, 8)}01`);
    },
  );

  it.each(["day", "month"] as const)(
    "service_cap with a %s period: students of two institutions",
    async (period) => {
      const a = await configured(N / 2);
      const b = await configured(N / 2);
      await cap(null, HUGE, period);
      const p = await serviceCounterPeriod();
      const now = BigInt(
        (
          await admin.query<{ u: string }>(
            "SELECT used_micro::text AS u FROM assistant.budget_counter WHERE scope = 'service_cap' AND period_start = $1",
            [p],
          )
        ).rows[0]!.u,
      );
      await cap(null, now + BigInt(K) * R, period);
      try {
        const flows = await race([
          ...a.students.map((s) => () => flow(s, input(a))),
          ...b.students.map((s) => () => flow(s, input(b))),
        ]);
        expect(count(flows, "completed")).toBe(K);
        expect(count(flows, "budget_exceeded")).toBe(N - K);
        expect(flows.filter((f) => f.portCalled)).toHaveLength(K);
        expect(await drift()).toEqual([]);
      } finally {
        await cap(null, HUGE, "month");
      }
    },
  );
});

describe("assistant budget: limits one by one (T1 to T5)", () => {
  it("keeps students apart: one at the day limit does not stop another", async () => {
    const w = await configured(2, { day: R });
    const [ana, dora] = w.students as [Person, Person];
    expect((await flow(ana, input(w))).final).toBe("completed");
    expect((await flow(ana, input(w))).final).toBe("budget_exceeded");
    expect((await flow(dora, input(w))).final).toBe("completed");
    expect(await drift()).toEqual([]);
  });

  it("a cap of zero refuses everyone and moves no counter", async () => {
    const w = await configured(3, { cap: 0n });
    const flows = await Promise.all(w.students.map((s) => flow(s, input(w))));
    expect(flows.map((f) => f.final)).toEqual([
      "budget_exceeded",
      "budget_exceeded",
      "budget_exceeded",
    ]);
    expect(await used("institution_cap", w.institutionId)).toBe(0n);
    expect(await drift()).toEqual([]);
  });

  it("the cap lowered below the student limits wins (T2)", async () => {
    const w = await configured(1, { cap: 10n * R, day: 5n * R, assignmentDay: 5n * R });
    const student = w.students[0]!;
    await cap(w.institutionId, R, "day");
    expect((await flow(student, input(w))).final).toBe("completed");
    expect((await flow(student, input(w))).final).toBe("budget_exceeded");
    expect(await drift()).toEqual([]);
  });

  it("refuses a publication of a limit above the cap and changes nothing (T2)", async () => {
    const w = await configured(1, { cap: 10n * R });
    const before = await versionOf(w.institutionId);
    const answer = await port.publishCostConfig(w.admin.token, {
      expectedVersion: before,
      studentDayMicro: 11n * R,
      studentAssignmentDayMicro: R,
      reserveMicro: R,
    });
    expect(answer).toEqual({ status: "limit_above_cap", version: before });
    expect(await versionOf(w.institutionId)).toBe(before);
  });
});

describe("assistant budget: costs above the reservation (R6)", () => {
  it("k at once reserve exactly to the limit; each costs more; the overrun is the sum of the differences", async () => {
    const K = 3;
    const OVER = 2n;
    const w = await configured(1, { assignmentDay: BigInt(K) * R });
    const student = w.students[0]!;
    const over = (): SyntheticBranch => ({
      branch: "over_reservation",
      reservedMicro: R,
      overMicro: OVER,
    });
    const flows = await race(
      Array.from(
        { length: K },
        () => () => flow(student, input(w), createSyntheticAssistant(over())),
      ),
    );
    expect(count(flows, "completed")).toBe(K);
    const key = `${w.institutionId}:${student.id}:${w.assignmentId}`;
    expect(await used("student_assignment_day", key)).toBe(BigInt(K) * (R + OVER));
    expect(await drift()).toEqual([]);
    expect((await flow(student, input(w))).final).toBe("budget_exceeded");
    expect(await used("student_assignment_day", key)).toBe(BigInt(K) * (R + OVER));
  });
});

describe("assistant budget: settling while a new request meets the edge (I4)", () => {
  it("never lets the sum pass the limit", async () => {
    const w = await configured(1, { day: 2n * R });
    const student = w.students[0]!;
    const lost = await flow(student, input(w), createSyntheticAssistant({ branch: "timeout" }));
    expect(lost.final).toBe("outcome_unknown");
    const worker = async (text: string, values: readonly unknown[]) => {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE ductus_worker");
        const result = await client.query<Record<string, unknown>>(text, [...values]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const [settled, b, c] = await race<unknown>(
      [
        () => sweepAndSettle(worker, lost.requestId!),
        () => flow(student, input(w)),
        () => flow(student, input(w)),
      ],
      2,
    );
    expect(settled).toEqual({ status: "ok", state: "settled" });
    expect([(b as Flow).final, (c as Flow).final].sort()).toEqual(["budget_exceeded", "completed"]);
    expect(await used("student_day", `${w.institutionId}:${student.id}`)).toBe(2n * R);
    // Twice settles once.
    expect(await sweepAndSettle(worker, lost.requestId!)).toEqual({
      status: "ok",
      state: "settled",
    });
    expect(await used("student_day", `${w.institutionId}:${student.id}`)).toBe(2n * R);
    expect(await drift()).toEqual([]);
  });
});

describe("assistant budget: periods (T6)", () => {
  it("counts a calendar day in Europe/Zagreb", async () => {
    const days = await admin.query<{ d: string }>(
      `SELECT assistant.budget_day(t)::text AS d FROM unnest(ARRAY[
         '2026-11-21 22:59:59.999+00', '2026-11-21 23:00:00+00', '2026-07-01 21:59:59.999+00', '2026-07-01 22:00:00+00'
       ]::timestamptz[]) AS t`,
    );
    expect(days.rows.map((r) => r.d)).toEqual([
      "2026-11-21",
      "2026-11-22",
      "2026-07-01",
      "2026-07-02",
    ]);
  });

  it("settles after midnight into yesterday's counters, and today starts afresh", async () => {
    const w = await configured(1, { day: R });
    const student = w.students[0]!;
    // A request reserved and sent yesterday (Zagreb) that filled the day:
    // written as the owner role with yesterday's keys, as begin_request would have.
    const yesterday = await admin.connect();
    let requestId = "";
    try {
      await yesterday.query("BEGIN");
      await yesterday.query("SET LOCAL ROLE ductus_identity");
      const conv = await yesterday.query<{ id: string }>(
        "INSERT INTO assistant.conversation (institution_id, student_id, assignment_id) VALUES ($1, $2, $3) RETURNING id",
        [w.institutionId, student.id, w.assignmentId],
      );
      const req = await yesterday.query<{ id: string }>(
        `INSERT INTO assistant.request (institution_id, student_id, assignment_id, assignment_version, conversation_id,
           idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version,
           state, requested_at, sent_at)
         VALUES ($1, $2, $3, 1, $4, $5, repeat('b', 64), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1',
                 'sent', now() - interval '1 day', now() - interval '1 day') RETURNING id`,
        [w.institutionId, student.id, w.assignmentId, conv.rows[0]!.id, randomUUID()],
      );
      requestId = req.rows[0]!.id;
      await yesterday.query(
        `INSERT INTO assistant.message (conversation_id, institution_id, seq, request_id, role, content, content_sha256)
         VALUES ($1, $2, 1, $3, 'student_paragraph', 'Jučerašnji izmišljeni odlomak.',
                 encode(sha256(convert_to('Jučerašnji izmišljeni odlomak.', 'UTF8')), 'hex'))`,
        [conv.rows[0]!.id, w.institutionId, requestId],
      );
      await yesterday.query(
        `INSERT INTO assistant.cost_ledger (request_id, institution_id, student_id, assignment_id, budget_day,
           institution_cap_period_start, service_cap_period_start, reserved_micro, state, reserved_at)
         SELECT $1, $2, $3, $4, d, d, date_trunc('month', d)::date, $5, 'reserved', now() - interval '1 day'
           FROM (SELECT assistant.budget_day(now() - interval '1 day') AS d) x`,
        [requestId, w.institutionId, student.id, w.assignmentId, R.toString()],
      );
      for (const [scope, key, period] of [
        ["service_cap", "", "date_trunc('month', d)::date"],
        ["institution_cap", w.institutionId, "d"],
        ["student_day", `${w.institutionId}:${student.id}`, "d"],
        ["student_assignment_day", `${w.institutionId}:${student.id}:${w.assignmentId}`, "d"],
      ] as const) {
        await yesterday.query(
          `INSERT INTO assistant.budget_counter (scope, scope_key, institution_id, period_start, used_micro)
           SELECT $1, $2, $3, ${period}, $4 FROM (SELECT assistant.budget_day(now() - interval '1 day') AS d) x
           ON CONFLICT (scope, scope_key, period_start) DO UPDATE SET used_micro = assistant.budget_counter.used_micro + EXCLUDED.used_micro`,
          [scope, key, scope === "service_cap" ? null : w.institutionId, R.toString()],
        );
      }
      await yesterday.query("COMMIT");
    } catch (error) {
      await yesterday.query("ROLLBACK");
      throw error;
    } finally {
      yesterday.release();
    }
    expect(await drift()).toEqual([]);
    // Today the full day of yesterday does not count.
    expect(
      (await flow(student, input(w), createSyntheticAssistant({ branch: "timeout" }))).final,
    ).toBe("outcome_unknown");
    const todayKey = `${w.institutionId}:${student.id}`;
    const dayOf = async (offset: string) =>
      BigInt(
        (
          await admin.query<{ u: string }>(
            `SELECT coalesce(sum(used_micro), 0)::text AS u FROM assistant.budget_counter
              WHERE scope = 'student_day' AND scope_key = $1 AND period_start = assistant.budget_day(now() - $2::interval)`,
            [todayKey, offset],
          )
        ).rows[0]!.u,
      );
    expect(await dayOf("0")).toBe(R);
    // Yesterday's response arrives today: it settles into yesterday's counters.
    expect(await port.complete(student.token, requestId, "Izmišljeni odgovor.", 3n)).toMatchObject({
      state: "completed",
    });
    expect(await dayOf("1 day")).toBe(3n);
    expect(await dayOf("0")).toBe(R);
    expect(await drift()).toEqual([]);
  });

  it("a monthly service cap with a daily institution cap settles into the period it reserved in, after a new period is published", async () => {
    await cap(null, HUGE, "month");
    const w = await configured(1, { period: "day" });
    const student = w.students[0]!;
    const begun = await flow(student, input(w), createSyntheticAssistant({ branch: "timeout" }));
    expect(begun.final).toBe("outcome_unknown");
    const keys = (
      await admin.query<{ s: string; i: string; d: string }>(
        `SELECT service_cap_period_start::text AS s, institution_cap_period_start::text AS i, budget_day::text AS d
           FROM assistant.cost_ledger WHERE request_id = $1`,
        [begun.requestId],
      )
    ).rows[0]!;
    expect(keys.s).toBe(`${keys.d.slice(0, 8)}01`);
    expect(keys.i).toBe(keys.d);
    try {
      await cap(null, HUGE, "day");
      await cap(w.institutionId, HUGE, "month");
      const worker = async (text: string, values: readonly unknown[]) => {
        const client = await admin.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE ductus_worker");
          const result = await client.query<Record<string, unknown>>(text, [...values]);
          await client.query("COMMIT");
          return result;
        } finally {
          client.release();
        }
      };
      expect(await sweepAndSettle(worker, begun.requestId!)).toEqual({
        status: "ok",
        state: "settled",
      });
      const after = (
        await admin.query<{ s: string; i: string }>(
          `SELECT service_cap_period_start::text AS s, institution_cap_period_start::text AS i
             FROM assistant.cost_ledger WHERE request_id = $1`,
          [begun.requestId],
        )
      ).rows[0]!;
      expect(after).toEqual({ s: keys.s, i: keys.i });
      expect(await drift()).toEqual([]);
      // A new request now reserves under the new periods.
      expect((await flow(student, input(w))).final).toBe("completed");
      const fresh = (
        await admin.query<{ s: string; i: string; d: string }>(
          `SELECT service_cap_period_start::text AS s, institution_cap_period_start::text AS i, budget_day::text AS d
             FROM assistant.cost_ledger WHERE institution_id = $1 ORDER BY reserved_at DESC, request_id LIMIT 1`,
          [w.institutionId],
        )
      ).rows[0]!;
      expect(fresh.s).toBe(fresh.d);
      expect(fresh.i).toBe(`${fresh.d.slice(0, 8)}01`);
      expect(await drift()).toEqual([]);
    } finally {
      await cap(null, HUGE, "month");
    }
  });
});
