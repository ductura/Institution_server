import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  createAssistantRequests,
  createAssistantTools,
  createWithActor,
  type BeginRequestInput,
} from "../../server/database/index.ts";
import {
  createSyntheticAssistant,
  type SyntheticBranch,
} from "../../server/external/assistant/index.ts";
import {
  createSearchGuard,
  runToolLoop,
  type SearchTransport,
  type ToolLoopResult,
} from "../../server/external/assistant-tools/index.ts";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

// SRV-1207 (M9.0-S3, Ductus#2052): the rows of "Istodobnost" of Ductus
// docs/contracts/ai-tools-v1.md (plan of attack Ductus#1664 S3-Z1, S3-I2) on
// PostgreSQL. pgTAP 173 runs in one transaction and cannot race; here the
// teacher, the student and the route use separate real connections. The
// route's part is played by the loop it drives (runToolLoop over the real
// adapters of server/database and the synthetic port), with the tools the
// server permits handed in as the route hands them in; the faculty setting of
// the pilot permits none, so these tests hand in web_search themselves.
//
// Every institution, person and text is invented; amounts are invented test
// values, providers and models provider-test-a and model-test-1. The service
// scope is shared by the whole database, so this file publishes its own
// service cap and takes it, and every row it wrote, away at the end.
const SAFE_ADMIN_URL: string =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
requireLoopbackDatabaseUrl(
  SAFE_ADMIN_URL,
  "The assistant tools test runs only against a loopback database (DATABASE_URL).",
);
const suffix = randomBytes(5).toString("hex");
const admin = new pg.Pool({ connectionString: SAFE_ADMIN_URL, max: 4 });
const app = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 12,
  application_name: `it_assistant_tools_${suffix}`,
});
const withActor = createWithActor(app);
const requests = createAssistantRequests(withActor);
const tools = createAssistantTools(withActor);

const R = 7n; // one reservation, an invented amount
const HUGE = 1_000_000_000_000n;
const OFFERED = ["web_search"] as const;
const institutions: string[] = [];
const serviceVersions: string[] = [];

