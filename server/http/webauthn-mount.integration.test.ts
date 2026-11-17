// DAN-840-3f1 (contract Ductus#1836 c.6941883834): the WebAuthn routes the
// entry point mounts, createWebAuthnRoutesFor(main, origin), use exactly
// main's port and run the session activity on main's own withActor; the
// browser's timeoutMs is the store's TTL; an origin that gives no rpId is 503
// before the port. Fakes record the calls; the database side is tests/db.
// Values are invented.
import { createSoftwareAuthenticator } from "@ductura/test-fakes/fido2";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ActorTransaction,
  WebAuthnCredential,
  WebAuthnCredentials,
  WithActor,
} from "../database/index.ts";
import { MAX_CHALLENGE_TTL_MS } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createWebAuthnRoutesFor, WEBAUTHN_TIMEOUT_MS } from "./webauthn.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "Izmisljeni_token-montiranja_webauthn_000001";

let server: Running | undefined;
const statements: { token: unknown; sql: string }[] = [];
const port = { list: [] as string[], add: [] as WebAuthnCredential[] };

const withActor = (async (token, fn) => {
  const tx = {
    async query(sql: string) {
      statements.push({ token, sql });
      return { rows: [{ touched: true }], rowCount: 1 };
    },
  } as unknown as ActorTransaction;
  return fn(tx);
}) as WithActor;
const webauthnCredentials = {
  list: async (token: string) => {
    port.list.push(token);
    return { status: "listed", credentials: [] };
  },
  add: async (_token: string, credential: WebAuthnCredential) => {
    port.add.push(credential);
    return { status: "added" };
  },
} as unknown as WebAuthnCredentials;

async function start(origin: string | null = ORIGIN) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createWebAuthnRoutesFor({ withActor, webauthnCredentials }, origin),
  });
}
afterEach(async () => {
  statements.length = 0;
  port.list.length = 0;
  port.add.length = 0;
  await server?.close();
  server = undefined;
});

const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server!.port}/api/v1/auth/webauthn/${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `__Host-ductus_session=${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

describe("createWebAuthnRoutesFor", () => {
  it("tells the browser the store's TTL, at most the store's bound", async () => {
    expect(WEBAUTHN_TIMEOUT_MS).toBe(120_000);
    expect(WEBAUTHN_TIMEOUT_MS).toBeLessThanOrEqual(MAX_CHALLENGE_TTL_MS);
    await start();
    const got = await post("challenge", { purpose: "assertion" });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      timeoutMs: WEBAUTHN_TIMEOUT_MS,
      rpId: "ductura.example.invalid",
      allowCredentials: [],
    });
    expect(port.list).toEqual([TOKEN]);
  });

  it("registers through main's port, then touches the session on main's withActor", async () => {
    await start();
    const issued = (await (await post("challenge", { purpose: "registration" })).json()) as {
      challenge: string;
    };
    const made = createSoftwareAuthenticator({
      rpId: "ductura.example.invalid",
      origin: ORIGIN,
    }).register(Buffer.from(issued.challenge, "base64url"));
    const got = await post("registration", {
      clientDataJSON: made.clientDataJSON.toString("base64url"),
      authenticatorData: made.authenticatorData.toString("base64url"),
      credentialId: made.credentialId.toString("base64url"),
    });
    expect(got.status).toBe(204);
    expect(port.add).toEqual([
      { credentialId: made.credentialId, publicKey: made.cosePublicKey, signCount: 0 },
    ]);
    for (let i = 0; i < 50 && statements.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statements).toEqual([
      { token: TOKEN, sql: expect.stringContaining("identity.touch_current_session()") },
    ]);
  });

  it("an origin that gives no rpId (an IP) is 503 before the port", async () => {
    await start("http://127.0.0.1:3000");
    const original = console.error;
    console.error = () => undefined;
    try {
      expect((await post("challenge", { purpose: "assertion" })).status).toBe(503);
    } finally {
      console.error = original;
    }
    expect(port.list).toEqual([]);
  });
});
