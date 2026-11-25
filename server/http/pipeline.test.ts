// The order and the closed failure of the pipeline (S-1B-b, DAN-777), with spy
// layers on a ServerResponse that has no socket: no network.
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import type { LogWriter } from "../log/index.ts";
import { parseAllowedNetworks, type RateLimiter } from "../traffic/index.ts";

import {
  type App,
  createLayers,
  createPipeline,
  type Layer,
  type Layers,
  PIPELINE_STEPS,
  type Step,
  trafficLogFor,
  trafficRouteOf,
} from "./pipeline.ts";
import { SECURITY_HEADERS } from "./security-headers.ts";

function exchange(method = "GET"): { request: IncomingMessage; response: ServerResponse } {
  const request = new IncomingMessage(new Socket());
  request.method = method;
  request.url = "/api/v1/health";
  const response = new ServerResponse(request);
  // A socket that discards what is written.
  const sink = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() });
  response.assignSocket(sink as unknown as Socket);
  return { request, response };
}

type Spy = { calls: string[]; layers: Layers; app: App };

/** Every layer records its step and answers "next" unless the case overrides it. */
function spies(overrides: Partial<Record<Step, Layer>> = {}): Spy {
  const calls: string[] = [];
  const layers = Object.fromEntries(
    PIPELINE_STEPS.map((step) => [
      step,
      async (request: IncomingMessage, response: ServerResponse) => {
        calls.push(step);
        return (overrides[step] ?? (async () => "next" as const))(request, response);
      },
    ]),
  ) as unknown as Layers;
  const app: App = async (_request, response) => {
    calls.push("app");
    response.end();
  };
  return { calls, layers, app };
}

async function run(spy: Spy, method = "GET") {
  const { request, response } = exchange(method);
  await createPipeline(spy.layers, spy.app)(request, response);
  return response;
}

