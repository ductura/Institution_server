// Readiness route (S-1E-d, DAN-839-2) through the router over the real core
// with fake probes: every vector of platform.ready.get, and what never leaves
// the route (codes, messages, words outside the list, addresses, versions).
// Contract: Ductus#1836 c.6929935613.
import type { IncomingMessage, ServerResponse } from "node:http";

import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Vector } from "../contracts/index.ts";
import { createReadyCheck, type ReadyCapability, type ReadyReport } from "./ready.ts";
import { createReadyRoute } from "./ready-route.ts";
import { createRouter } from "./router.ts";

const CANARY = "postgres://db.invalid:5432 PostgreSQL 16.4";
const { vectors } = JSON.parse(
  readFileSync(new URL("../contracts/vectors/platform.ready.get.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

type Answer = { status?: number; headers: Record<string, string>; text: string };

// A request and response with only what the router and its writers touch.
async function ask(check: () => Promise<ReadyReport>, draining: () => boolean = () => false) {
  const answer: Answer = { headers: {}, text: "" };
  const set = new Map<string, string>([["retry-after", "99"]]);
  const response = {
    headersSent: false,
    writableEnded: false,
    statusMessage: "",
    setHeader: (name: string, value: string) => set.set(name.toLowerCase(), value),
    getHeader: (name: string) => set.get(name.toLowerCase()),
    hasHeader: (name: string) => set.has(name.toLowerCase()),
    removeHeader: (name: string) => set.delete(name.toLowerCase()),
    getHeaderNames: () => [...set.keys()],
    addTrailers: () => undefined,
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status;
      answer.headers = { ...Object.fromEntries(set), ...headers };
      this.headersSent = true;
    },
    end(text?: string) {
      answer.text = text ?? "";
      this.writableEnded = true;
    },
    destroy: () => undefined,
  };
  const router = createRouter([createReadyRoute({ check, draining })]);
  const request = { method: "GET", url: "/api/v1/ready" } as IncomingMessage;
  await router(request, response as unknown as ServerResponse);
  return answer;
}

const probe = (answer: "ok" | "nije_konfigurirano" | "fails"): ReadyCapability["probe"] =>
  answer === "fails"
    ? async () => Promise.reject(Object.assign(new Error(CANARY), { code: "ECONNREFUSED" }))
    : async () => answer;
const core = (words: Record<string, "ok" | "nije_konfigurirano" | "fails">) =>
  createReadyCheck(
    Object.entries(words).map(([name, answer]) => ({
      name: name as ReadyCapability["name"],
      required: true,
      timeoutMs: 1_000,
      probe: probe(answer),
    })),
  );
const reportOf = (report: unknown) => async () => report as ReadyReport;
const UNAVAILABLE = { status: "unavailable", capabilities: {} };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ready route refuses", () => {
  it("while draining, without calling a probe", async () => {
    const called = vi.fn(probe("fails"));
    const check = createReadyCheck([
      { name: "database", required: true, timeoutMs: 1_000, probe: called },
    ]);
    const answer = await ask(check, () => true);
    expect([answer.status, JSON.parse(answer.text)]).toEqual([503, { status: "draining" }]);
    expect(answer.headers["retry-after"]).toBe("1");
    expect(called).not.toHaveBeenCalled();
  });

  it("when draining starts while the check runs", async () => {
    let draining = false;
    const check = async () => {
      draining = true;
      return core({ database: "ok" })();
    };
    const answer = await ask(check, () => draining);
    expect([answer.status, JSON.parse(answer.text)]).toEqual([503, { status: "draining" }]);
  });

  const trap = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error(CANARY);
      },
      getOwnPropertyDescriptor: () => {
        throw new Error(CANARY);
      },
    },
  );
  it.each([
    [
      "a check that throws",
      () => {
        throw new Error(CANARY);
      },
    ],
    ["a check that rejects", async () => Promise.reject(new Error(CANARY))],
    ["null", reportOf(null)],
    ["a primitive", reportOf(CANARY)],
    ["no capabilities", reportOf({ ready: true })],
    ["capabilities not a record", reportOf({ ready: true, capabilities: CANARY })],
    ["a trapping proxy", reportOf({ ready: true, capabilities: trap })],
  ] as [string, () => Promise<ReadyReport>][])(
    "%s as unavailable, telling nothing",
    async (_, check) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const answer = await ask(check);
      expect([answer.status, JSON.parse(answer.text)]).toEqual([503, UNAVAILABLE]);
      expect(answer.headers["retry-after"]).toBe("5");
      expect(JSON.stringify(answer)).not.toContain("invalid");
      expect(logged).not.toHaveBeenCalled();
      expect(warned).not.toHaveBeenCalled();
    },
  );

  it("a draining check that throws as unavailable", async () => {
    const answer = await ask(core({}), () => {
      throw new Error(CANARY);
    });
    expect([answer.status, JSON.parse(answer.text)]).toEqual([503, UNAVAILABLE]);
  });

  it.each([["true"], [1], [null]])("ready %j as unavailable", async (ready) => {
    const answer = await ask(reportOf({ ready, capabilities: { database: "ok" }, codes: {} }));
    expect([answer.status, JSON.parse(answer.text)]).toEqual([
      503,
      { status: "unavailable", capabilities: { database: "ok" } },
    ]);
  });

  it.each([["OK"], ["ok\n"], ["ok\r\n"], ["ok\t"], ["ok "], ["ok\u007f"], [CANARY], [1]])(
    "the word %j as nedostupno and unavailable",
    async (word) => {
      const answer = await ask(reportOf({ ready: true, capabilities: { database: word } }));
      expect([answer.status, JSON.parse(answer.text)]).toEqual([
        503,
        { status: "unavailable", capabilities: { database: "nedostupno" } },
      ]);
    },
  );

  it("only own closed names leave, never codes or other keys", async () => {
    const capabilities = Object.create({ storage: "ok" }) as Record<string, unknown>;
    Object.defineProperty(capabilities, "signing", { get: () => "ok", enumerable: true });
    Object.assign(capabilities, { database: "ok", toString: "ok", extra: "ok" });
    Object.defineProperty(capabilities, "__proto__", { value: "ok", enumerable: true });
    const answer = await ask(
      reportOf({ ready: true, capabilities, codes: { database: CANARY }, version: "16.4" }),
    );
    expect([answer.status, JSON.parse(answer.text)]).toEqual([
      200,
      { status: "ready", capabilities: { database: "ok" } },
    ]);
    expect(answer.text).not.toContain("16.4");
  });
});

