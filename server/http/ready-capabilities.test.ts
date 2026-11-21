// SRV-1812 (plan M11.3): the readiness probes over fake ports and the route
// over them. Acceptance (1): GET /api/v1/ready answers 503 while the
// migrations are not done, and 200 once they are. Acceptance (2): the log of
// readiness carries only closed codes, never an e-mail address or the text
// of a work, even when a port fails with one. Every value below is invented.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { createLogger, type LogEvent } from "../log/index.ts";
import { ROUTES } from "../contracts/index.ts";

import { STORAGE_NOT_CONFIGURED } from "./evidence-deps.ts";
import { createReadyCheck, type ReadyReport } from "./ready.ts";
import {
  loggedReadyCheck,
  MIGRATIONS_MISSING,
  MIGRATIONS_RUNNING,
  readinessCapabilities,
  type ReadinessDependencies,
} from "./ready-capabilities.ts";
import { createReadyRoute } from "./ready-route.ts";
import { createRouter } from "./router.ts";

const EMAIL = "izmisljena.studentica@fakultet.invalid";
const WORK_TEXT = "Uvod: kućno kompostiranje u izmišljenom gradu";

type Schema = Awaited<ReturnType<ReadinessDependencies["schema"]>>;

function deps(over: Partial<ReadinessDependencies> = {}): ReadinessDependencies {
  return {
    schema: async (): Promise<Schema> => ({ migrated: true }),
    payloads: STORAGE_NOT_CONFIGURED,
    signer: {
      publicVerificationKey: async () => ({ ok: true, value: "izmisljeni-javni-kljuc" }) as never,
    },
    ...over,
  };
}

const check = (d: ReadinessDependencies) => createReadyCheck(readinessCapabilities(d));

/** The route's status and body over `run`, through the router with a minimal response. */
async function answer(run: () => Promise<ReadyReport>): Promise<{ status: number; body: unknown }> {
  const set = new Map<string, string>();
  const out = { status: 0, text: "" };
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
    writeHead(status: number) {
      out.status = status;
      this.headersSent = true;
    },
    end(text?: string) {
      out.text = text ?? "";
      this.writableEnded = true;
    },
    destroy: () => undefined,
  };
  const router = createRouter([createReadyRoute({ check: run, draining: () => false })]);
  const request = { method: "GET", url: "/api/v1/ready" } as IncomingMessage;
  await router(request, response as unknown as ServerResponse);
  return {
    status: out.status,
    body: out.text === "" ? undefined : (JSON.parse(out.text) as unknown),
  };
}

describe("readinessCapabilities: the database and its migrations", () => {
  it("acceptance 1: 503 while a migration run holds the lock", async () => {
    const report = await check(
      deps({ schema: async () => ({ migrated: false, reason: "migrating" }) }),
    )();
    expect(report).toMatchObject({
      ready: false,
      capabilities: { database: "nedostupno" },
      codes: { database: MIGRATIONS_RUNNING },
    });
    const { status, body } = await answer(async () => report);
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "unavailable", capabilities: { database: "nedostupno" } });
  });

  it("acceptance 1: 503 when the migrator never ran", async () => {
    const report = await check(
      deps({ schema: async () => ({ migrated: false, reason: "not_migrated" }) }),
    )();
    expect(report.codes.database).toBe(MIGRATIONS_MISSING);
    expect((await answer(async () => report)).status).toBe(503);
  });

  it("503 when the database fails, by the code of the failure only", async () => {
    const failure = Object.assign(new Error(`connect ${EMAIL}`), { code: "ECONNREFUSED" });
    const report = await check(
      deps({
        schema: async () => {
          throw failure;
        },
      }),
    )();
    expect(report).toMatchObject({ ready: false, codes: { database: "ECONNREFUSED" } });
  });

  it("200 once the migrations are done, with storage and signing only reported", async () => {
    const report = await check(deps())();
    expect(report).toEqual({
      ready: true,
      capabilities: { database: "ok", storage: "nije_konfigurirano", signing: "ok" },
      codes: {},
    });
    const { status, body } = await answer(async () => report);
    expect(status).toBe(200);
    expect(body).toEqual({
      status: "ready",
      capabilities: { database: "ok", storage: "nije_konfigurirano", signing: "ok" },
    });
    const contract = ROUTES.find((r) => r.id === "platform.ready.get");
    expect(Value.Check(contract?.responses[0]?.body as never, body)).toBe(true);
  });

  it("asks the database once while a probe is still running (single flight)", async () => {
    let calls = 0;
    let release: (value: Schema) => void = () => {};
    const run = check(
      deps({
        schema: () => {
          calls += 1;
          return new Promise<Schema>((go) => (release = go));
        },
      }),
    );
    const first = run();
    const second = run();
    await new Promise((go) => setImmediate(go));
    await new Promise((go) => setImmediate(go));
    release({ migrated: true });
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});

