// SRV-ULOGA-POTVRDA-OPOZIV: the two teacher role routes on a real server with
// the real pipeline. The database is a stand-in that answers each statement
// the route sends; who may, the audit row and the repeated request are proven
// against PostgreSQL in teacher-roles.pg.integration.test.ts. Every vector of
// both contracts a socket can reach is sent as its bytes; a refusal before the
// database leaves it unasked. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { CONFIRMATION_ID, createTeacherRoleRoutes, REVOCATION_ID } from "./index.ts";

type Vector = {
  name: string;
  request: {
    params: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;

type Kind = "confirmation" | "revocation";
const ROUTE: Record<Kind, { id: string; path: (teacherId: string) => string }> = {
  confirmation: {
    id: CONFIRMATION_ID,
    path: (id) => `/api/v1/institution/teachers/${id}/role-confirmation`,
  },
  revocation: {
    id: REVOCATION_ID,
    path: (id) => `/api/v1/institution/teachers/${id}/role-revocation`,
  },
};
const ORIGIN = vectorsOf(CONFIRMATION_ID)[0]!.request.headers.origin!;

/** One statement's answer: rows, or an error carrying a SQLSTATE. */
type Step = { rows: Record<string, unknown>[] } | { error: unknown };
const ADMIN: Step = { rows: [{ userId: "a0000000-0000-4000-8000-000000000001", admin: true }] };
const TEACHER: Step = { rows: [{ userId: "a0000000-0000-4000-8000-000000000002", admin: false }] };
const NO_SESSION: Step = { rows: [{ userId: null, admin: false }] };
const VOID: Step = { rows: [{}] };
const sqlError = (code: string): Step => ({ error: Object.assign(new Error(code), { code }) });

let server: Running | undefined;
let script: Step[] = [];
const statements: { sql: string; args: readonly unknown[] }[] = [];
const actors: unknown[] = [];
const activity: string[] = [];

const withActor: WithActor = async (token, run) => {
  actors.push(token);
  const tx: ActorTransaction = {
    async query<Row>(sql: string, args: readonly unknown[] = []) {
      statements.push({ sql, args });
      const step = script.shift();
      if (step === undefined) throw new Error(`unexpected statement ${sql}`);
      if ("error" in step) throw step.error;
      return { rows: step.rows as Row[], rowCount: step.rows.length };
    },
  } as ActorTransaction;
  return run(tx);
};

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createTeacherRoleRoutes({
      withActor,
      recordActivity: async (token) => activity.push(token),
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  script = [];
  statements.length = 0;
  actors.length = 0;
  activity.length = 0;
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = (): Answer => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      return { status: Number(head.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n") };
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\r\n\r\n")) return;
      const got = finish();
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function raw(path: string, headers: [string, string][], body: string): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
/** What the database answers for each vector that reaches it. */
const SCRIPT: Record<Kind, Record<string, Step[]>> = {
  confirmation: {
    confirmed: [ADMIN, VOID],
    forbidden: [TEACHER],
    "not-found": [ADMIN, sqlError("ZD403")],
    unavailable: [ADMIN, sqlError("57P01")],
  },
  revocation: {
    true: [{ rows: [{ revoked: true }] }],
    false: [{ rows: [{ revoked: false }] }],
    forbidden: [sqlError("ZD403")],
    unavailable: [sqlError("57P01")],
  },
};

const cases = (Object.keys(ROUTE) as Kind[]).flatMap((kind) =>
  vectorsOf(ROUTE[kind].id)
    .filter((v) => !UNREACHABLE.has(v.name))
    .map((v) => [`${ROUTE[kind].id} ${v.name}`, kind, v] as const),
);

describe("every vector a socket can reach", () => {
  it.each(cases)("%s", async (_name, kind, v) => {
    const steps = SCRIPT[kind][v.name];
    script = [...(steps ?? [])];
    await start();
    const body = v.request.rawBody ?? JSON.stringify(v.request.body);
    const got = await send(
      raw(ROUTE[kind].path(v.request.params.teacherId!), Object.entries(v.request.headers), body),
    );
    expect(got.status).toBe(v.response.status);
    if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
    expect(got.head["content-type"]?.split(";")[0]).toBe("application/json");
    expect(got.head["cache-control"]).toBe("no-store");
    const json = JSON.parse(got.body) as Record<string, unknown>;
    if (got.status < 300) expect(json).toEqual(v.response.body);
    else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
    const token = v.request.headers.cookie?.slice("__Host-ductus_session=".length);
    expect(actors).toEqual(steps === undefined ? [] : [token]);
    expect(script).toEqual([]);
    expect(activity).toEqual(got.status < 300 ? [token] : []);
  });
});

describe("what reaches the database", () => {
  const confirmed = vectorsOf(CONFIRMATION_ID).find((v) => v.name === "confirmed")!;
  const headers = Object.entries(confirmed.request.headers);
  const TEACHER_ID = confirmed.request.params.teacherId!;

  it("confirmation reads the caller first, then confirms the path's id in lower case", async () => {
    script = [ADMIN, VOID];
    await start();
    const got = await send(raw(ROUTE.confirmation.path(TEACHER_ID.toUpperCase()), headers, "{}"));
    expect(got.status).toBe(200);
    expect(statements).toEqual([
      {
        sql: `SELECT a.user_id AS "userId", institution.actor_has_role('admin') AS admin FROM app.current_actor() a`,
        args: [],
      },
      { sql: "SELECT institution.confirm_teacher_role($1)", args: [TEACHER_ID] },
    ]);
  });

  it("revocation sends only the path's id in lower case", async () => {
    script = [{ rows: [{ revoked: true }] }];
    await start();
    const got = await send(raw(ROUTE.revocation.path(TEACHER_ID.toUpperCase()), headers, "{}"));
    expect(JSON.parse(got.body)).toEqual({ revoked: true });
    expect(statements).toEqual([
      { sql: "SELECT institution.revoke_teacher_role($1) AS revoked", args: [TEACHER_ID] },
    ]);
  });

  it("a caller who is not an administrator never reaches the confirmation", async () => {
    script = [TEACHER];
    await start();
    const got = await send(raw(ROUTE.confirmation.path(TEACHER_ID), headers, "{}"));
    expect(got.status).toBe(403);
    expect(statements).toHaveLength(1);
  });

  it("a session the database no longer knows is 401 on both routes", async () => {
    await start();
    script = [NO_SESSION];
    expect((await send(raw(ROUTE.confirmation.path(TEACHER_ID), headers, "{}"))).status).toBe(401);
    script = [ADMIN, sqlError("ZD401")];
    expect((await send(raw(ROUTE.confirmation.path(TEACHER_ID), headers, "{}"))).status).toBe(401);
    script = [sqlError("ZD401")];
    expect((await send(raw(ROUTE.revocation.path(TEACHER_ID), headers, "{}"))).status).toBe(401);
    expect(activity).toEqual([]);
  });

  it("a ZD403 before the caller was read as an administrator stays 403, not 404", async () => {
    script = [sqlError("ZD403")];
    await start();
    const got = await send(raw(ROUTE.confirmation.path(TEACHER_ID), headers, "{}"));
    expect(got.status).toBe(403);
  });

  it("an answer that is not what the functions return is 503 and counts no activity", async () => {
    await start();
    const twice = { rows: [...(ADMIN as { rows: [] }).rows, ...(ADMIN as { rows: [] }).rows] };
    for (const steps of [
      [{ rows: [{ userId: "a0000000-0000-4000-8000-000000000001", admin: "yes" }] }],
      [twice],
      [ADMIN, { rows: [] }],
      [ADMIN, { rows: [{}, {}] }],
    ] as Step[][]) {
      script = [...steps];
      expect((await send(raw(ROUTE.confirmation.path(TEACHER_ID), headers, "{}"))).status).toBe(
        503,
      );
    }
    for (const rows of [[], [{ revoked: "true" }], [{ revoked: true }, { revoked: false }]]) {
      script = [{ rows }];
      expect((await send(raw(ROUTE.revocation.path(TEACHER_ID), headers, "{}"))).status).toBe(503);
    }
    expect(activity).toEqual([]);
  });

  it("a body other than {} is 422 without asking the database", async () => {
    await start();
    for (const body of ['{"teacherId":"x"}', "[]", "null", '""', "0", '{"__proto__":{}}']) {
      expect((await send(raw(ROUTE.confirmation.path(TEACHER_ID), headers, body))).status).toBe(
        422,
      );
      expect((await send(raw(ROUTE.revocation.path(TEACHER_ID), headers, body))).status).toBe(422);
    }
    expect(actors).toEqual([]);
  });

  it("a path id that is not one UUID is 422 without asking the database", async () => {
    await start();
    for (const id of [`${TEACHER_ID}x`, "%E0%A4%A", `${TEACHER_ID.slice(0, 35)}%00`, "%20"]) {
      expect((await send(raw(ROUTE.confirmation.path(id), headers, "{}"))).status).toBe(422);
      expect((await send(raw(ROUTE.revocation.path(id), headers, "{}"))).status).toBe(422);
    }
    expect(actors).toEqual([]);
  });
});