describe("PIPELINE_STEPS", () => {
  it("is closed and frozen", () => {
    expect(PIPELINE_STEPS).toEqual([
      "clientIp",
      "ipRules",
      "rateLimit",
      "trafficRecord",
      "securityHeaders",
      "originCheck",
      "operatorPolicy",
    ]);
    expect(Object.isFrozen(PIPELINE_STEPS)).toBe(true);
  });

  // The whole table, not a sample: rows 2 to 8 of docs/server-map.md §3 are the steps, in order.
  it("matches steps 2 to 8 of docs/server-map.md §3", () => {
    const NAMES = new Map<string, Step>([
      ["IP", "clientIp"],
      ["IP prava", "ipRules"],
      ["Ograničenje", "rateLimit"],
      ["Zapis prometa", "trafficRecord"],
      ["Sigurnosna zaglavlja", "securityHeaders"],
      ["Zaštita porijekla", "originCheck"],
      ["Operatorska pravila", "operatorPolicy"],
    ]);
    const map = readFileSync(new URL("../../docs/server-map.md", import.meta.url), "utf8");
    const section = map.slice(map.indexOf("## 3."), map.indexOf("### Gdje se piše"));
    const rows = [...section.matchAll(/^\| (\d+)\s+\| ([^|]+?)\s+\|/gmu)]
      .map(([, number, name]) => [Number(number), (name ?? "").replaceAll("`", "")] as const)
      .filter(([number]) => number >= 2 && number <= 8);
    expect(rows.map(([number]) => number)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(rows.map(([, name]) => NAMES.get(name))).toEqual([...PIPELINE_STEPS]);
  });
});

describe("createPipeline", () => {
  it("runs every layer in the order of PIPELINE_STEPS, then the application once", async () => {
    const spy = spies();
    await run(spy);
    expect(spy.calls).toEqual([...PIPELINE_STEPS, "app"]);
  });

  it("keeps the order whatever the order of the keys", async () => {
    const spy = spies();
    const reversed = Object.fromEntries(Object.entries(spy.layers).reverse()) as unknown as Layers;
    await run({ ...spy, layers: reversed });
    expect(spy.calls).toEqual([...PIPELINE_STEPS, "app"]);
  });

  it("reads the layers once: a later change to the object has no effect", async () => {
    const spy = spies();
    const layers = { ...spy.layers };
    const pipeline = createPipeline(layers, spy.app);
    (layers as Record<string, Layer>).originCheck = async () => "next";
    (layers as Record<string, Layer>).clientIp = async () => "done";
    const { request, response } = exchange();
    await pipeline(request, response);
    expect(spy.calls).toEqual([...PIPELINE_STEPS, "app"]);
  });

  it.each([
    ["a missing step", (l: Record<string, unknown>) => delete l.rateLimit],
    ["an extra step", (l: Record<string, unknown>) => (l.bypass = async () => "next")],
    ["a step that is not a function", (l: Record<string, unknown>) => (l.ipRules = "next")],
    [
      "a step inherited from the prototype",
      (l: Record<string, unknown>) => {
        const layer = l.originCheck;
        delete l.originCheck;
        Object.setPrototypeOf(l, { originCheck: layer });
      },
    ],
  ])("refuses %s at startup", (_, change) => {
    const spy = spies();
    const layers: Record<string, unknown> = { ...spy.layers };
    change(layers);
    expect(() => createPipeline(layers as unknown as Layers, spy.app)).toThrow(/layer/u);
  });

  it.each(PIPELINE_STEPS.map((step, index) => [step, index] as const))(
    "a refusal at %s stops the request before every later step and the application",
    async (step, index) => {
      const spy = spies({
        [step]: async (_request: IncomingMessage, response: ServerResponse) => {
          response.writeHead(403).end();
          return "done" as const;
        },
      });
      const response = await run(spy);
      expect(spy.calls).toEqual(PIPELINE_STEPS.slice(0, index + 1));
      expect(response.statusCode).toBe(403);
    },
  );

  it.each([
    ["throws", async () => Promise.reject(new TypeError("invented-canary"))],
    // Adversarial pass: a thrown null broke the log line and lost the headers.
    ["throws null", async () => Promise.reject(null as unknown as Error)],
    ["answers undefined", async () => undefined],
    ["answers an unknown word", async () => "skip"],
    ["answers done without answering", async () => "done"],
  ])("fails closed with 500 when a layer %s", async (_, layer) => {
    const spy = spies({ rateLimit: layer as unknown as Layer });
    const response = await run(spy);
    expect(spy.calls).toEqual(["clientIp", "ipRules", "rateLimit"]);
    expect([response.statusCode, response.writableEnded]).toEqual([500, true]);
    for (const { key } of SECURITY_HEADERS) expect(response.hasHeader(key), key).toBe(true);
  });

  it("stops when a layer answered but still says next", async () => {
    const spy = spies({
      ipRules: async (_request, response) => {
        response.writeHead(429).end();
        return "next";
      },
    });
    const response = await run(spy);
    expect(spy.calls).toEqual(["clientIp", "ipRules"]);
    expect(response.statusCode).toBe(429);
  });

  it("cuts a response a layer started and left open", async () => {
    const spy = spies({
      trafficRecord: async (_request, response) => {
        response.flushHeaders();
        return "next";
      },
    });
    const response = await run(spy);
    expect(spy.calls).toEqual(["clientIp", "ipRules", "rateLimit", "trafficRecord"]);
    expect(response.destroyed).toBe(true);
  });
});

// Adversarial pass on DAN-777 a2: Node hands over a pipelined request before
// the answer to the one before it; a request queued behind a refusal that
// closes the connection ran with no one to answer.
describe("a request whose response has no socket yet", () => {
  function queued() {
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    return { request, response: new ServerResponse(request) };
  }

  it("waits for the socket before the first layer", async () => {
    const spy = spies();
    const { request, response } = queued();
    const done = createPipeline(spy.layers, spy.app)(request, response);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy.calls).toEqual([]);
    response.assignSocket(
      new Duplex({ read() {}, write: (_c, _e, next) => next() }) as unknown as Socket,
    );
    await done;
    expect(spy.calls).toEqual([...PIPELINE_STEPS, "app"]);
  });

  it("never runs when the connection closes first", async () => {
    const spy = spies();
    const { request, response } = queued();
    const done = createPipeline(spy.layers, spy.app)(request, response);
    request.emit("close");
    await done;
    expect(spy.calls).toEqual([]);
  });
});

