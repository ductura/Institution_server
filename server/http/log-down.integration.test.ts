// S-1K.3-b (DAN-812, plan ductura/server#109): the log database being slow or
// down does not change the main answers. Three servers over real HTTP, each
// with a log service on a log database that is ok (the fake log database of
// @ductura/test-fakes, PGlite), slow (append never settles) or down (append
// rejects with a message carrying the canary). Invented values only.
import { createFakeLogDatabase, type FakeLogDatabase } from "@ductura/test-fakes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger, createLogWriter, type LogStore } from "../log/index.ts";
import { createHealthRoute } from "./health.ts";
import { createLayers, type Layer } from "./pipeline.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import type { Handler } from "./router.ts";
import { createShutdownCoordinator, type ShutdownCoordinator } from "./shutdown.ts";
import { type Running, startServer } from "./start.ts";

const CANARY = "made-up-canary-812d";
/** Long enough that an answer which waited for it could not pass the timing check. */
const DEADLINE_MS = 2_000;
const ANSWER_WITHIN_MS = 1_000;
const MODES = ["ok", "slow", "down"] as const;
type Mode = (typeof MODES)[number];

const HEALTH = createHealthRoute({
  health: async () => ({ main: "ok", logs: "nedostupno", legal: "ok" }),
  serverVersion: "0.0.0",
});

// Routes are chosen by contract path; this test picks the case by a query.
const route: Handler = async (request, response) => {
  if ((request.url ?? "").includes("case=throw")) throw new TypeError(CANARY);
  return HEALTH.handle(request, response);
};
const throwingLayer: Layer = async (request) => {
  const url = request.url ?? "";
  if (url.includes("case=layer")) throw new RangeError(CANARY);
  if (url.includes("case=request")) {
    // The router reads the path outside its handler catch, so this throw
    // rejects the whole request and only start.ts catches it (A10).
    Object.defineProperty(request, "url", {
      get() {
        throw new SyntaxError(CANARY);
      },
    });
  }
  return "next";
};

type Setup = {
  running: Running;
  shutdown: ShutdownCoordinator;
  lines: string[];
  appended: number;
};
const setups = new Map<Mode, Setup>();
let fakeDb: FakeLogDatabase;
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

function storeFor(mode: Mode, setup: { appended: number }): LogStore {
  const count = () => (setup.appended += 1);
  if (mode === "ok") return { append: (kind, payload) => (count(), fakeDb.append(kind, payload)) };
  if (mode === "slow") return { append: () => (count(), new Promise(() => {})) };
  return { append: () => (count(), Promise.reject(new Error(`logs down ${CANARY}`))) };
}

beforeAll(async () => {
  process.on("unhandledRejection", onRejection);
  fakeDb = await createFakeLogDatabase();
  for (const mode of MODES) {
    const partial = { lines: [] as string[], appended: 0 };
    const shutdown = createShutdownCoordinator({ graceMs: 1_000 });
    const log = createLogWriter({
      store: storeFor(mode, partial),
      routes: new Set(),
      fallback: createLogger((_level, line) => partial.lines.push(line)),
      deadlineMs: DEADLINE_MS,
    });
    const running = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: { ...createLayers({ expectedOrigin: null }), ipRules: throwingLayer },
      databases: {
        main: {} as never,
        health: async () => ({ main: "ok", logs: "nedostupno", legal: "ok" }),
        close: async () => {},
      },
      shutdown,
      routes: [{ contract: HEALTH.contract, handle: route }],
      log,
    });
    setups.set(mode, {
      ...partial,
      running,
      shutdown,
      get appended() {
        return partial.appended;
      },
    });
  }
});
afterAll(async () => {
  process.off("unhandledRejection", onRejection);
  for (const { running } of setups.values()) running.closeAllConnections();
  await fakeDb.close();
});

const setupOf = (mode: Mode): Setup => setups.get(mode) as Setup;

type Answer = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  ms: number;
  id?: string;
};

