// DAN-843-1b (Ductus#2028 c.6981773723): every ops.events.get vector is a
// request and an answer the real server can give, not only a match of the
// schema. A cross-area test (docs/server-map.md §2): contracts may not import
// http, traffic or log.
// - Every request goes through the real step 8 (server/http
//   operatorPolicyLayer; review on ductura/server#320 at fc6432b): a cookie
//   step 8 cannot read would make 200, 403, 422 and 503 unreachable.
// - Every row of the page vector is a record the writer's catalog lets in,
//   as operator_log masks it; a traffic.request row is what
//   createTrafficRecorder writes (review on #320 at b777a70).
// - The summary names what step 8 refuses on and what operator_log does to a
//   network (review and QA on #320 at 221669b).
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { isIPv4, isIPv6, Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { CONTRACT_ONLY, INVENTORY, ROUTES, SERVER_SOURCES } from "../../server/contracts/index.ts";
import {
  operatorPolicyLayer,
  type OperatorList,
  createLayers,
  createOperatorDenialLog,
  type SecondFactor,
} from "../../server/http/index.ts";
import { checkEvent } from "../../server/log/index.ts";
import { newSessionToken, sessionTokenFromCookie } from "../../server/session/index.ts";
import {
  clientIpLayer,
  createTrafficRecorder,
  isOpsPath,
  NO_TRUSTED_PROXIES,
  parseAllowedNetworks,
} from "../../server/traffic/index.ts";

// randomBytes passes through, except where issuable() hands newSessionToken
// the bytes of a token (DAN-843-1c, class 1 of the FAILs on #328).
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
const { randomBytes: passThroughRandomBytes } =
  await vi.importActual<typeof import("node:crypto")>("node:crypto");

/**
 * Could login issue this token? newSessionToken of session-token.ts is given
 * the 32 bytes the token decodes to as its randomness, and must give back the
 * token itself: not a check of length and alphabet, but the generator.
 */
function issuable(token: string): boolean {
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32) return false;
  let asked: number | undefined;
  vi.mocked(randomBytes).mockImplementationOnce(((size: number) => {
    asked = size;
    return bytes;
  }) as typeof randomBytes);
  try {
    return newSessionToken().token === token && asked === 32;
  } finally {
    // Nothing queued may reach the next caller of randomBytes.
    vi.mocked(randomBytes).mockReset();
    vi.mocked(randomBytes).mockImplementation(passThroughRandomBytes);
  }
}

type Vector = {
  name: string;
  request: { query?: Record<string, string>; headers?: Record<string, string> };
  response: { status: number; contentType: string; body: Record<string, unknown> };
};
type Row = {
  seq: number;
  at: string;
  kind: string;
  requestId: string | null;
  accountKind: string | null;
  fields: Record<string, unknown>;
};
const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const { vectors } = read("../../server/contracts/vectors/ops.events.get.json") as {
  vectors: Vector[];
};
const vector = (name: string): Vector => {
  const found = vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
};

/** A port that throws, or answers what no port may. */
type Fault = "throws" | "toString";

/**
 * Step 8 over one vector's request: the operator list answers `listed`, the
 * second factor `outcome`; "throws" makes that port fail, "toString" is an
 * answer no port may give. `seen` records each port's token; `body` is the
 * answer step 8 wrote, if any.
 */
async function step8(
  request: Vector["request"],
  outcome: Awaited<ReturnType<SecondFactor>> | Fault,
  listed: Awaited<ReturnType<OperatorList>> | Fault = "listed",
) {
  const message = new IncomingMessage(new Socket());
  message.method = "GET";
  message.url = `/api/v1/ops/events?${new URLSearchParams(request.query).toString()}`;
  for (const [name, value] of Object.entries(request.headers ?? {}))
    message.headers[name.toLowerCase()] = value;
  const response = new ServerResponse(message);
  const chunks: string[] = [];
  const end = response.end.bind(response) as (chunk?: unknown) => ServerResponse;
  response.end = ((chunk?: unknown) => {
    if (chunk !== undefined) chunks.push(String(chunk));
    return end(chunk);
  }) as typeof response.end;
  const seen: string[] = [];
  const layer = operatorPolicyLayer(
    async (token) => {
      seen.push(`factor:${token}`);
      if (outcome === "throws") throw new Error("invented: the factor port is down");
      return outcome as Awaited<ReturnType<SecondFactor>>;
    },
    () => undefined,
    () => undefined,
    async (token) => {
      seen.push(`listed:${token}`);
      if (listed === "throws") throw new Error("invented: the operator list is down");
      return listed as Awaited<ReturnType<OperatorList>>;
    },
  );
  const result = await layer(message, response);
  const contentType = String(response.getHeader("content-type") ?? "");
  const body = chunks.length === 0 ? undefined : (JSON.parse(chunks.join("")) as unknown);
  return { result, status: response.statusCode, seen, body, contentType };
}

/** The answer step 8 wrote, matched against the vector's answer; the id is the server's own. */
function expectAnswer(got: Awaited<ReturnType<typeof step8>>, want: Vector["response"]) {
  expect(got.status).toBe(want.status);
  expect(got.contentType.split(";")[0]).toBe(want.contentType);
  expect(got.body).toEqual({ ...want.body, requestId: expect.any(String) });
}

