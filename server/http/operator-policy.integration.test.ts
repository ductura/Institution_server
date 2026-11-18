// The access rules of operator paths on a real node:http server (S-1J.2,
// DAN-842-1; contract Ductus#1836 c.6945827668): without an allowed network, a
// session cookie, an account on the server's operator list (DAN-1092-1) or a
// confirmed second factor no operator path reaches its handler. No operator route exists yet, so a test route stands on one, and
// every ROUTES path under /api/v1/ops joins the probes on its own.
// Tokens are invented; addresses are loopback and documentation ranges.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { sessionTag } from "../session/index.ts";
import { type AllowedNetworks, isOpsPath, parseAllowedNetworks } from "../traffic/index.ts";
import { createDatabases } from "./databases.ts";
import type { OperatorList, SecondFactor } from "./operator-policy-layer.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const OPS = "/api/v1/ops/x";
const TOKEN = "Izmisljeni_token-operatora_politika_0000001";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const read = ROUTES.find((route) => route.id === "student.assignments.get");
if (read === undefined) throw new Error("no contract student.assignments.get");

// The paths of the contract under /api/v1/ops (none yet), filtered by the same
// function as the layer, and probes the layer must read as operator paths.
const FROM_ROUTES = ROUTES.filter((route) => isOpsPath(route.path)).map((route) => route.path);
const PROBES = [
  OPS,
  "/api/v1/ops",
  "/API/V1/OPS/x",
  "//api/v1//ops/x",
  "/api/v1/ops/x?a=1",
  "http://h.invalid/api/v1/ops/x",
];
const PATHS = [...FROM_ROUTES, ...PROBES];

const nets = (text: string): (() => AllowedNetworks) => {
  const parsed = parseAllowedNetworks(text);
  if (parsed === null) throw new Error(`bad networks ${text}`);
  return () => parsed;
};
const OUTSIDE = nets("192.0.2.0/24");
const INSIDE = nets("127.0.0.0/8");

let server: Running | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

type Answer = { status: number; code?: string; connection?: string };