describe("createLayers", () => {
  it("names exactly the steps and is frozen", () => {
    const layers = createLayers({ expectedOrigin: null });
    expect(Object.keys(layers).sort()).toEqual([...PIPELINE_STEPS].sort());
    expect(Object.isFrozen(layers)).toBe(true);
  });

  it("sets the security headers and refuses a POST without our origin before the application", async () => {
    let app = 0;
    const pipeline = createPipeline(
      createLayers({ expectedOrigin: "https://ductura.invalid" }),
      async (_q, r) => {
        app += 1;
        r.end();
      },
    );
    const get = exchange("GET");
    await pipeline(get.request, get.response);
    for (const { key } of SECURITY_HEADERS) expect(get.response.hasHeader(key), key).toBe(true);
    const post = exchange("POST");
    await pipeline(post.request, post.response);
    expect([post.response.statusCode, app]).toEqual([403, 1]);
  });
});

// Step 5 (DAN-1536): the traffic record is written for every answered request
// and never changes the answer.
describe("step 5, the traffic record", () => {
  const CANARY = "made-up-canary-1536";
  type Written = { event: string; fields: Record<string, unknown> };
  const ok = (): Promise<never> => Promise.resolve({ ok: true } as never);

  async function runWith(trafficLog: LogWriter | undefined, url = "/api/v1/health", status = 204) {
    const { request, response } = exchange("GET");
    request.url = url;
    request.headers.cookie = `session=${CANARY}`;
    request.headers["x-forwarded-for"] = CANARY;
    const app: App = async (_request, res) => {
      res.statusCode = status;
      res.end();
    };
    const layers = createLayers({
      expectedOrigin: null,
      ...(trafficLog === undefined ? {} : { trafficLog }),
    });
    await createPipeline(layers, app)(request, response);
    response.emit("close");
    return response;
  }

  it("writes one traffic.request for a success, with no body, cookie or query", async () => {
    const written: Written[] = [];
    const write: LogWriter = (input) => {
      written.push(input as Written);
      return ok();
    };
    const response = await runWith(write, `/api/v1/health?token=${CANARY}`);
    expect(response.statusCode).toBe(204);
    expect(written).toHaveLength(1);
    expect(written[0]?.event).toBe("traffic.request");
    expect(written[0]?.fields).toMatchObject({
      method: "GET",
      route: "/api/v1/health",
      status: 204,
    });
    expect(JSON.stringify(written)).not.toContain(CANARY);
  });

  it("writes the record of an error answer with its status", async () => {
    const written: Written[] = [];
    const write: LogWriter = (input) => {
      written.push(input as Written);
      return ok();
    };
    await runWith(write, "/api/v1/health", 500);
    expect(written[0]?.fields.status).toBe(500);
  });

  it.each([
    [
      "throws",
      (): never => {
        throw new Error(CANARY);
      },
    ],
    ["rejects", () => Promise.reject(new Error(CANARY))],
    ["never settles", () => new Promise<never>(() => undefined)],
  ])("does not change the answer when the writer %s", async (_name, write) => {
    const response = await runWith(write as unknown as LogWriter);
    expect(response.statusCode).toBe(204);
    expect(response.writableEnded).toBe(true);
  });

  it("records a request refused by the IP rules in step 3", async () => {
    const written: Written[] = [];
    const write: LogWriter = (input) => {
      written.push(input as Written);
      return ok();
    };
    const { request, response } = exchange("GET");
    request.url = "/api/v1/ops/ip-rules";
    const layers = createLayers({
      expectedOrigin: null,
      trafficLog: write,
      allowedNetworks: () => parseAllowedNetworks("203.0.113.0/24")!,
    });
    let app = 0;
    await createPipeline(layers, async () => void (app += 1))(request, response);
    response.emit("close");
    expect([response.statusCode, app]).toEqual([403, 0]);
    expect(written).toHaveLength(1);
    expect(written[0]?.fields.status).toBe(403);
  });

  it("records a request refused by the rate limit in step 4", async () => {
    const written: Written[] = [];
    const write: LogWriter = (input) => {
      written.push(input as Written);
      return ok();
    };
    const { request, response } = exchange("GET");
    const rateLimiter = {
      check: () => ({ allowed: false, bucket: "per_address", retryAfter: 5 }),
    } as unknown as RateLimiter;
    const layers = createLayers({ expectedOrigin: null, trafficLog: write, rateLimiter });
    await createPipeline(layers, async () => undefined)(request, response);
    response.emit("close");
    expect(response.statusCode).toBe(429);
    expect(written).toHaveLength(1);
    expect(written[0]?.fields.status).toBe(429);
  });

  it("records the 500 answer of a layer that throws after step 5", async () => {
    const written: Written[] = [];
    const write: LogWriter = (input) => {
      written.push(input as Written);
      return ok();
    };
    const { request, response } = exchange("GET");
    const layers = {
      ...createLayers({ expectedOrigin: null, trafficLog: write }),
      operatorPolicy: async (): Promise<"next"> => {
        throw new Error(CANARY);
      },
    };
    let app = 0;
    await createPipeline(
      layers,
      async () => void (app += 1),
      () => undefined,
    )(request, response);
    response.emit("close");
    expect([response.statusCode, app]).toEqual([500, 0]);
    expect(written).toHaveLength(1);
    expect(written[0]?.fields.status).toBe(500);
    expect(JSON.stringify(written)).not.toContain(CANARY);
  });

  it("records nothing, and still answers, without a writer", async () => {
    expect((await runWith(undefined)).statusCode).toBe(204);
  });

  it("names a route by its template and anything else as none", () => {
    const at = (url: string) => trafficRouteOf({ url } as IncomingMessage);
    expect(at("/api/v1/health?x=1")).toBe("/api/v1/health");
    expect(at("/api/v1/works/abc-123/access")).toBe("/api/v1/works/{documentId}/access");
    expect(at("/api/v1/works//access")).toBeNull();
    expect(at("/api/v1/nope")).toBeNull();
    expect(at("/api/v1/../health")).toBeNull();
    expect(at(undefined as unknown as string)).toBeNull();
  });
});