// Every vector, not a list of names: a new vector is covered without a new
// case, and a status step 8 and the route cannot give fails.
describe("every request of ops.events.get through step 8", () => {
  const ofStatus = (...statuses: number[]) =>
    vectors.filter((v) => statuses.includes(v.response.status)).map((v) => v.name);

  it("every vector answers a status of the contract, and each kind is there", () => {
    const statuses = vectors.map((v) => v.response.status);
    for (const status of statuses) expect([200, 401, 403, 422, 503]).toContain(status);
    for (const status of [200, 401, 403, 422, 503]) expect(statuses).toContain(status);
  });

  it.each(ofStatus(401))(
    "%s: 401 as its vector shows, no port asked, whatever the ports would say",
    async (name) => {
      const { request, response } = vector(name);
      for (const listed of ["listed", "not_listed"] as const) {
        const got = await step8(request, "confirmed", listed);
        expect([got.result, got.seen]).toEqual(["done", []]);
        expectAnswer(got, response);
      }
    },
  );

  it.each(ofStatus(403))(
    "%s: 403 as its vector shows, for an unconfirmed factor and for an account off the list",
    async (name) => {
      const { request, response } = vector(name);
      const unconfirmed = await step8(request, "unconfirmed");
      expect([unconfirmed.result, unconfirmed.seen.length]).toEqual(["done", 2]);
      expectAnswer(unconfirmed, response);
      // The list is asked first; off it, the factor is never asked.
      const offList = await step8(request, "confirmed", "not_listed");
      expect([offList.result, offList.seen.length]).toEqual(["done", 1]);
      expectAnswer(offList, response);
    },
  );

  // QA self-check on #328: step 8 answers 503 itself when a port cannot
  // answer (it throws, says unavailable, or gives no known answer), so the
  // unavailable vector is also its answer.
  it.each(
    ofStatus(503).flatMap((name) =>
      (["throws", "unavailable", "toString"] as const).map((fault) => [name, fault] as const),
    ),
  )("%s: 503 as its vector shows when a port %s", async (name, fault) => {
    const { request, response } = vector(name);
    const listFails = await step8(request, "confirmed", fault);
    expect([listFails.result, listFails.seen.length]).toEqual(["done", 1]);
    expectAnswer(listFails, response);
    const factorFails = await step8(request, fault);
    expect([factorFails.result, factorFails.seen.length]).toEqual(["done", 2]);
    expectAnswer(factorFails, response);
  });

  // A cookie of a session that ended: either port says unauthenticated, and
  // step 8 answers the 401 of the no-session vector.
  it.each(ofStatus(200, 403, 422, 503))(
    "%s: a session the ports no longer know is the 401 of the vectors",
    async (name) => {
      const want = vector(ofStatus(401)[0]!).response;
      const offList = await step8(vector(name).request, "confirmed", "unauthenticated");
      expect([offList.result, offList.seen.length]).toEqual(["done", 1]);
      expectAnswer(offList, want);
      const offFactor = await step8(vector(name).request, "unauthenticated");
      expect([offFactor.result, offFactor.seen.length]).toEqual(["done", 2]);
      expectAnswer(offFactor, want);
    },
  );

  it.each(ofStatus(200, 403, 422, 503))(
    "%s: both ports get the token the session parser reads from its cookie",
    async (name) => {
      const { request } = vector(name);
      const token = sessionTokenFromCookie(request.headers?.cookie);
      // QA and review on #328: a token newSessionToken can give.
      expect(issuable(token!)).toBe(true);
      const got = await step8(request, "unconfirmed");
      expect(got.seen).toEqual([`listed:${token}`, `factor:${token}`]);
    },
  );

  // The last character of 32 bytes carries 4 bits, so "1" cannot end one.
  const TOKEN = "izmisljeni-token-operatora-0000000000000000";
  const notIssuable: readonly (readonly [string, string])[] = [
    ["the old vector token", "izmisljeni-token-operatora-0000000000000001"],
    ["42 characters", TOKEN.slice(1)],
    ["44 characters", `${TOKEN}A`],
    ["padding", `${TOKEN}=`],
    ["+ for -", TOKEN.replaceAll("-", "+")],
    ["/ inside", `${TOKEN.slice(0, 10)}/${TOKEN.slice(11)}`],
    ...["\r\n", "\t", "\u00a0", "\u007f", "\u0000", " "].map(
      (c) =>
        [`${JSON.stringify(c)} inside`, `${TOKEN.slice(0, 20)}${c}${TOKEN.slice(20)}`] as const,
    ),
    ["empty", ""],
  ];
  it.each(notIssuable)("a token login cannot issue: %s", (_name, token) =>
    expect(issuable(token)).toBe(false),
  );

  it("tokens newSessionToken issues pass, and the vector token", () => {
    vi.mocked(randomBytes).mockClear();
    for (let i = 0; i < 64; i += 1) expect(issuable(newSessionToken().token)).toBe(true);
    expect(issuable(TOKEN)).toBe(true);
  });

  it.each(ofStatus(200, 422, 503))(
    "%s: a confirmed operator on the list passes step 8 to the route",
    async (name) => {
      const got = await step8(vector(name).request, "confirmed");
      expect([got.result, got.seen.length, got.body]).toEqual(["next", 2, undefined]);
    },
  );
});