async function start(options: {
  networks: () => AllowedNetworks;
  secondFactor?: SecondFactor;
  /** Absent: everyone is listed; null: no list port at all. */
  operators?: OperatorList | null;
}) {
  const calls: string[] = [];
  const tokens: string[] = [];
  const asked: string[] = [];
  const operators = options.operators === undefined ? listed("listed") : options.operators;
  const port: SecondFactor | undefined =
    options.secondFactor &&
    ((token) => (tokens.push(token), (options.secondFactor as SecondFactor)(token)));
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({
      expectedOrigin: "https://ductura.invalid",
      // Open, so no combination below meets 429 before step 8.
      rateLimiter: { check: () => ({ allowed: true, limitClass: "default" }) },
      allowedNetworks: options.networks,
      ...(port === undefined ? {} : { secondFactor: port }),
      ...(operators === null
        ? {}
        : { operators: (token: string) => (asked.push(token), operators(token)) }),
    }),
    routes: [...new Set([OPS, "/api/v1/ops", ...FROM_ROUTES])].map((path) => ({
      contract: { ...read!, path },
      handle: async (_request, response) => {
        calls.push(path);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      },
    })) satisfies Route[],
    databases: createDatabases(),
  });
  const listening = server.port;
  const get = (path: string, cookie?: string) =>
    new Promise<Answer>((resolve, reject) => {
      const headers = cookie === undefined ? {} : { cookie };
      const req = httpRequest(
        { host: "127.0.0.1", port: listening, path, headers, agent: false },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
          res.on("end", () => {
            const code = body === "" ? undefined : (JSON.parse(body) as { code?: string }).code;
            const connection = res.headers.connection;
            resolve({
              status: res.statusCode ?? 0,
              ...(code === undefined ? {} : { code }),
              ...(connection === undefined ? {} : { connection }),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  return { get, calls, tokens, asked };
}

function answers(outcome: unknown): SecondFactor {
  return async () => outcome as never;
}
function listed(outcome: unknown): OperatorList {
  return async () => outcome as never;
}

describe("operator policy on a real server", () => {
  it("has probes even while the contract has no operator route", () => {
    expect(PATHS.length).toBeGreaterThan(0);
    expect(PATHS.every((path) => isOpsPath(path))).toBe(true);
  });

  // Every combination of the four conditions: network, cookie, operator list
  // and second factor (owner decision "AAI + WebAuthn + network", DAN-1092-1).
  const BOTH = [false, true];
  const COMBINATIONS = BOTH.flatMap((network) =>
    BOTH.flatMap((cookie) =>
      BOTH.flatMap((list) => BOTH.map((factor) => ({ network, cookie, list, factor }))),
    ),
  );
  it.each(COMBINATIONS.filter((c) => !(c.network && c.cookie && c.list && c.factor)))(
    "refuses every operator path without all four: %o",
    async ({ network, cookie, list, factor }) => {
      const { get, calls, tokens, asked } = await start({
        networks: network ? INSIDE : OUTSIDE,
        secondFactor: answers(factor ? "confirmed" : "unconfirmed"),
        operators: listed(list ? "listed" : "not_listed"),
      });
      const expected = !network
        ? { status: 403, code: "forbidden" }
        : !cookie
          ? { status: 401, code: "unauthenticated" }
          : { status: 403, code: "forbidden" };
      for (const path of PATHS) {
        const answer = await get(path, cookie ? COOKIE : undefined);
        expect(answer, path).toEqual({ ...expected, connection: "close" });
      }
      expect(calls).toEqual([]);
      // Each port is asked only once the conditions before it passed.
      expect(asked).toEqual(network && cookie ? PATHS.map(() => TOKEN) : []);
      expect(tokens).toEqual(network && cookie && list ? PATHS.map(() => TOKEN) : []);
    },
  );

  it("lets every operator path through only with all four", async () => {
    const { get, calls, tokens, asked } = await start({
      networks: INSIDE,
      secondFactor: answers("confirmed"),
    });
    // Past the layer the router decides: a path it does not serve exactly is 404.
    const ROUTED = new Set([...FROM_ROUTES, OPS, "/api/v1/ops", "/api/v1/ops/x?a=1"]);
    for (const path of PATHS) {
      expect((await get(path, COOKIE)).status, path).toBe(ROUTED.has(path) ? 200 : 404);
    }
    expect(calls).toHaveLength(ROUTED.size);
    expect(tokens).toEqual(PATHS.map(() => TOKEN));
    expect(asked).toEqual(PATHS.map(() => TOKEN));
  });

  it("reads the list on every request: a removal applies to the next one", async () => {
    const next = ["listed", "not_listed"];
    const { get, calls } = await start({
      networks: INSIDE,
      secondFactor: answers("confirmed"),
      operators: async () => next.shift() as "listed",
    });
    expect((await get(OPS, COOKIE)).status).toBe(200);
    expect(await get(OPS, COOKIE)).toEqual({ status: 403, code: "forbidden", connection: "close" });
    expect(calls).toEqual([OPS]);
  });

  it("without a list port nobody is an operator, and the second factor is not asked", async () => {
    const { get, calls, tokens } = await start({
      networks: INSIDE,
      secondFactor: answers("confirmed"),
      operators: null,
    });
    expect(await get(OPS, COOKIE)).toEqual({ status: 403, code: "forbidden", connection: "close" });
    expect(tokens).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["no cookie", undefined],
    ["two session cookies", `${COOKIE}; ${COOKIE}`],
    ["a malformed token", "__Host-ductus_session=short"],
    ["a tab before =", `__Host-ductus_session\t=${TOKEN}`],
    ["an NBSP after =", `__Host-ductus_session= ${TOKEN}`],
    ["the ended mark of this session", `${COOKIE}; ductus-ended-${sessionTag(TOKEN)!}=1`],
  ])("answers 401 without asking the port for %s", async (_name, cookie) => {
    const { get, calls, tokens } = await start({
      networks: INSIDE,
      secondFactor: answers("confirmed"),
    });
    const sent = cookie === undefined ? undefined : Buffer.from(cookie, "utf8").toString("latin1");
    expect(await get(OPS, sent)).toEqual({
      status: 401,
      code: "unauthenticated",
      connection: "close",
    });
    expect(tokens).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Either port; a list that answers the second factor's words (or the reverse)
  // is no answer, so the two ports cannot be wired the wrong way round.
  const ON_EITHER = (port: SecondFactor) =>
    [
      ["the second factor", { secondFactor: port }],
      [
        "the list",
        { secondFactor: answers("confirmed"), operators: port as unknown as OperatorList },
      ],
    ] as const;

  it.each(ON_EITHER(answers("unauthenticated")))(
    "answers 401 when %s does not know the session",
    async (_port, ports) => {
      const { get, calls } = await start({ networks: INSIDE, ...ports });
      expect(await get(OPS, COOKIE)).toEqual({
        status: 401,
        code: "unauthenticated",
        connection: "close",
      });
      expect(calls).toEqual([]);
    },
  );

  const FAULTS: readonly (readonly [string, SecondFactor])[] = [
    ["unavailable", answers("unavailable")],
    ["CONFIRMED", answers("CONFIRMED")],
    ["true", answers(true)],
    ["null", answers(null)],
    ["toString", answers("toString")],
    ["__proto__", answers("__proto__")],
    ["an object that prints confirmed", answers({ toString: () => "confirmed" })],
    ["a thenable of another value", answers({ then: (r: (v: unknown) => void) => r("yes") })],
    [
      "a synchronous throw",
      (() => {
        throw new Error("port down");
      }) as unknown as SecondFactor,
    ],
    ["a rejection", (async () => Promise.reject(new Error("port down"))) as SecondFactor],
  ];
  it.each([
    ...FAULTS.flatMap(([name, port]) =>
      ON_EITHER(port).map(([on, ports]) => [on, name, ports] as const),
    ),
    ["the second factor", "listed", ON_EITHER(answers("listed"))[0][1]] as const,
    ["the list", "confirmed", ON_EITHER(answers("confirmed"))[1][1]] as const,
  ])("answers 503, not 500, when %s gives %s", async (_on, _name, ports) => {
    const { get, calls } = await start({ networks: INSIDE, ...ports });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await get(OPS, COOKIE)).toEqual({
        status: 503,
        code: "unavailable",
        connection: "close",
      });
      const lines = stderr.mock.calls.map((args) => String(args[0]));
      // The fault, and the refusal's own record (DAN-842-3), with the same request id.
      const events = lines.map((line) => JSON.parse(line) as { event: string; requestId: string });
      expect(events.map((e) => e.event)).toEqual(["server_error", "authz.operator_denied"]);
      expect(events[0]).toMatchObject({ where: "layer" });
      expect(events[1]!.requestId).toBe(events[0]!.requestId);
      expect(lines.join("\n")).not.toContain(TOKEN);
    } finally {
      stderr.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  it("does not ask either port on other paths", async () => {
    const { get, calls, tokens, asked } = await start({
      networks: OUTSIDE,
      secondFactor: answers("unconfirmed"),
    });
    for (const path of ["/api/v1/health", "/api/v1/opsx", "/api/v1/%6Fps/x"]) {
      expect((await get(path, COOKIE)).status, path).toBe(404);
    }
    expect(tokens).toEqual([]);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("without a port no session has a second factor", async () => {
    const { get, calls } = await start({ networks: INSIDE });
    expect(await get(OPS, COOKIE)).toEqual({ status: 403, code: "forbidden", connection: "close" });
    expect(calls).toEqual([]);
  });
});