describe("readinessCapabilities: storage and signing", () => {
  it("storage with every domain verified is ok, and one not verified is nedostupno", async () => {
    const verified = { verifyAll: async () => ({ a: "verified", b: "verified" }) };
    const one = { verifyAll: async () => ({ a: "verified", b: "failed" }) };
    expect((await check(deps({ payloads: verified as never }))()).capabilities.storage).toBe("ok");
    const report = await check(deps({ payloads: one as never }))();
    expect(report).toMatchObject({
      ready: true,
      capabilities: { storage: "nedostupno" },
      codes: { storage: "STORAGE_DOMAIN" },
    });
  });

  it("a storage port without verifyAll is nedostupno", async () => {
    const report = await check(deps({ payloads: {} as never }))();
    expect(report.codes.storage).toBe("STORAGE_DOMAIN");
  });

  it("a signer without a key is nije_konfigurirano, a throwing one nedostupno", async () => {
    const none = {
      publicVerificationKey: async () =>
        ({ ok: false, error: { code: "SIGNING_KEY_NOT_CONFIGURED" } }) as never,
    };
    const throwing = {
      publicVerificationKey: async () => {
        throw new Error(WORK_TEXT);
      },
    };
    expect((await check(deps({ signer: none }))()).capabilities.signing).toBe("nije_konfigurirano");
    const report = await check(deps({ signer: throwing }))();
    expect(report).toMatchObject({ ready: true, capabilities: { signing: "nedostupno" } });
    expect(report.codes.signing).toBe("SIGNING");
  });
});

describe("loggedReadyCheck", () => {
  function capture(): { log: LogEvent; lines: string[] } {
    const lines: string[] = [];
    return { log: createLogger((_level, line) => lines.push(line)), lines };
  }

  it("acceptance 2: logs each change once, with codes only, no e-mail and no text of a work", async () => {
    let schema: Schema = { migrated: false, reason: "migrating" };
    const { log, lines } = capture();
    const run = loggedReadyCheck(
      check(
        deps({
          schema: async () => schema,
          signer: {
            publicVerificationKey: async () => {
              throw Object.assign(new Error(`${EMAIL}: ${WORK_TEXT}`), { text: WORK_TEXT });
            },
          },
          payloads: {
            verifyAll: async () => ({ [EMAIL]: WORK_TEXT }),
          } as never,
        }),
      ),
      log,
    );
    await run();
    await run();
    schema = { migrated: true };
    await run();
    await run();
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toMatchObject({
      level: "warn",
      event: "ready.changed",
      fields: {
        ready: false,
        codes: { database: MIGRATIONS_RUNNING, storage: "STORAGE_DOMAIN", signing: "SIGNING" },
      },
    });
    expect(second).toMatchObject({ level: "info", fields: { ready: true } });
    const all = lines.join("\n");
    for (const part of [EMAIL, "fakultet.invalid", "@", WORK_TEXT, "kompostiranje"])
      expect(all).not.toContain(part);
  });
});