// A TS copy of the CASE of public.operator_log over one scalar field
// (db/logs/migrations/20261116190000_operator_log.sql), for the values the
// catalog lets in. pgTAP db/logs/tests/040-operator-log.sql tests the function.
const KEY_KEPT = /^[A-Za-z][A-Za-z0-9]*$/u;
const SECRET_KEY = /token|cookie|secret|password|credential|bearer|authorization|session/u;
const ADDRESS_KEY = /^(ip|Ip|IP)(v4|v6)?$|[a-z0-9](Ip|IP)(v4|v6)?$/u;
const ADDRESS_WORD = /addr|forwarded|host|peer|remote|origin/u;
const SUSPECT =
  /[0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f]{0,4}:[0-9A-Fa-f]{0,4}:|eyJ|[0-9A-Fa-f]{20}/u;
const TOKEN_RUN = /[A-Za-z0-9+/_=-]{20,}/gu;

/** An IPv6 address as a number; a dotted IPv4 tail counts as its two words. */
const v6Number = (text: string): bigint => {
  const dotted = /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/u.exec(text)?.[1];
  const plain =
    dotted === undefined
      ? text
      : text.replace(
          dotted,
          (v4Number(dotted) >> 16n).toString(16) + ":" + (v4Number(dotted) & 0xffffn).toString(16),
        );
  const [head = "", tail] = plain.split("::");
  const words = (part: string) => (part === "" ? [] : part.split(":"));
  const left = words(head);
  const right = tail === undefined ? [] : words(tail);
  const all = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return all.reduce((acc, word) => (acc << 16n) | BigInt(`0x${word}`), 0n);
};
const v6Text = (n: bigint): string => {
  const words = Array.from({ length: 8 }, (_, i) =>
    ((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16),
  );
  // The URL serializer writes RFC 5952, as PostgreSQL writes inet.
  return new URL(`http://[${words.join(":")}]/`).hostname.slice(1, -1);
};
const v4Number = (text: string): bigint =>
  text.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
const v4Text = (n: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => ((n >> shift) & 0xffn).toString()).join(".");

/**
 * network(set_masklen(v, least(masklen(v), 24 or 48))) of a value inet
 * reads (an address, with or without /n); undefined for any other string.
 */
function networkOf(value: string): string | undefined {
  const [address = "", length, extra] = value.split("/");
  const v4 = isIPv4(address);
  // inet takes no zone (%eth0); isIPv6 would.
  if (extra !== undefined || (!v4 && (!isIPv6(address) || address.includes("%")))) return undefined;
  const bits = v4 ? 32 : 128;
  if (length !== undefined && !/^(?:0|[1-9][0-9]{0,2})$/u.test(length)) return undefined;
  const masklen = length === undefined ? bits : Number(length);
  if (masklen > bits) return undefined;
  const kept = Math.min(masklen, v4 ? 24 : 48);
  const mask = ((1n << BigInt(kept)) - 1n) << BigInt(bits - kept);
  const n = (v4 ? v4Number(address) : v6Number(address)) & mask;
  return `${v4 ? v4Text(n) : v6Text(n)}/${kept}`;
}

function maskValue(key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null) return "hidden";
  if (value === "none") return value;
  const network = typeof value === "string" ? networkOf(value) : undefined;
  if (network !== undefined) return network;
  if (ADDRESS_KEY.test(key) || ADDRESS_WORD.test(key.toLowerCase())) return "hidden";
  if (
    typeof value === "string" &&
    (SUSPECT.test(value) ||
      [...value.matchAll(TOKEN_RUN)].some(([run]) => /[A-Z]/u.test(run) && /[0-9]/u.test(run)))
  )
    return "hidden";
  return value;
}

/** One checked record as operator_log returns it at `seq` and `at`. */
// operator_log keeps requestId and accountKind only in these shapes, else null.
const REQUEST_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_KIND_SHAPE = /^[a-z_]{1,32}$/u;
/** payload ->> key: a string as it is, a number or flag as its text, else null. */
const asText = (value: unknown): string | null =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : null;
const shaped = (value: unknown, shape: RegExp): string | null => {
  const text = asText(value);
  return text !== null && shape.test(text) ? text : null;
};

function asOperatorLogRow(
  record: { event: string; requestId: unknown; accountKind: unknown; fields: object },
  seq: number,
  at: string,
): Row {
  const fields = Object.fromEntries(
    Object.entries(record.fields)
      .filter(([key]) => KEY_KEPT.test(key) && !SECRET_KEY.test(key.toLowerCase()))
      .map(([key, value]) => [key, maskValue(key, value)]),
  );
  return {
    seq,
    at,
    kind: record.event,
    requestId: shaped(record.requestId, REQUEST_ID_SHAPE),
    accountKind: shaped(record.accountKind, ACCOUNT_KIND_SHAPE),
    fields,
  };
}

const CONTRACT_PATHS: ReadonlySet<string> = new Set(ROUTES.map((r) => r.path));
/**
 * The routes the server mounts: every route but those of CONTRACT_ONLY
 * (tests/contracts/contract-only.test.ts holds the entry point to that), plus
 * ops.events.get, which 843-2 mounts. A route only in the contract is no path
 * of the router (PREDPROVJERA on #337: GET /api/v1/settings/values is 405).
 */