type Person = { id: string; token: string };
type World = {
  institutionId: string;
  courseId: string;
  assignmentId: string;
  teacher: Person;
  student: Person;
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

/** A configured institution: a teacher and a student of a course with one assignment. */
async function world(): Promise<World> {
  const institutionId = randomUUID();
  institutions.push(institutionId);
  const client = await admin.connect();
  let w: World;
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      institutionId,
      `it-tools-${suffix}-${institutions.length}`,
    ]);
    await client.query(
      `INSERT INTO institution.institution_settings (institution_id, display_name) VALUES ($1, 'Izmišljeni fakultet')`,
      [institutionId],
    );
    const adm = await person(client, institutionId, "admin");
    const teacher = await person(client, institutionId, "teacher");
    const student = await person(client, institutionId, "student");
    await client.query("SELECT institution.appoint_institution_admin($1, $2)", [
      adm.id,
      `Zahtjev ${suffix}`,
    ]);
    await client.query(
      `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
       VALUES ($1, $2, 'teacher', $3, now())`,
      [institutionId, teacher.id, adm.id],
    );
    const courseId = randomUUID();
    await client.query(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, 'Izmišljeni kolegij', '2026/2027', 'encouraged', $3)`,
      [courseId, institutionId, teacher.id],
    );
    for (const [user, role] of [
      [teacher, "teacher"],
      [student, "student"],
    ] as const) {
      await client.query(
        `INSERT INTO institution.course_member (course_id, institution_id, user_id, role) VALUES ($1, $2, $3, $4)`,
        [courseId, institutionId, user.id, role],
      );
    }
    const assignmentId = randomUUID();
    await client.query(
      `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
       VALUES ($1, $2, $3, 1, $4)`,
      [assignmentId, courseId, institutionId, teacher.id],
    );
    await client.query(
      `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type, opens_at,
         due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
       VALUES ($1, 1, 'Izmišljeni zadatak', 'Izmišljene upute.', 'essay', now(), now() + interval '30 days',
               'encouraged', '{literature_search}', 'basic', false, $2)`,
      [assignmentId, teacher.id],
    );
    await client.query("COMMIT");
    w = { institutionId, courseId, assignmentId, teacher, student };
    // The caps of the operator and the limits of the administrator.
    await cap(institutionId);
    const published = await requests.publishCostConfig(adm.token, {
      expectedVersion: await versionOf(institutionId),
      studentDayMicro: HUGE,
      studentAssignmentDayMicro: HUGE,
      reserveMicro: R,
    });
    expect(published).toMatchObject({ status: "published" });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return w;
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

async function cap(institutionId: string): Promise<void> {
  await admin.query("SELECT assistant.publish_cost_cap($1, $2, $3, 'day', $4)", [
    institutionId,
    await versionOf(institutionId),
    HUGE.toString(),
    `Zahtjev ${suffix}`,
  ]);
  if (serviceVersions.length === 0) {
    const version = await versionOf(null);
    await admin.query("SELECT assistant.publish_cost_cap(NULL, $1, $2, 'month', $3)", [
      version,
      HUGE.toString(),
      `Zahtjev ${suffix}/s`,
    ]);
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

const input = (w: World, over: Partial<BeginRequestInput> = {}): BeginRequestInput => ({
  idempotencyKey: randomUUID(),
  assignmentId: w.assignmentId,
  conversationId: null,
  purposeCatalogVersion: 1,
  purposeKey: "literature_search",
  paragraph: "Izmišljeni odlomak o gradskim vrtovima.",
  providerId: "provider-test-a",
  modelId: "model-test-1",
  configVersion: "test-1",
  offeredTools: [...OFFERED],
  ...over,
});

const DESTINATION = {
  id: "trazilica-a",
  endpoint: "https://trazilica-a.invalid/search",
  queryParameter: "q",
};
/** A fake transport: counts every outbound call; never a real connection. */
function transport(): SearchTransport & { gets: number } {
  const t = {
    gets: 0,
    resolve: () => Promise.resolve(["93.184.216.34"]),
    get: () => {
      t.gets += 1;
      return Promise.resolve({ status: 200, text: "Izmišljeni rezultat.", overflow: false });
    },
  };
  return t;
}

/** begin_request, mark_sent and the loop of the route, with a hook before each port call. */
async function routeOf(
  w: World,
  script: readonly SyntheticBranch[],
  beforeCall: (n: number) => Promise<void> = () => Promise.resolve(),
  over: Partial<BeginRequestInput> = {},
) {
  const port = createSyntheticAssistant(script);
  const net = transport();
  const begun = await requests.begin(w.student.token, input(w, over));
  if (begun.status !== "ok") throw new Error(`begin: ${begun.status}`);
  const sent = await requests.markSent(w.student.token, begun.requestId);
  expect(sent).toMatchObject({ status: "ok", state: "sent" });
  let calls = 0;
  const result: ToolLoopResult = await runToolLoop(
    {
      callPort: async (portInput) => {
        await beforeCall((calls += 1));
        return port.complete(portInput);
      },
      beginStep: async (step) => {
        const got = await tools.beginToolStep(w.student.token, {
          requestId: begun.requestId,
          ...step,
          offeredTools: [...OFFERED],
        });
        return got.status === "ok" ? got : { status: "refused" };
      },
      finishStep: async (finish) =>
        (await tools.finishToolStep(w.student.token, { requestId: begun.requestId, ...finish }))
          .status === "ok",
      guard: createSearchGuard({ destinations: [DESTINATION], transport: net }),
    },
    {
      instructions: "Izmišljene upute poslužitelja.",
      history: [],
      paragraph: "Izmišljeni odlomak o gradskim vrtovima.",
      purposeKey: "literature_search",
      modelId: "model-test-1",
      tools: begun.tools.filter((name): name is "web_search" => name === "web_search"),
    },
  );
  // The route's settlement.
  if (result.kind === "success") {
    await requests.complete(w.student.token, begun.requestId, result.text, result.totalMicro);
  } else if (result.kind === "provider_error") {
    await requests.fail(w.student.token, begun.requestId, result.totalMicro);
  } else if (result.kind !== "unknown") {
    await requests.fail(w.student.token, begun.requestId, result.totalMicro, result.kind);
  }
  return { begun, result, port, net };
}

const row = async (requestId: string) =>
  (
    await admin.query<{
      state: string;
      reason: string | null;
      actual: string | null;
      reserved: string;
      steps: string;
    }>(
      `SELECT r.state, r.reason, l.actual_micro::text AS actual, l.reserved_micro::text AS reserved,
              coalesce((SELECT string_agg(s.step_no || ':' || s.outcome, ',' ORDER BY s.step_no)
                          FROM assistant.tool_step s WHERE s.request_id = r.id), '') AS steps
         FROM assistant.request r JOIN assistant.cost_ledger l ON l.request_id = r.id WHERE r.id = $1`,
      [requestId],
    )
  ).rows[0]!;

const drift = async (institutionId: string) =>
  Number(
    (
      await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM assistant.budget_counter b
          WHERE b.institution_id = $1 AND b.used_micro <> coalesce((
            SELECT sum(coalesce(l.actual_micro, l.reserved_micro)) FROM assistant.cost_ledger l
             WHERE l.state IN ('reserved', 'settled') AND l.institution_id = $1 AND CASE b.scope
               WHEN 'institution_cap' THEN l.institution_cap_period_start = b.period_start
               WHEN 'student_day' THEN l.institution_id || ':' || l.student_id = b.scope_key AND l.budget_day = b.period_start
               ELSE l.institution_id || ':' || l.student_id || ':' || l.assignment_id = b.scope_key AND l.budget_day = b.period_start
             END), 0)`,
        [institutionId],
      )
    ).rows[0]!.n,
  );

