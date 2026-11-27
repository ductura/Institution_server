// SRV-V15-HTTP: the analysis adapter on a plain node:http server with a stub
// for the one database read (the session). Switch off: 404 for both routes,
// even without a session. Switch on: 401 without or with a dead session, 415,
// 413, 400, 422, 200, and the limits of the contract equal the domain's. No
// cell of a dataset reaches any log line or any answer other than the result.
// All values are invented.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ANALYSIS_IDS, ANALYSIS_LIMITS, ROUTES } from "../../contracts/index.ts";
import { DATASET_LIMITS, analysisSpecOf, type WithActor } from "../../database/index.ts";
import {
  ANALYSIS_ENABLED,
  ANALYSIS_LOCAL_VARIABLE,
  analysisEnabledFor,
  createAnalysisRoutesFor,
} from "./index.ts";

const find = (id: string) => ROUTES.find((route) => route.id === id)!;
const analysisCatalogueGet = find("analysis.catalogue.get");
const analysisRunsPost = find("analysis.runs.post");
const TOKEN = "a".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const CANARY = "izmisljena-celija-canary-v15";

const ACCOUNT_ROW = {
  ["institution_slug"]: "izmisljena-ustanova",
  institutionDisplayName: null,
  displayName: null,
  roles: ["student"],
  userId: "11111111-1111-4111-8111-111111111111",
  institutionId: "22222222-2222-4222-8222-222222222222",
};

function stubActor(live: boolean): WithActor {
  return (async (_token: string, run: (tx: unknown) => Promise<unknown>) => {
    if (!live) throw Object.assign(new Error("no session"), { code: "ZD401" });
    return run({ query: async () => ({ rows: [ACCOUNT_ROW] }) });
  }) as unknown as WithActor;
}

let server: Server | undefined;
let reads = 0;