const MOUNTED = ROUTES.filter((r) => !CONTRACT_ONLY.includes(r.id) || r.id === "ops.events.get");
const NO_ROUTE_PATH = "/api/v1/no-such-route";
/**
 * The router's template for a path without parameters, whatever the method:
 * the router finds the path first and answers 405 for another method on it
 * (router.ts); null for a path it does not know (404, route none).
 */
const routeOf = (request: IncomingMessage): string | null =>
  MOUNTED.find((r) => r.path === request.url)?.path ?? null;

/** A host inside a masked network: the network's address plus 0x17. */
function hostIn(network: unknown): string {
  if (typeof network !== "string") throw new Error("an ip field must be a network");
  const [address = ""] = network.split("/");
  if (isIPv4(address)) return address.replace(/\.0$/u, ".23");
  return v6Text(v6Number(address) + 0x17n);
}

/**
 * The record createTrafficRecorder writes for the request a traffic.request
 * row describes, on a fake clock that closes the answer `lagMs` before the
 * row's `at` (log_entry.at is clock_timestamp() at insert, after the write).
 */
async function recorded(row: Row, lagMs = 3): Promise<Record<string, unknown>> {
  const fields = row.fields;
  const message = new IncomingMessage(new Socket());
  Object.defineProperty(message.socket, "remoteAddress", { value: hostIn(fields.ip) });
  message.method = String(fields.method);
  message.url = fields.route === "none" ? NO_ROUTE_PATH : String(fields.route);
  await clientIpLayer(NO_TRUSTED_PROXIES)(message);
  const response = Object.assign(new EventEmitter(), {
    headersSent: true,
    statusCode: fields.status,
    closed: false,
  });
  const end = Date.parse(row.at) - lagMs;
  const times = [end - Number(fields.durationMs), end];
  const written: Record<string, unknown>[] = [];
  const { arm } = createTrafficRecorder({
    write: async (input) => {
      written.push(input as Record<string, unknown>);
      return { ok: true } as never;
    },
    routeOf,
    // The id step 1 made for this request, as the row keeps it.
    requestIdOf: () => row.requestId as string,
    now: () => times.shift() ?? end,
  });
  arm(message, response as unknown as ServerResponse);
  response.emit("close");
  expect(written).toHaveLength(1);
  return written[0]!;
}

/**
 * The statuses a traffic.request row can carry, from the layers before the
 * route and the route itself (server/http/pipeline.ts, router.ts). The
 * recorder is not armed yet (step 5 is empty); that steps 3 and 4 refusals
 * are recorded too is the plan (docs/server-map.md, step 5). The model is
 * the server once this route is mounted (843-2); every other route of
 * CONTRACT_ONLY is no route of the router (MOUNTED).
 * - On a path of the contract: what the route of that method declares
 *   (responses and errors), or 405 when no route there has the method.
 * - On another path (route none): 404.
 * - 429 of step 4, 499 (closed early) and 500 (answerInternal), everywhere.
 * - 403 of step 3 and 401, 403 and 503 of step 8 where isOpsPath holds; for
 *   route none the path is not kept, so it may have been one.
 * - 403 of step 7 where the real origin layer refuses a request without an
 *   Origin (a method outside GET, HEAD and OPTIONS, but not a route of the
 *   identity provider).
 * No row is written for the 503 while draining (start.ts answers before the
 * handler) nor for what Node refuses before a request event (400, 408, 431).
 */
const originCheck = createLayers({ expectedOrigin: null }).originCheck;

async function originRefuses(method: string, path: string): Promise<boolean> {
  const message = new IncomingMessage(new Socket());
  message.method = method;
  message.url = path;
  const response = new ServerResponse(message);
  const outcome = await originCheck(message, response);
  return outcome === "done" && response.statusCode === 403;
}

const declaredOf = (route: (typeof ROUTES)[number]) =>
  [...route.responses, ...route.errors].map((r) => r.status);

async function answerable(method: string, route: string): Promise<ReadonlySet<number>> {
  const everywhere = [429, 499, 500];
  if (route === "none") return new Set([404, ...everywhere, 401, 403, 503]);
  const onPath = MOUNTED.filter((r) => r.path === route);
  if (onPath.length === 0) return new Set();
  const own = onPath.find((r) => r.method === method);
  return new Set([
    ...(own === undefined ? [405] : declaredOf(own)),
    ...everywhere,
    ...(isOpsPath(route) ? [401, 403, 503] : []),
    ...((await originRefuses(method, route)) ? [403] : []),
  ]);
}

const trafficRows = (rows: readonly Row[]) => rows.filter((r) => r.kind === "traffic.request");

/** Why a traffic.request row's status is not one its route can answer, if it is not. */
async function statusProblem(row: Row): Promise<string | undefined> {
  const { method, route, status } = row.fields;
  return (await answerable(String(method), String(route))).has(Number(status))
    ? undefined
    : `${String(method)} ${String(route)} cannot answer ${String(status)}`;
}

