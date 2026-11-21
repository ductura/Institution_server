// GET /api/v1/institution/config and POST /api/v1/institution/config/versions
// (SRV-1406) on a real server with the real pipeline, over a fake store: the
// vectors of both contracts, the framing of the body, the order the store is
// called in and 503 for an answer outside the contract. The roles and the
// audit row are the database's (institution-config.pg.integration.test.ts).
// All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { InstitutionConfigStore } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createInstitutionConfigRoutes } from "./index.ts";

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
const GET = load("institution.config.get");
const POST = load("institution.config-versions.post");
const ORIGIN = "https://ductura.example.invalid";
const RULES = { citationStyle: "fpzg", workLanguages: ["hr"], defaultWorkLanguage: "hr" } as const;
const AT = new Date("2026-11-21T10:00:00.000Z");
const STORED = (version: number) => ({
  version,
  rules: RULES,
  createdBy: "00000000-0000-4000-8000-000000000103",
  createdAt: AT.toISOString(),
});

let running: Running | undefined;
const published: unknown[][] = [];
let versions: () => Promise<unknown> = async () => ({ status: "ok", versions: [] });
let publish: () => Promise<unknown> = async () => ({ status: "ok", version: 1 });

async function start(): Promise<string> {
  const store = {
    versions: () => versions(),
    publish: (...args: unknown[]) => (published.push(args), publish()),
  } as unknown as InstitutionConfigStore;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createInstitutionConfigRoutes({ store }),
  });
  return `http://127.0.0.1:${running.port}/api/v1/institution/config`;
}

afterEach(async () => {
  published.length = 0;
  versions = async () => ({ status: "ok", versions: [] });
  publish = async () => ({ status: "ok", version: 1 });
  await running?.close();
  running = undefined;
});

const send = (url: string, v: Vector, init: RequestInit = {}) =>
  fetch(url, { headers: v.request.headers ?? {}, ...init });
const withBody = (url: string, v: Vector, body?: unknown) =>
  send(url, v, {
    method: "POST",
    body:
      body === undefined
        ? (v.request.rawBody ?? JSON.stringify(v.request.body))
        : JSON.stringify(body),
  });

async function expectVector(got: Response, v: Vector) {
  expect(got.status).toBe(v.response.status);
  const body = (await got.json()) as Record<string, unknown>;
  if (v.response.status < 300) {
    expect(body).toEqual(v.response.body);
    expect(got.headers.get("cache-control")).toBe("no-store");
  } else {
    expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
  }
}

describe("institution.config.get", () => {
  it.each(
    GET.filter((v) => !["forbidden", "invalid-input", "unavailable"].includes(v.name)).map(
      (v) => [v.name, v] as const,
    ),
  )("vector %s", async (name, v) => {
    versions = async () =>
      name === "history"
        ? { status: "ok", versions: [STORED(1), STORED(2)] }
        : name === "unauthorized"
          ? { status: "unauthorized" }
          : { status: "ok", versions: [] };
    const base = await start();
    const got = await send(base, v);
    if (name === "history") {
      const body = (await got.json()) as { current: { version: number }; versions: unknown[] };
      expect(got.status).toBe(200);
      expect(body.current.version).toBe(2);
      expect(body.versions).toHaveLength(2);
    } else await expectVector(got, v);
  });

  it("answers a teacher or a student, who are not administrators, 403", async () => {
    versions = async () => ({ status: "forbidden" });
    const base = await start();
    const v = GET.find((x) => x.name === "forbidden")!;
    await expectVector(await send(base, v), v);
  });

  it("answers a query 422 before the store", async () => {
    const base = await start();
    const v = GET.find((x) => x.name === "invalid-input")!;
    await expectVector(await send(`${base}?a=1`, v), v);
  });

  it("answers a throw 503", async () => {
    versions = async () => {
      throw new Error("izmisljena greska");
    };
    const base = await start();
    const v = GET.find((x) => x.name === "unavailable")!;
    await expectVector(await send(base, v), v);
  });
});

describe("institution.config-versions.post", () => {
  const url = async () => `${await start()}/versions`;
  const first = POST.find((v) => v.name === "publish-first")!;

  it("publishes and answers the stored version with its moment", async () => {
    versions = async () => ({ status: "ok", versions: [STORED(1)] });
    const got = await withBody(await url(), first);
    expect(got.status).toBe(201);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toEqual({ version: 1, effectiveFrom: AT.toISOString(), rules: RULES });
    expect(published).toEqual([
      [
        expect.any(String),
        0,
        { citationStyle: "fpzg", workLanguages: ["hr", "en"], defaultWorkLanguage: "hr" },
      ],
    ]);
  });

  it.each([
    ["conflict", "conflict", 409],
    ["forbidden", "forbidden", 403],
    ["invalid_input", "invalid_input", 422],
    ["unauthorized", "unauthorized", 401],
  ])("maps the store's %s to %s", async (status, code, http) => {
    publish = async () => ({ status });
    const got = await withBody(await url(), first);
    expect(got.status).toBe(http);
    expect(((await got.json()) as { code: string }).code).toBe(code);
  });

  it("answers an unknown rule key 422 before the store", async () => {
    const v = POST.find((x) => x.name === "unknown-rule-key")!;
    await expectVector(await withBody(await url(), v), v);
    expect(published).toEqual([]);
  });

  it("answers a default language that is not offered with the store's 422", async () => {
    publish = async () => ({ status: "invalid_input" });
    const v = POST.find((x) => x.name === "default-not-offered")!;
    await expectVector(await withBody(await url(), v), v);
    expect(published).toHaveLength(1);
  });

  it("answers a body that is not JSON 400 and another media type 415", async () => {
    const v = POST.find((x) => x.name === "invalid-json")!;
    expect((await withBody(await url(), v)).status).toBe(400);
    const m = POST.find((x) => x.name === "unsupported-media-type")!;
    expect((await withBody(await url(), m)).status).toBe(415);
  });

  it("answers a throw, and a version the chain does not hold, 503", async () => {
    publish = async () => {
      throw new Error("izmisljena greska");
    };
    expect((await withBody(await url(), first)).status).toBe(503);
    publish = async () => ({ status: "ok", version: 1 });
    versions = async () => ({ status: "ok", versions: [] });
    expect(
      (
        await withBody(
          running ? `http://127.0.0.1:${running.port}/api/v1/institution/config/versions` : "",
          first,
        )
      ).status,
    ).toBe(503);
  });
});
