// GET and POST /api/v1/institution/faculty-rules (SRV-2001) on a real server
// with the real pipeline, over a fake withActor: the vectors of both
// contracts, the framing of the body, the codes of the database mapped to
// statuses and 503 for a throw. Who may is the database's. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createFacultyRuleRoutes } from "./index.ts";

type Vector = {
  name: string;
  code?: string;
  request: { headers?: Record<string, string>; body?: Record<string, unknown>; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const load = (id: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const GET = load("institution.faculty-rules.get");
const POST = load("institution.faculty-rules.post");
const ORIGIN = "https://ductura.example.invalid";
const AT = new Date("2026-11-21T09:00:00.000Z");
const PATH = "/api/v1/institution/faculty-rules";

let running: Running | undefined;
const queries: { text: string; values: readonly unknown[] | undefined }[] = [];
let answer: (text: string) => unknown = () => ({ rows: [] });

async function start(): Promise<string> {
  const withActor = (async (
    _token: string | null | undefined,
    fn: (tx: ActorTransaction) => unknown,
  ) =>
    fn({
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return answer(text);
      },
    } as unknown as ActorTransaction)) as unknown as WithActor;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createFacultyRuleRoutes({ withActor }),
  });
  return `http://127.0.0.1:${running.port}${PATH}`;
}

afterEach(async () => {
  queries.length = 0;
  answer = () => ({ rows: [] });
  await running?.close();
  running = undefined;
});

const send = (url: string, v: Vector, init: RequestInit = {}) =>
  fetch(url, { headers: v.request.headers ?? {}, ...init });
const post = (url: string, v: Vector, body?: unknown) =>
  send(url, v, {
    method: "POST",
    body:
      body === undefined
        ? (v.request.rawBody ?? JSON.stringify(v.request.body))
        : JSON.stringify(body),
  });
const problem = async (got: Response) => ((await got.json()) as { code: string }).code;

const EMPTY = {
  authenticated: true,
  admin: true,
  work_type: null,
  version_no: null,
  ai_policy: null,
  ai_purposes: null,
  evidence_profile: null,
  import_allowed: null,
  origin: null,
  published_at: null,
};

describe("institution.faculty-rules.get", () => {
  const ready = GET.find((v) => v.name === "ready")!;
  const withCookie = GET.find((v) => v.name === "none-published")!;

  it("answers the versions per work type", async () => {
    answer = () => ({
      rows: [
        {
          authenticated: true,
          admin: true,
          work_type: "essay",
          version_no: 1,
          ai_policy: "partially_allowed",
          ai_purposes: ["formatting"],
          evidence_profile: "basic",
          import_allowed: false,
          origin: "administrator",
          published_at: AT,
        },
      ],
    });
    const got = await send(await start(), withCookie);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    const body = (await got.json()) as { rules: { workType: string; versions: unknown[] }[] };
    expect(body.rules).toHaveLength(7);
    expect(body.rules.find((r) => r.workType === "essay")!.versions).toHaveLength(1);
    expect(ready.response.status).toBe(200);
  });

  it("answers an institution without versions with seven empty entries", async () => {
    answer = () => ({ rows: [EMPTY] });
    const got = await send(await start(), withCookie);
    const body = (await got.json()) as { rules: { versions: unknown[] }[] };
    expect(body.rules.every((r) => r.versions.length === 0)).toBe(true);
  });

  it("answers an account without a session 401, a non-administrator 403, a throw 503", async () => {
    const base = await start();
    const un = GET.find((v) => v.name === "unauthorized")!;
    expect((await send(base, un)).status).toBe(401);
    answer = () => ({ rows: [{ ...EMPTY, admin: false }] });
    expect((await send(base, withCookie)).status).toBe(403);
    // A cookie whose session is closed (logout) is 401 before the role (ZEL-S10).
    answer = () => ({ rows: [{ ...EMPTY, authenticated: false, admin: false }] });
    const closed = await send(base, withCookie);
    expect([closed.status, await problem(closed)]).toEqual([401, "unauthorized"]);
    answer = () => {
      throw new Error("izmisljena greska");
    };
    expect((await send(base, withCookie)).status).toBe(503);
  });

  it("answers a query 422 before the database", async () => {
    const base = await start();
    const v = GET.find((x) => x.name === "invalid-input")!;
    expect((await send(`${base}?a=1`, v)).status).toBe(422);
    expect(queries).toEqual([]);
  });
});

describe("institution.faculty-rules.post", () => {
  const created = POST.find((v) => v.name === "created")!;

  it("publishes, passes 0 for no earlier version and answers the version and its time", async () => {
    answer = (text) =>
      text.includes("publish_faculty_rule_version")
        ? { rows: [{ version_no: 1 }] }
        : { rows: [{ version_no: 1, published_at: AT }] };
    const got = await post(await start(), created);
    expect(got.status).toBe(201);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toEqual({ versionNo: 1, publishedAt: AT.toISOString() });
    expect(queries[0]!.values).toEqual([
      "essay",
      0,
      "partially_allowed",
      ["formatting"],
      "basic",
      false,
    ]);
  });

  it.each([
    ["ZD401", "unauthorized", 401],
    ["ZD403", "forbidden", 403],
    ["ZD409", "conflict", 409],
    ["ZD422", "invalid_input", 422],
  ])("maps %s to %s", async (sqlstate, code, http) => {
    answer = () => {
      throw Object.assign(new Error("x"), { code: sqlstate });
    };
    const got = await post(await start(), created);
    expect(got.status).toBe(http);
    expect(await problem(got)).toBe(code);
  });

  it.each([
    "unknown-key",
    "invalid-work-type",
    "invalid-ai-policy",
    "invalid-ai-purposes",
    "invalid-evidence-profile",
  ])("answers vector %s 422 with the code of its field, before the database", async (name) => {
    const v = POST.find((x) => x.name === name)!;
    const got = await post(await start(), v);
    expect(got.status).toBe(422);
    expect(await got.json()).toEqual({
      ...v.response.body,
      requestId: got.headers.get("x-request-id"),
    });
    expect(queries).toEqual([]);
  });

  it("refuses purposes that repeat", async () => {
    const got = await post(await start(), created, {
      ...created.request.body,
      aiPurposes: ["formatting", "formatting"],
    });
    expect(await problem(got)).toBe("invalid_ai_purposes");
  });

  it("answers a body that is not JSON 400 and another media type 415", async () => {
    const base = await start();
    expect(
      (
        await post(
          base,
          POST.find((v) => v.name === "invalid-json")!,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          base,
          POST.find((v) => v.name === "unsupported-media-type")!,
        )
      ).status,
    ).toBe(415);
  });

  it("answers a throw and a row that is not a version 503", async () => {
    const base = await start();
    answer = () => ({ rows: [{ version_no: "1" }] });
    expect((await post(base, created)).status).toBe(503);
    answer = () => {
      throw new Error("izmisljena greska");
    };
    expect((await post(base, created)).status).toBe(503);
  });
});