// Per route, for every route of the inventory (inventory.ts): which layer
// can answer which status, against a rule written out here, not the layers.
describe("answerable, for every route of the inventory", () => {
  const inventoried = (key: string) => key in INVENTORY || key in SERVER_SOURCES;
  const SAFE = ["GET", "HEAD", "OPTIONS"];

  it.each(ROUTES.map((r) => [r.id, r] as const))("%s", async (_id, route) => {
    expect(inventoried(route.inventory)).toBe(true);
    const ops = isOpsPath(route.path);
    const provider = route.access === "identity_provider";
    const onPath = MOUNTED.filter((r) => r.path === route.path);
    const methods = new Set<string>(onPath.map((r) => r.method));
    for (const method of [...SAFE, "POST", "PUT", "PATCH", "DELETE", "OTHER"]) {
      const allowed = await answerable(method, route.path);
      // A path no mounted route has: the router's 404, route none.
      if (onPath.length === 0) {
        expect(allowed.size, `${method} ${route.path}`).toBe(0);
        continue;
      }
      const own = onPath.find((r) => r.method === method);
      const declared = new Set(own === undefined ? [405] : declaredOf(own));
      const step7 = !SAFE.includes(method) && !(provider && method === route.method);
      for (let status = 100; status < 600; status += 1) {
        const want =
          declared.has(status) ||
          [429, 499, 500].includes(status) ||
          (ops && [401, 403, 503].includes(status)) ||
          (step7 && status === 403);
        expect(allowed.has(status), `${method} ${route.path} ${status}`).toBe(want);
      }
      expect(allowed.has(405)).toBe(!methods.has(method));
    }
  });

  it("GET /api/v1/health answers none of 401, 403, 405 and 503; any other method 405", async () => {
    const health = await answerable("GET", "/api/v1/health");
    for (const status of [401, 403, 405, 503]) expect(health.has(status)).toBe(false);
    for (const method of ["HEAD", "OPTIONS", "DELETE", "OTHER"])
      expect((await answerable(method, "/api/v1/health")).has(405)).toBe(true);
  });

  it("an operator path and a mutation give 403; the provider's back-channel does not", async () => {
    const ops = await answerable("GET", "/api/v1/ops/events");
    for (const status of [401, 403, 503]) expect(ops.has(status)).toBe(true);
    const mutation = ROUTES.find((r) => r.method === "POST" && r.access !== "identity_provider");
    expect((await answerable(mutation!.method, mutation!.path)).has(403)).toBe(true);
    const provider = ROUTES.filter((r) => r.access === "identity_provider" && r.method === "POST");
    expect(provider.length).toBeGreaterThan(0);
    for (const r of provider) {
      expect(await originRefuses(r.method, r.path)).toBe(false);
      expect(declaredOf(r).includes(403) || isOpsPath(r.path)).toBe(
        (await answerable(r.method, r.path)).has(403),
      );
    }
  });

  it("a route only in the contract is not mounted: GET settings values is 405", async () => {
    const get = await answerable("GET", "/api/v1/settings/values");
    expect(CONTRACT_ONLY).toContain("settings.values.get");
    expect([get.has(200), get.has(405)]).toEqual([false, true]);
    expect(MOUNTED.map((r) => r.id)).toContain("ops.events.get");
    expect(MOUNTED.length).toBe(ROUTES.length - CONTRACT_ONLY.length + 1);
  });

  it("a path outside the contract gives nothing; route none its own set", async () => {
    expect((await answerable("GET", "/api/v1/no-such-route")).size).toBe(0);
    expect([...(await answerable("GET", "none"))].sort()).toEqual([
      401, 403, 404, 429, 499, 500, 503,
    ]);
  });
});

/** The operator networks of the vectors' server: step 3 lets only these in. */
const OPERATOR_NETWORKS = parseAllowedNetworks("198.51.100.0/24")!;
/** The ports for a step 8 denial reason, and whether the request carries the cookie. */
// A Map, so "toString" or "__proto__" as a reason finds no ports.
const PORTS_FOR: ReadonlyMap<string, readonly [boolean, string, string]> = new Map([
  ["not_signed_in", [false, "listed", "confirmed"]],
  ["session_unknown", [true, "unauthenticated", "confirmed"]],
  ["not_operator", [true, "not_listed", "confirmed"]],
  ["second_factor_required", [true, "listed", "unconfirmed"]],
]);

/**
 * Runs the request of a traffic.request row through the real steps 2, 3 and
 * 8 with the real operator denial log on a fake clock, and compares what they
 * answer and write with the rows of that request id. The ports are chosen by
 * the step 8 row the vector has, if any; the request id is the server's own,
 * so it is checked against the answer's X-Request-Id and then set to the row's.
 */