const turnOn = async (w: World) => {
  const read = await tools.readAssignmentTools(w.teacher.token, w.assignmentId);
  if (read.status !== "ok") throw new Error(read.status);
  expect(
    await tools.setAssignmentTools(w.teacher.token, w.assignmentId, read.version, ["web_search"]),
  ).toMatchObject({
    status: "ok",
  });
};
const turnOff = async (w: World) => {
  const read = await tools.readAssignmentTools(w.teacher.token, w.assignmentId);
  if (read.status !== "ok") throw new Error(read.status);
  expect(
    await tools.setAssignmentTools(w.teacher.token, w.assignmentId, read.version, []),
  ).toMatchObject({
    status: "ok",
  });
};

const search = (query: string) => ({ name: "web_search", args: { query } });

afterAll(async () => {
  try {
    await app.end();
  } finally {
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
      // Children first: the steps, loops and trail reference the requests and settings.
      for (const t of [
        "assistant.tool_step",
        "assistant.tool_loop_reservation",
        "audit.assistant_tool_setting_event",
        "assistant.assignment_tool_setting",
      ]) {
        await client.query(`DELETE FROM ${t} WHERE institution_id = ANY ($1)`, [institutions]);
      }
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

describe("the loop reservation and its settlement (S3-I2)", () => {
  it("reserves reserve × (1 + TOOL_STEP_MAX) and settles the sum of every call", async () => {
    const w = await world();
    await turnOn(w);
    const { begun, result, net } = await routeOf(w, [
      { branch: "tool_calls", calls: [search("gradski vrtovi")], actualMicro: 2n },
      { branch: "success", actualMicro: 3n, text: "Izmišljeni odgovor." },
    ]);
    expect(begun).toMatchObject({ state: "reserved", tools: ["web_search"] });
    expect(result).toEqual({ kind: "success", text: "Izmišljeni odgovor.", totalMicro: 5n });
    expect(net.gets).toBe(1);
    expect(await row(begun.requestId)).toEqual({
      state: "completed",
      reason: null,
      actual: "5",
      reserved: String(R * 4n),
      steps: "1:done",
    });
    expect(await drift(w.institutionId)).toBe(0);
  });

  it("an endless loop ends with tool_step_limit at the bound, settled at the calls made", async () => {
    const w = await world();
    await turnOn(w);
    const { begun, result, port } = await routeOf(w, [
      ...Array.from({ length: 4 }, (): SyntheticBranch => ({
        branch: "endless_tools",
        actualMicro: 1n,
      })),
    ]);
    expect(result).toEqual({ kind: "tool_step_limit", totalMicro: 4n });
    expect(port.calls).toHaveLength(4);
    expect(await row(begun.requestId)).toMatchObject({
      state: "provider_failed",
      reason: "tool_step_limit",
      actual: "4",
      steps: "1:done,2:done,3:done",
    });
    expect(await drift(w.institutionId)).toBe(0);
  });
});

describe("Istodobnost (S3-Z1)", () => {
  it("the teacher turns web_search off on another connection after step 1: denied_revoked, no further call", async () => {
    const w = await world();
    await turnOn(w);
    const { begun, result, port, net } = await routeOf(
      w,
      [
        { branch: "tool_calls", calls: [search("prvi")], actualMicro: 2n },
        { branch: "tool_calls", calls: [search("drugi")], actualMicro: 3n },
        { branch: "success", actualMicro: 9n },
      ],
      async (n) => {
        if (n === 2) await turnOff(w);
      },
    );
    expect(result).toEqual({ kind: "request_revoked", totalMicro: 5n });
    expect(port.calls).toHaveLength(2);
    expect(net.gets).toBe(1);
    expect(await row(begun.requestId)).toMatchObject({
      state: "provider_failed",
      reason: "request_revoked",
      actual: "5",
      steps: "1:done,2:denied_revoked",
    });
    expect(await drift(w.institutionId)).toBe(0);
  });

  it.each([
    ["a name outside CODE_TOOLS", { name: "code_interpreter", args: { query: "x" } }],
    ["a name differing only in case", { name: "Web_search", args: { query: "x" } }],
    [
      "arguments outside the schema",
      { name: "web_search", args: { query: "x", url: "https://zlo.invalid/" } },
    ],
  ])("after the revocation %s is still denied_revoked", async (_why, call) => {
    const w = await world();
    await turnOn(w);
    const { begun, result, port } = await routeOf(
      w,
      [
        { branch: "tool_calls", calls: [search("prvi")], actualMicro: 1n },
        { branch: "tool_calls", calls: [call], actualMicro: 1n },
      ],
      async (n) => {
        if (n === 2) await turnOff(w);
      },
    );
    expect(result).toEqual({ kind: "request_revoked", totalMicro: 2n });
    expect(port.calls).toHaveLength(2);
    expect((await row(begun.requestId)).steps).toBe("1:done,2:denied_revoked");
  });

  it("the course rule changed to prohibited between steps revokes the request", async () => {
    const w = await world();
    await turnOn(w);
    const { begun, result, port } = await routeOf(
      w,
      [
        { branch: "tool_calls", calls: [search("prvi")], actualMicro: 1n },
        { branch: "tool_calls", calls: [search("drugi")], actualMicro: 1n },
      ],
      async (n) => {
        if (n === 2)
          await admin.query(
            "UPDATE institution.course SET ai_policy = 'prohibited' WHERE id = $1",
            [w.courseId],
          );
      },
    );
    expect(result).toEqual({ kind: "request_revoked", totalMicro: 2n });
    expect(port.calls).toHaveLength(2);
    expect(await row(begun.requestId)).toMatchObject({ reason: "request_revoked", actual: "2" });
  });

  it("two set_assignment_tools with the same expected_version: one wins, the other version_conflict", async () => {
    const w = await world();
    const results = await Promise.all([
      tools.setAssignmentTools(w.teacher.token, w.assignmentId, 0, ["web_search"]),
      tools.setAssignmentTools(w.teacher.token, w.assignmentId, 0, []),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["ok", "version_conflict"]);
    const versions = await admin.query<{ v: number }>(
      "SELECT version_no AS v FROM assistant.assignment_tool_setting WHERE assignment_id = $1 ORDER BY 1",
      [w.assignmentId],
    );
    expect(versions.rows.map((r) => r.v)).toEqual([1]);
  });

  it("two begin_tool_step for the same step: one row and at most one execution", async () => {
    const w = await world();
    await turnOn(w);
    const begun = await requests.begin(w.student.token, input(w));
    if (begun.status !== "ok") throw new Error(begun.status);
    await requests.markSent(w.student.token, begun.requestId);
    const step = {
      requestId: begun.requestId,
      stepNo: 1,
      toolName: "web_search",
      requestedNameSha256: "a".repeat(64),
      argsSha256: "b".repeat(64),
      argsValid: true,
      offeredTools: [...OFFERED],
    };
    const results = await Promise.all([
      tools.beginToolStep(w.student.token, step),
      tools.beginToolStep(w.student.token, step),
    ]);
    expect(results.map((r) => (r.status === "ok" ? r.outcome : r.status)).sort()).toEqual([
      "allowed",
      "conflict",
    ]);
    expect((await row(begun.requestId)).steps).toBe("1:allowed");
  });

  it("a request begun with an empty set has no loop, even when the teacher turns the tool on meanwhile", async () => {
    const w = await world();
    const { begun, result, port } = await routeOf(
      w,
      [{ branch: "endless_tools", actualMicro: 2n }],
      async () => turnOn(w),
    );
    expect(begun.tools).toEqual([]);
    expect(result).toEqual({ kind: "tool_step_limit", totalMicro: 2n });
    expect(port.calls).toHaveLength(1);
    expect(
      await tools.beginToolStep(w.student.token, {
        requestId: begun.requestId,
        stepNo: 1,
        toolName: "web_search",
        requestedNameSha256: "a".repeat(64),
        argsSha256: "b".repeat(64),
        argsValid: true,
        offeredTools: [...OFFERED],
      }),
    ).toEqual({ status: "conflict" });
    expect(
      (
        await admin.query("SELECT 1 FROM assistant.tool_loop_reservation WHERE request_id = $1", [
          begun.requestId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await row(begun.requestId)).toMatchObject({
      reserved: String(R),
      reason: "tool_step_limit",
    });
  });

  it("the pilot: the server permits nothing, so no loop and no step, whatever the teacher set", async () => {
    const w = await world();
    await turnOn(w);
    const { begun, result, net } = await routeOf(
      w,
      [{ branch: "endless_tools", actualMicro: 1n }],
      undefined,
      {
        offeredTools: [],
      },
    );
    expect(begun.tools).toEqual([]);
    expect(result.kind).toBe("tool_step_limit");
    expect(net.gets).toBe(0);
    expect((await row(begun.requestId)).steps).toBe("");
  });
});
