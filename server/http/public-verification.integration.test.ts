// SRV-9B (✓ C-6): POST /api/v1/public/verification over a real server and a
// fake read. Every id, hash and key here is invented; the read answers
// no_match, so the signature path stays in server/public-verification's tests.
import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";

import {
  createPublicVerificationRouteFor,
  PUBLIC_VERIFICATION_PER_MINUTE,
  publicVerificationLimiter,
} from "./public-verification.ts";

const ORIGIN = "https://ductura.example.invalid";
const BODY = {
  submissionId: "00000000-0000-4000-8000-00000000c0de",
  artifactSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
};
const NO_MATCH_ROW = { outcome: "no_match" };
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
});

async function open(rows: unknown[] | Error = [NO_MATCH_ROW], perMinute?: number) {
  const tokens: (string | null | undefined)[] = [];
  const withActor: WithActor = async (token, transact) => {
    tokens.push(token);
    return transact({
      query: async () => {
        if (rows instanceof Error) throw rows;
        return { rows, rowCount: rows.length };
      },
    } as unknown as ActorTransaction);
  };
  let clock = 0;
  const limiter =
    perMinute === undefined ? publicVerificationLimiter() : publicVerificationLimiter(() => clock);
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createPublicVerificationRouteFor({ withActor }, limiter)],
  });
  const send = (body: unknown = BODY, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${running?.port}/api/v1/public/verification`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { send, tokens, tick: (ms: number) => (clock += ms) };
}

describe("POST /api/v1/public/verification", () => {
  it("answers match false without a login, and sets no cookie", async () => {
    const { send, tokens } = await open();
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ match: false });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(tokens).toEqual([null]);
  });

  it("never passes the session cookie on to the database (D-09)", async () => {
    const { send, tokens } = await open();
    const response = await send(BODY, { cookie: `__Host-ductus_session=${"T".repeat(43)}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(tokens).toEqual([null]);
  });

  it.each([
    ["an upper-case id", { ...BODY, submissionId: BODY.submissionId.toUpperCase() }],
    ["a short hash", { ...BODY, artifactSha256: BODY.artifactSha256.slice(1) }],
    ["an unknown field", { ...BODY, email: "student@example.invalid" }],
    ["a missing hash", { submissionId: BODY.submissionId }],
  ])("refuses %s as 422 without a read", async (_name, body) => {
    const { send, tokens } = await open();
    const response = await send(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
    expect(tokens).toEqual([]);
  });

  it("refuses broken JSON as 400 and another media type as 415", async () => {
    const { send } = await open();
    expect((await send("{")).status).toBe(400);
    expect((await send(BODY, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("answers 503 when the read fails", async () => {
    const { send } = await open(new Error("connection refused"));
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "unavailable" });
  });

  it("limits one address, then lets it through after Retry-After", async () => {
    const { send, tokens, tick } = await open([NO_MATCH_ROW], PUBLIC_VERIFICATION_PER_MINUTE);
    for (let i = 0; i < PUBLIC_VERIFICATION_PER_MINUTE; i += 1) {
      expect((await send()).status).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    const wait = Number(limited.headers.get("retry-after"));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(tokens).toHaveLength(PUBLIC_VERIFICATION_PER_MINUTE);
    tick(wait * 1000);
    expect((await send()).status).toBe(200);
  });
});