async function denialProblem(rows: readonly Row[], traffic: Row): Promise<string | undefined> {
  const own = rows.filter((r) => r.requestId === traffic.requestId && r !== traffic);
  const step8 = own.find((r) => r.kind === "authz.operator_denied");
  const [cookie, listed, factor] = PORTS_FOR.get(String(step8?.fields.reason)) ?? [
    true,
    "listed",
    "confirmed",
  ];
  const message = new IncomingMessage(new Socket());
  Object.defineProperty(message.socket, "remoteAddress", { value: hostIn(traffic.fields.ip) });
  message.method = String(traffic.fields.method);
  message.url = traffic.fields.route === "none" ? NO_ROUTE_PATH : String(traffic.fields.route);
  if (cookie) message.headers.cookie = vector("page").request.headers!.cookie!;
  const response = new ServerResponse(message);
  const written: Record<string, unknown>[] = [];
  const at = own.length === 0 ? Date.parse(traffic.at) : Date.parse(own[0]!.at);
  const log = createOperatorDenialLog({
    write: async (record) => {
      written.push(record as Record<string, unknown>);
      return { ok: true } as never;
    },
    now: () => new Date(at),
  });
  // The layers as the pipeline builds them (createLayers), steps 2, 3 and 8.
  const layers = createLayers({
    expectedOrigin: null,
    allowedNetworks: () => OPERATOR_NETWORKS,
    operatorDenialLog: log,
    secondFactor: async () => factor as Awaited<ReturnType<SecondFactor>>,
    operators: async () => listed as Awaited<ReturnType<OperatorList>>,
  });
  await layers.clientIp(message, response);
  let outcome = await layers.ipRules(message, response);
  if (outcome === "next") outcome = await layers.operatorPolicy(message, response);
  await new Promise((resolve) => setImmediate(resolve));
  const status = outcome === "done" ? response.statusCode : "handler";
  if (outcome === "done" && status !== traffic.fields.status)
    return `steps 3 and 8 answer ${String(status)}, the row has ${String(traffic.fields.status)}`;
  if (outcome === "next" && own.length > 0) return "a denial row for a request that passes";
  // On this route 401 and 403 are the pipeline's alone (the summary).
  if (
    outcome === "next" &&
    isOpsPath(message.url) &&
    [401, 403].includes(Number(traffic.fields.status))
  )
    return "a 401 or 403 for a request steps 3 and 8 let through";
  const id = String(response.getHeader("x-request-id") ?? "");
  const made = written.map((record) => {
    if (record.requestId !== id) return { seq: -1 } as Row;
    const checked = checkEvent(
      { ...record, requestId: traffic.requestId },
      { routes: CONTRACT_PATHS },
    );
    if (!checked.ok) return { seq: -2 } as Row;
    return asOperatorLogRow(checked.value, 0, "");
  });
  const strip = (r: Row) => ({ ...r, seq: 0, at: "" });
  return JSON.stringify(made) === JSON.stringify(own.map(strip))
    ? undefined
    : `written ${JSON.stringify(made)}, rows ${JSON.stringify(own.map(strip))}`;
}

/** Every row other than traffic.request belongs to a request of the page, and each request checks out. */
async function pageProblem(rows: readonly Row[]): Promise<string | undefined> {
  const ids = new Set(trafficRows(rows).map((r) => r.requestId));
  const orphan = rows.find((r) => r.kind !== "traffic.request" && !ids.has(r.requestId));
  if (orphan !== undefined) return `seq ${orphan.seq} belongs to no request of the page`;
  for (const traffic of trafficRows(rows)) {
    const problem = await denialProblem(rows, traffic);
    if (problem !== undefined) return `seq ${traffic.seq}: ${problem}`;
  }
  return undefined;
}