describe("ready route", () => {
  const scenarios: Record<string, [() => Promise<ReadyReport>, () => boolean]> = {
    ready: [core({ database: "ok", storage: "ok", signing: "ok" }), () => false],
    unavailable: [
      core({ database: "fails", storage: "ok", signing: "nije_konfigurirano" }),
      () => false,
    ],
    draining: [core({ database: "fails" }), () => true],
  };

  it("has a scenario for every vector", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(Object.keys(scenarios).sort());
  });

  it.each(vectors.map((v) => [v.name, v] as const))("passes vector %s", async (name, vector) => {
    const [check, draining] = scenarios[name] as [() => Promise<ReadyReport>, () => boolean];
    const route = createReadyRoute({ check, draining });
    const answer = await ask(check, draining);
    const body: unknown = JSON.parse(answer.text);
    expect(answer.status).toBe(vector.response.status);
    expect(answer.headers["content-type"]?.split(";")[0]).toBe(vector.response.contentType);
    expect(body).toEqual(vector.response.body);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["retry-after"]).toBe(
      { ready: undefined, unavailable: "5", draining: "1" }[name],
    );
    const schema =
      vector.kind === "success"
        ? route.contract.responses[0]?.body
        : route.contract.errors.find((e) => e.code === vector.code)?.body;
    expect(Value.Check(schema as never, body)).toBe(true);
    // Public: no address, no version, no code of a failed probe.
    expect(answer.text).not.toMatch(/invalid|ECONNREFUSED|\d+\.\d+/);
    expect(Object.keys(answer.headers).filter((h) => /version/i.test(h))).toEqual([]);
  });
});