async function ask(mode: Mode, query: string): Promise<Answer> {
  const started = performance.now();
  const response = await fetch(
    `http://127.0.0.1:${setupOf(mode).running.port}${HEALTH.contract.path}${query}`,
  );
  const text = await response.text();
  const ms = performance.now() - started;
  const headers = Object.fromEntries(response.headers);
  const id = headers[REQUEST_ID_HEADER.toLowerCase()];
  delete headers["date"];
  delete headers[REQUEST_ID_HEADER.toLowerCase()];
  const body = JSON.parse(text) as Record<string, unknown>;
  if (typeof body.requestId === "string") {
    expect(body.requestId).toBe(id);
    body.requestId = "<id>";
  }
  return { status: response.status, headers, body, ms, ...(id === undefined ? {} : { id }) };
}

const CASES = ["", "?case=throw", "?case=layer", "?case=request"] as const;

/** What a client compares: status, headers and body, not the timing or the request id. */
const shapeOf = (answer: Answer) => ({
  status: answer.status,
  headers: answer.headers,
  body: answer.body,
});

describe("the log database slow or down, over real HTTP", () => {
  it("leaves every answer as it is with the log database ok, at once (A1, A2, A9, A10, A15)", async () => {
    const answers = new Map<Mode, Answer[]>();
    for (const mode of MODES) {
      const list: Answer[] = [];
      for (const query of CASES) list.push(await ask(mode, query));
      answers.set(mode, list);
    }
    const reference = answers.get("ok") ?? [];
    expect(reference.map((answer) => answer.status)).toEqual([200, 500, 500, 500]);
    for (const mode of MODES) {
      const list = answers.get(mode) ?? [];
      for (const [i, answer] of list.entries()) {
        expect(shapeOf(answer), `${mode} ${CASES[i]}`).toEqual(shapeOf(reference[i] as Answer));
        const { ms } = answer;
        expect(ms, `${mode} ${CASES[i]} answered in ${ms} ms`).toBeLessThan(ANSWER_WITHIN_MS);
        expect(JSON.stringify(answer)).not.toContain(CANARY);
      }
    }

    // ok: both uncaught errors are rows of the log database, tied to the answers.
    const okIds = reference.slice(1).map((answer) => answer.id);
    await vi.waitFor(async () => expect(await fakeDb.entries()).toHaveLength(3));
    const rows = await fakeDb.entries();
    expect(rows.map((row) => row.kind)).toEqual(Array(3).fill("error.unexpected"));
    expect(rows.map((row) => (row.payload as { requestId: string }).requestId)).toEqual(okIds);
    expect(rows.map((row) => (row.payload as { fields: object }).fields)).toEqual([
      { area: "http", errorClass: "type_error" },
      { area: "http", errorClass: "range_error" },
      { area: "http", errorClass: "syntax_error" },
    ]);
    expect(setupOf("ok").lines).toEqual([]);

    // down at once, slow at the deadline: the record is in the fallback line,
    // never lost silently, and the store's message is never in it.
    for (const [mode, code] of [
      ["down", "LOG_STORE_FAILED"],
      ["slow", "LOG_STORE_TIMEOUT"],
    ] as const) {
      const { lines } = setupOf(mode);
      await vi.waitFor(() => expect(lines).toHaveLength(3), { timeout: DEADLINE_MS * 3 });
      const ids = (answers.get(mode) ?? []).slice(1).map((answer) => answer.id);
      for (const [i, line] of lines.entries()) {
        expect(line).not.toContain(CANARY);
        expect(JSON.parse(line)).toMatchObject({
          level: "error",
          event: "log_store_failed",
          fields: {
            code,
            record: { event: "error.unexpected", requestId: ids[i], fields: { area: "http" } },
          },
        });
      }
    }
    expect(rejections).toEqual([]);
  });

  it("drains on shutdown without waiting for a write the log database holds (A14)", async () => {
    const { running, shutdown } = setupOf("slow");
    const before = setupOf("slow").appended;
    expect((await ask("slow", "?case=throw")).status).toBe(500);
    expect(setupOf("slow").appended).toBe(before + 1);
    const started = performance.now();
    running.stopAccepting();
    await expect(shutdown.stop()).resolves.toEqual({ outcome: "drained" });
    expect(performance.now() - started).toBeLessThan(ANSWER_WITHIN_MS);
  });
});