describe("the page vector is what the log flow writes and operator_log returns", () => {
  const page = vector("page");
  const rows = (page.response.body as { events: Row[] }).events;
  const query = page.request.query ?? {};

  it("has rows, and a traffic.request row among them", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.kind === "traffic.request")).toBe(true);
  });

  it.each(rows.map((r) => [r.seq, r.kind, r] as const))(
    "seq %d (%s): a record the catalog lets in, masked as operator_log masks it",
    async (_seq, kind, row) => {
      const record =
        kind === "traffic.request"
          ? await recorded(row)
          : {
              time: row.at,
              event: row.kind,
              requestId: row.requestId,
              accountKind: row.accountKind,
              fields: row.fields,
            };
      const checked = checkEvent(record, { routes: CONTRACT_PATHS });
      expect(checked).toMatchObject({ ok: true });
      if (!checked.ok) return;
      const time = Date.parse(checked.value.time);
      expect(Date.parse(row.at) - time).toBeGreaterThanOrEqual(0);
      expect(Date.parse(row.at) - time).toBeLessThanOrEqual(1000);
      expect(asOperatorLogRow(checked.value, row.seq, row.at)).toEqual(row);
    },
  );

  // Review on #328 at b6edc3e: 403 was let through on every route, so a
  // health row of 403 passed. Now per route, by answerable() below.
  it("every traffic.request status is one its route can answer", async () => {
    for (const row of trafficRows(rows))
      expect(await statusProblem(row), `seq ${row.seq}`).toBeUndefined();
  });

  // On an in-memory copy of the row, never the file: the health row as 403
  // (the review's case) and every status outside answerable, row by row.
  it("a status its route cannot answer fails the check, row by row", async () => {
    const health = trafficRows(rows).find((r) => r.fields.route === "/api/v1/health");
    expect(health?.seq).toBe(45);
    const as403 = { ...health!, fields: { ...health!.fields, status: 403 } };
    expect(await statusProblem(as403)).toBeDefined();
    for (const row of trafficRows(rows)) {
      const allowed = await answerable(String(row.fields.method), String(row.fields.route));
      for (let status = 100; status < 600; status += 1) {
        const mutant = { ...row, fields: { ...row.fields, status } };
        expect((await statusProblem(mutant)) === undefined, `seq ${row.seq} ${status}`).toBe(
          allowed.has(status),
        );
      }
    }
  });

  // PREDPROVJERA on #337: authn.login_* rows had no producer that writes them
  // to the log (the login flow reports to stderr). Every row other than
  // traffic.request is now what a producer of this server writes: the
  // operator denial log, through the real step 3 and step 8.
  it("has only kinds a producer here writes, each verified below", () =>
    expect([...new Set(rows.map((r) => r.kind))].sort()).toEqual([
      "authz.operator_denied",
      "traffic.ip_denied",
      "traffic.request",
    ]));

  it.each(trafficRows(rows).map((r) => [r.seq, r] as const))(
    "seq %d: steps 3 and 8 answer its status and write exactly its other rows",
    async (_seq, traffic) => expect(await denialProblem(rows, traffic)).toBeUndefined(),
  );

  it.each([
    [
      "a login row the login flow never writes",
      { kind: "authn.login_started", fields: { method: "aai_eduhr" } },
    ],
    [
      "another reason than step 8 gives",
      { fields: { route: "/api/v1/ops/events", reason: "not_operator" } },
    ],
    ["another route", { fields: { route: "/api/v1/health", reason: "not_signed_in" } }],
    ["another request id", { requestId: "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8" }],
  ])("a denial row with %s is refused", async (_name, change) => {
    const denial = rows.find((r) => r.kind === "authz.operator_denied")!;
    expect(await pageProblem(rows)).toBeUndefined();
    const mutated = rows.map((r) => (r === denial ? ({ ...r, ...change } as Row) : r));
    expect(await pageProblem(mutated)).toBeDefined();
  });

  it("a request without its denial row, or step 8 with the status of step 3, is refused", async () => {
    const traffic = trafficRows(rows).filter((r) => r.fields.route === "/api/v1/ops/events");
    expect(traffic.map((r) => r.fields.status)).toEqual([401, 403]);
    expect(await pageProblem(rows.filter((r) => r.kind !== "traffic.ip_denied"))).toBeDefined();
    const swapped = { ...traffic[0]!, fields: { ...traffic[0]!.fields, status: 403 } };
    expect(await pageProblem(rows.map((r) => (r === traffic[0] ? swapped : r)))).toBeDefined();
  });

  // Rows with one request id are one request: its traffic.request comes last,
  // and every other row falls inside that request, from its start (at minus
  // durationMs, less the lag of the clock above) to its end.
  it("rows of one request id are one request", () => {
    for (const traffic of rows.filter((r) => r.kind === "traffic.request")) {
      const same = rows.filter((r) => r.requestId === traffic.requestId && r !== traffic);
      const end = Date.parse(traffic.at);
      const start = end - 1000 - Number(traffic.fields.durationMs);
      for (const row of same) {
        expect(row.seq, `seq ${row.seq}`).toBeLessThan(traffic.seq);
        expect(Date.parse(row.at), `seq ${row.seq}`).toBeGreaterThanOrEqual(start);
        expect(Date.parse(row.at), `seq ${row.seq}`).toBeLessThanOrEqual(end);
        // A denial names the route of its request.
        expect(row.fields.route, `seq ${row.seq}`).toBe(traffic.fields.route);
      }
    }
    expect(rows.filter((r) => r.requestId === rows[0]!.requestId).length).toBeGreaterThan(1);
  });

  it("traffic.request with route none answered as the router's fallback does", () => {
    for (const row of rows.filter((r) => r.kind === "traffic.request" && r.fields.route === "none"))
      expect(row.fields.status).toBe(404);
  });

  it("is one page of the vector's window: in [from, to), after `after`, in seq order", () => {
    const from = Date.parse(query.from!);
    const to = Date.parse(query.to!);
    const after = Number(query.after ?? "0");
    let seq = after;
    let at = from;
    // The chain gives seq without gaps (log_chain: head.seq + 1 under a
    // lock, log_entry append only), and operator_log returns every row of
    // the window after `after`: with a clock that never steps back the rows
    // of one page follow each other. A step back of the database clock can
    // leave a row out of a window (QA on #328); this vector has no step.
    for (const [i, row] of rows.entries()) {
      expect(row.seq).toBeGreaterThan(seq);
      if (i > 0) expect(row.seq).toBe(seq + 1);
      expect(Date.parse(row.at)).toBeGreaterThanOrEqual(at);
      expect(Date.parse(row.at)).toBeLessThan(to);
      seq = row.seq;
      at = Date.parse(row.at);
    }
    expect(rows.length < 1000 ? null : seq).toBe((page.response.body as { next: unknown }).next);
  });

  // The rows of #320 at b777a70 (review c.6981562309, QA c.6981574605):
  // without the recorder and the catalog both would still pass the schema.
  it.each([
    ["an account kind the recorder never writes", { accountKind: "student" }, {}],
    ["a rule the recorder never checks", {}, { ipRule: "allowed", rateLimit: "allowed" }],
    ["no request id", { requestId: null }, {}],
    ["a host address, not a network", {}, { ip: "192.0.2.23" }],
  ])("a traffic.request row with %s is refused", async (_name, top, fields) => {
    const base = rows.find((r) => r.kind === "traffic.request")!;
    const row: Row = { ...base, ...top, fields: { ...base.fields, ...fields } };
    const passes = async () => {
      const checked = checkEvent(await recorded(row), { routes: CONTRACT_PATHS });
      return (
        checked.ok &&
        JSON.stringify(asOperatorLogRow(checked.value, row.seq, row.at)) === JSON.stringify(row)
      );
    };
    expect(await passes()).toBe(false);
  });

  it("the round trip of a network through a host in it", () => {
    expect(hostIn("2001:db8::/48")).toBe("2001:db8::17");
    expect(hostIn("192.0.2.0/24")).toBe("192.0.2.23");
  });
});