describe("trafficLogFor", () => {
  const ISO = "2026-11-25T10:00:00.000Z";
  const record = (extra: Record<string, unknown> = {}) => ({
    time: ISO,
    event: "traffic.request",
    requestId: "11111111-1111-4111-8111-111111111111",
    accountKind: "anonymous",
    fields: {
      method: "GET",
      route: "/api/v1/health",
      ip: "203.0.113.7",
      status: 200,
      durationMs: 3,
      ipRule: "not_checked",
      rateLimit: "not_checked",
    },
    ...extra,
  });

  it("inserts one log_entry row: the event as kind and the checked record as JSON", async () => {
    const calls: [string, unknown[]][] = [];
    const write = trafficLogFor({
      query: (text, values) => {
        calls.push([text, values]);
        return Promise.resolve();
      },
    });
    const result = await write(record());
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(
      "INSERT INTO public.log_entry (kind, payload) VALUES ($1, $2::jsonb)",
    );
    expect(calls[0]?.[1]?.[0]).toBe("traffic.request");
    const payload = JSON.parse(String(calls[0]?.[1]?.[1])) as Record<string, unknown>;
    expect(Object.keys(payload.fields as object).sort()).toEqual(
      ["durationMs", "ip", "ipRule", "method", "rateLimit", "route", "status"].sort(),
    );
  });

  it("refuses a route outside the contract, a body field and a cookie without writing", async () => {
    let calls = 0;
    const write = trafficLogFor({ query: () => void (calls += 1) });
    const bad = record();
    for (const fields of [
      { ...bad.fields, route: "/api/v1/not-a-route" },
      { ...bad.fields, body: "made-up-body" },
      { ...bad.fields, cookie: "session=made-up" },
    ]) {
      expect((await write({ ...bad, fields })).ok).toBe(false);
    }
    expect(calls).toBe(0);
  });

  it("does not throw when the logs database rejects", async () => {
    const write = trafficLogFor({ query: () => Promise.reject(new Error("made-up-db-down")) });
    const result = await write(record());
    expect(result.ok).toBe(false);
  });
});