async function start(options: { enabled?: boolean; live?: boolean } = {}): Promise<string> {
  const inner = stubActor(options.live ?? true);
  const counting = ((token: string, run: never) => {
    reads += 1;
    return (inner as unknown as (t: string, r: never) => Promise<unknown>)(token, run);
  }) as unknown as WithActor;
  const routes = createAnalysisRoutesFor(
    { withActor: counting },
    options.enabled === undefined ? {} : { enabled: options.enabled },
  );
  server = createServer((request, response) => {
    const route = routes.find(
      (r) => r.contract.method === request.method && request.url?.split("?")[0] === r.contract.path,
    );
    if (route === undefined) {
      response.writeHead(599).end();
      return;
    }
    void route.handle(request, response, undefined as never);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  reads = 0;
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const GOOD = {
  analysisId: "descriptive",
  analysisVersion: "1.0.0",
  variables: ["x"],
  columns: [
    { name: "x", kind: "numeric" },
    { name: "g", kind: "category" },
  ],
  rows: [
    [1, "a"],
    [2, "b"],
    [3, CANARY],
  ],
};

const run = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/analysis/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const catalogue = (base: string, headers: Record<string, string> = { cookie: COOKIE }) =>
  fetch(`${base}/api/v1/analysis/catalogue`, { headers });

describe("analysis HTTP adapter, switch off", () => {
  it("is off by default in the code", () => {
    expect(ANALYSIS_ENABLED).toBe(false);
  });

  it("answers 404 not_found on both routes, with or without a session, and reads nothing", async () => {
    const base = await start();
    for (const answer of [
      await catalogue(base),
      await catalogue(base, {}),
      await run(base, GOOD),
      await run(base, GOOD, { cookie: "" }),
      await run(base, "not json"),
    ]) {
      expect(answer.status).toBe(404);
      expect(((await answer.json()) as { code: string }).code).toBe("not_found");
    }
    expect(reads).toBe(0);
  });
});

describe("analysis HTTP adapter, switch on", () => {
  it("is 401 without a cookie and with a dead session, on both routes", async () => {
    const none = await start({ enabled: true });
    expect((await catalogue(none, {})).status).toBe(401);
    expect((await run(none, GOOD, { cookie: "" })).status).toBe(401);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const dead = await start({ enabled: true, live: false });
    expect((await catalogue(dead)).status).toBe(401);
    expect((await run(dead, GOOD)).status).toBe(401);
  });

  it("answers the catalogue of the registry, equal to the contract", async () => {
    const base = await start({ enabled: true });
    const answer = await catalogue(base);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const body = (await answer.json()) as {
      limits: unknown;
      analyses: { id: string; version: string }[];
    };
    expect(Value.Check(analysisCatalogueGet.responses[0]!.body!, body)).toBe(true);
    expect(body.analyses.map((a) => a.id)).toEqual([...ANALYSIS_IDS]);
    expect(body.analyses.map((a) => a.version)).toEqual(
      ANALYSIS_IDS.map((id) => analysisSpecOf(id)!.version),
    );
    expect(body.limits).toEqual(ANALYSIS_LIMITS);
  });

  it("limits in the contract and in the domain are equal", () => {
    expect({
      maxRows: DATASET_LIMITS.maxRows,
      maxColumns: DATASET_LIMITS.maxColumns,
      maxCellLength: DATASET_LIMITS.maxCellLength,
      maxBodyBytes: DATASET_LIMITS.maxBodyBytes,
    }).toEqual(ANALYSIS_LIMITS);
    expect(analysisRunsPost.request.maxBodyBytes).toBe(DATASET_LIMITS.maxBodyBytes);
  });

  it("rejects a catalogue query and a cross-site read", async () => {
    const base = await start({ enabled: true });
    expect(
      (await fetch(`${base}/api/v1/analysis/catalogue?x=1`, { headers: { cookie: COOKIE } }))
        .status,
    ).toBe(422);
    expect((await catalogue(base, { cookie: COOKIE, "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
  });

  it("calculates, is repeatable and never changes with the order of rows", async () => {
    const base = await start({ enabled: true });
    const first = await run(base, GOOD);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { result: { kind: string; columns: { mean: number }[] } };
    expect(Value.Check(analysisRunsPost.responses[0]!.body!, body)).toBe(true);
    expect(body.result.columns[0]!.mean).toBe(2);
    const again = await (await run(base, GOOD)).text();
    expect(again).toBe(JSON.stringify(body));
    const shuffled = await (await run(base, { ...GOOD, rows: [...GOOD.rows].reverse() })).json();
    expect((shuffled as { resultSha256: string }).resultSha256).toBe(
      (body as unknown as { resultSha256: string }).resultSha256,
    );
  });

  it("415 for a wrong media type, 400 for broken JSON, 422 for bad shape and bad dataset", async () => {
    const base = await start({ enabled: true });
    expect((await run(base, GOOD, { "content-type": "text/plain" })).status).toBe(415);
    expect((await run(base, "{")).status).toBe(400);
    expect((await run(base, { ...GOOD, extra: 1 })).status).toBe(422);
    expect((await run(base, { ...GOOD, analysisId: "regression" })).status).toBe(422);
    const dupe = await run(base, { ...GOOD, columns: [GOOD.columns[0], GOOD.columns[0]] });
    expect(dupe.status).toBe(422);
    expect(((await dupe.json()) as { code: string }).code).toBe("invalid_input");
    const kind = await run(base, { ...GOOD, variables: ["g"] });
    expect(kind.status).toBe(422);
    const unknown = await run(base, { ...GOOD, variables: ["nema"] });
    expect(unknown.status).toBe(422);
    const version = await run(base, { ...GOOD, analysisVersion: "9.9.9" });
    expect(version.status).toBe(422);
    expect(((await version.json()) as { code: string }).code).toBe("unknown_analysis_version");
  });

  it("413 above the limit of the body, declared or streamed", async () => {
    const base = await start({ enabled: true });
    const big = JSON.stringify({ ...GOOD, pad: "x".repeat(ANALYSIS_LIMITS.maxBodyBytes) });
    const answer = await run(base, big);
    expect(answer.status).toBe(413);
  });

  it("422 for a dataset outside the limits of the domain", async () => {
    const base = await start({ enabled: true });
    const rows = Array.from({ length: ANALYSIS_LIMITS.maxRows + 1 }, () => [1, "a"]);
    expect((await run(base, { ...GOOD, rows })).status).toBe(422);
    const cell = await run(base, {
      ...GOOD,
      rows: [[1, "z".repeat(ANALYSIS_LIMITS.maxCellLength + 1)]],
    });
    expect(cell.status).toBe(422);
  });

  it("keeps the content of the dataset out of every log line and every error", async () => {
    const lines: string[] = [];
    for (const name of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const base = await start({ enabled: true });
    const secret = {
      ...GOOD,
      rows: [
        [1, CANARY],
        [2, CANARY],
        [CANARY, CANARY],
      ],
    };
    const bad = await run(base, secret);
    expect(bad.status).toBe(422);
    expect(await bad.text()).not.toContain(CANARY);
    const wrongKind = await run(base, { ...GOOD, variables: ["g"] });
    expect(await wrongKind.text()).not.toContain(CANARY);
    const frequencies = await run(base, { ...GOOD, analysisId: "frequencies", variables: ["g"] });
    expect(frequencies.status).toBe(200);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("answers 503 and logs no content when the session read fails", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const failing = (async () => {
      throw new Error(CANARY);
    }) as unknown as WithActor;
    const routes = createAnalysisRoutesFor({ withActor: failing }, { enabled: true });
    server = createServer((request, response) => {
      void routes[1]!.handle(request, response, undefined as never);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const answer = await run(base, GOOD);
    expect(answer.status).toBe(503);
    expect(lines.join("\n")).not.toContain(CANARY);
  });
});

describe("analysis local exception", () => {
  const LOCAL = {
    [ANALYSIS_LOCAL_VARIABLE]: "1",
    NODE_ENV: "development",
    DUCTUS_AUTH_PROVIDER: "fake-oidc",
  };
  it("is off without the variable, even on a local stack", () => {
    expect(analysisEnabledFor({ ...LOCAL, [ANALYSIS_LOCAL_VARIABLE]: undefined })).toBe(false);
    expect(analysisEnabledFor({})).toBe(false);
  });
  it("is off with the variable but without the local marker", () => {
    expect(analysisEnabledFor({ [ANALYSIS_LOCAL_VARIABLE]: "1" })).toBe(false);
    expect(analysisEnabledFor({ ...LOCAL, NODE_ENV: "production" })).toBe(false);
    expect(analysisEnabledFor({ ...LOCAL, NODE_ENV: "test" })).toBe(false);
    expect(analysisEnabledFor({ ...LOCAL, DUCTUS_AUTH_PROVIDER: "aai-eduhr" })).toBe(false);
    expect(analysisEnabledFor({ ...LOCAL, DUCTURA_DEPLOYMENT: "staging" })).toBe(false);
    expect(analysisEnabledFor({ ...LOCAL, [ANALYSIS_LOCAL_VARIABLE]: "true" })).toBe(false);
  });
  it("is on with both", () => {
    expect(analysisEnabledFor(LOCAL)).toBe(true);
  });
  it("makes the mounted routes answer only with both", async () => {
    const off = await start({ enabled: analysisEnabledFor({ [ANALYSIS_LOCAL_VARIABLE]: "1" }) });
    expect((await catalogue(off)).status).toBe(404);
    await server!.close();
    const on = await start({ enabled: analysisEnabledFor(LOCAL) });
    expect((await catalogue(on)).status).toBe(200);
  });
});