// The copy of the mask answers every case of pgTAP 040 (section 4, the
// table pg_temp.mask_case) as the function does, read from that file.
describe("the copy of operator_log's mask", () => {
  const sql = readFileSync(
    new URL("../../db/logs/tests/040-operator-log.sql", import.meta.url),
    "utf8",
  );
  const table = sql.slice(sql.indexOf("INSERT INTO pg_temp.mask_case VALUES"));
  const text = "'((?:[^']|'')*)'";
  const cases = [
    ...table
      .slice(0, table.indexOf(";\n"))
      .matchAll(new RegExp(`\\(([0-9]+),\\s*${text},\\s*${text},\\s*${text}\\)`, "gu")),
  ].map(([, n, fields, expected, why]) => ({
    n: Number(n),
    fields: JSON.parse(fields!.replaceAll("''", "'")) as Record<string, unknown>,
    expected: JSON.parse(expected!.replaceAll("''", "'")) as unknown,
    why: why!.replaceAll("''", "'"),
  }));

  it("reads all 14 cases", () =>
    expect(cases.map((c) => c.n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1)));

  it("the shape case: a request id or account kind out of shape gives null", () => {
    expect(sql).toContain(`'{"requestId": "0B7E-not-a-uuid", "accountKind": "Anonymous "`);
    const row = asOperatorLogRow(
      { event: "x", requestId: "0B7E-not-a-uuid", accountKind: "Anonymous ", fields: {} },
      1,
      "",
    );
    expect([row.requestId, row.accountKind]).toEqual([null, null]);
  });

  it.each(cases.map((c) => [c.n, c.why, c] as const))("case %d: %s", (_n, _why, c) => {
    const row = asOperatorLogRow(
      { event: "x", requestId: "y", accountKind: "z", fields: c.fields },
      1,
      "",
    );
    expect(row.fields).toEqual(c.expected);
  });
});

// The summary is what clients read in openapi/v1.json, and the README
// section says the same (review and QA on #320 at 221669b). Each check is
// shown to refuse the text of #320 at fc6432b.
const OLD_SUMMARY =
  'The operator\'s read of the log: the records of a window, at most 1000 a page, in seq order, each as the operator read (operator_log) masks it (an address only as its /24 or /48 network, no token, cookie or session value; a value the read cannot vouch for is "hidden"). The pipeline decides who reaches it, before the route: 403 forbidden from a network outside the list (step 3) or without a confirmed second factor (step 8), 401 unauthenticated without a live session (step 8).';
const OLD_README =
  "## Operatorsko čitanje događaja (DAN-843-1)\n\nFunkcija maskira svaki zapis: adresa ostaje samo kao mreža /24 ili /48, a token, kolačić ni sesija ne izlaze. Pristup odlučuje pipeline: korak 3 (mreža) i korak 8 (živa sesija i potvrđen drugi faktor).\n";

/** What the summary misses; empty when it names every refusal and the real mask. */
function summaryMisses(summary: string): string[] {
  const words = ["step 3", "live session", "operator list", "second factor", "403", "401"];
  return [
    ...words.filter((w) => !summary.includes(w)),
    ...(summary.includes("503 unavailable when step 8 cannot ask") ? [] : ["step 8 503"]),
    ...(summary.includes("a shorter one such as /8 stays") ? [] : ["shorter mask"]),
    ...(/only as its \/24 or \/48/u.test(summary) ? ["only /24 or /48"] : []),
  ];
}

/** What the README section misses; empty when it says the same and is the last section. */
function sectionMisses(section: string): string[] {
  const words = ["korak 3", "živa sesija", "popis operatora", "drugi faktor", "/24", "/48"];
  return [
    ...words.filter((w) => !section.includes(w)),
    ...["Kraća maska ostaje", "10.0.0.0/8", "korak 8 ne može pitati"].filter(
      (w) => !section.includes(w),
    ),
    ...(/samo kao mreža \/24 ili \/48/u.test(section) ? ["samo /24 ili /48"] : []),
    ...(section.slice(3).includes("\n## ") ? ["not the last section"] : []),
  ];
}

describe("the summary of ops.events.get and its README section", () => {
  const summary = ROUTES.find((r) => r.id === "ops.events.get")?.summary ?? "";
  const readme = readFileSync(new URL("../../server/contracts/README.md", import.meta.url), "utf8");
  const start = readme.indexOf("## Operatorsko čitanje događaja (DAN-843-1)");

  it("the summary names step 3 and 8, the operator list and the real mask", () =>
    expect(summaryMisses(summary)).toEqual([]));

  it("the README section is there, last, and says the same", () => {
    expect(start).toBeGreaterThan(0);
    expect(sectionMisses(readme.slice(start))).toEqual([]);
  });

  it("both checks refuse the text of #320 at fc6432b", () => {
    expect(summaryMisses(OLD_SUMMARY)).toEqual([
      "operator list",
      "step 8 503",
      "shorter mask",
      "only /24 or /48",
    ]);
    expect(sectionMisses(OLD_README)).toEqual(
      expect.arrayContaining([
        "popis operatora",
        "Kraća maska ostaje",
        "korak 8 ne može pitati",
        "samo /24 ili /48",
      ]),
    );
    expect(sectionMisses(`${OLD_README}\n## Next\n`)).toContain("not the last section");
  });
});
