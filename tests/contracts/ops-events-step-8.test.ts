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
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { isIPv4, isIPv6, Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import { operatorPolicyLayer, type SecondFactor } from "../../server/http/index.ts";
import { checkEvent } from "../../server/log/index.ts";
import { sessionTokenFromCookie } from "../../server/session/index.ts";
import {
  clientIpLayer,
  createTrafficRecorder,
  NO_TRUSTED_PROXIES,
} from "../../server/traffic/index.ts";

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

/**
 * Step 8 over one vector's request: the operator list answers `listed`, the
 * second factor `outcome`. `seen` records each port's token; `body` is the
 * answer step 8 wrote, if any.
 */
async function step8(
  request: Vector["request"],
  outcome: Awaited<ReturnType<SecondFactor>>,
  listed: "listed" | "not_listed" = "listed",
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
      return outcome;
    },
    () => undefined,
    () => undefined,
    async (token) => {
      seen.push(`listed:${token}`);
      return listed;
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

  it.each(ofStatus(200, 403, 422, 503))(
    "%s: both ports get the token the session parser reads from its cookie",
    async (name) => {
      const { request } = vector(name);
      const token = sessionTokenFromCookie(request.headers?.cookie);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const got = await step8(request, "unconfirmed");
      expect(got.seen).toEqual([`listed:${token}`, `factor:${token}`]);
    },
  );

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
function asOperatorLogRow(
  record: { event: string; requestId: string; accountKind: string; fields: object },
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
    requestId: record.requestId,
    accountKind: record.accountKind,
    fields,
  };
}

const CONTRACT_PATHS: ReadonlySet<string> = new Set(ROUTES.map((r) => r.path));
const NO_ROUTE_PATH = "/api/v1/no-such-route";
/** The router's template for a path without parameters, or null (404, route none). */
const routeOf = (request: IncomingMessage): string | null =>
  ROUTES.find((r) => r.path === request.url && r.method === request.method)?.path ?? null;

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
    for (const row of rows) {
      expect(row.seq).toBeGreaterThan(seq);
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
      if (row.requestId === null) return false;
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
    ...(summary.includes("a shorter one such as /8 stays") ? [] : ["shorter mask"]),
    ...(/only as its \/24 or \/48/u.test(summary) ? ["only /24 or /48"] : []),
  ];
}

/** What the README section misses; empty when it says the same and is the last section. */
function sectionMisses(section: string): string[] {
  const words = ["korak 3", "živa sesija", "popis operatora", "drugi faktor", "/24", "/48"];
  return [
    ...words.filter((w) => !section.includes(w)),
    ...["Kraća maska ostaje", "10.0.0.0/8"].filter((w) => !section.includes(w)),
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
      "shorter mask",
      "only /24 or /48",
    ]);
    expect(sectionMisses(OLD_README)).toEqual(
      expect.arrayContaining(["popis operatora", "Kraća maska ostaje", "samo /24 ili /48"]),
    );
    expect(sectionMisses(`${OLD_README}\n## Next\n`)).toContain("not the last section");
  });
});
