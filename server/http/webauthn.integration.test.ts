// DAN-840-3c (contract Ductus#1836 c.6940962622): POST
// /api/v1/auth/webauthn/challenge on a real server with the real pipeline, a
// fake WebAuthnCredentials port and a real challenge store. The vectors'
// cookies are not tokens, so a valid invented token stands in for them (as in
// profile-interface-locale.integration.test.ts). No refusal calls issue or
// spoils a challenge already issued. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebAuthnCredentials, WebAuthnListOutcome } from "../database/index.ts";
import { challengeSessionKey, createChallengeStore, sessionTag } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createWebAuthnRoutes, webauthnRpId } from "./webauthn.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/auth.webauthn-challenge.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "Izmisljeni_token-izazova_webauthn_000000001";
const OTHER = "Izmisljeni_token-izazova_webauthn_000000002";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const PATH = "/api/v1/auth/webauthn/challenge";
const KEY_ID = Buffer.from("lhCUskcQNi2uECPPWzNFXg", "base64url");
const KEY = { credentialId: KEY_ID, publicKey: Buffer.from([1]), signCount: 0 };

let server: Running | undefined;
let store = createChallengeStore({ now: () => 0, ttlMs: 60_000 });
const calls = { list: [] as string[], issue: 0 };
let listAnswer: () => Promise<WebAuthnListOutcome>;

async function start(
  list: () => Promise<WebAuthnListOutcome> = async () => ({ status: "listed", credentials: [KEY] }),
  {
    origin = ORIGIN,
    now = () => 0,
    fill = () => 7,
  }: { origin?: string | null; now?: () => number; fill?: () => number } = {},
) {
  listAnswer = list;
  store = createChallengeStore({ now, ttlMs: 60_000, randomBytes: (n) => Buffer.alloc(n, fill()) });
  const challenges = {
    issue: (...args: Parameters<typeof store.issue>) => {
      calls.issue += 1;
      return store.issue(...args);
    },
    take: store.take,
  };
  const credentials = {
    list: async (token: string) => {
      calls.list.push(token);
      return listAnswer();
    },
  } as unknown as WebAuthnCredentials;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createWebAuthnRoutes({
      credentials,
      challenges,
      origin,
      timeoutMs: 60_000,
      randomBytes: (n) => Buffer.alloc(n, 9),
      bodyTimeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  calls.list.length = 0;
  calls.issue = 0;
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = (): Answer => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      return { status: Number(head.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n") };
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const got = finish();
      if (
        text.includes("\r\n\r\n") &&
        Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)
      ) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}
function raw(headers: [string, string][], body?: string | Buffer): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  if (body !== undefined && !all.some(([k]) => k.toLowerCase() === "content-length"))
    all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${PATH} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body ?? "")]);
}
const headers = (cookie = COOKIE, type = "application/json"): [string, string][] => [
  ["origin", ORIGIN],
  ["sec-fetch-site", "same-origin"],
  ["content-type", type],
  ["cookie", cookie],
];
const post = (body: string | Buffer, h = headers()) => send(raw(h, body));
const codeOf = (got: Answer) => (JSON.parse(got.body) as { code: string }).code;
const take = (purpose: string, challenge: string, token = TOKEN) =>
  store.take(challengeSessionKey(token), purpose, challenge);

describe("every vector a socket can reach", () => {
  // A short body under a longer Content-Length is a wait (408) or a gone client on a real socket.
  const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
  it.each(VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (name, v) => {
      await start(
        name === "unavailable"
          ? async () => ({ status: "unavailable", reason: "list_malformed" })
          : undefined,
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const h = Object.entries(v.request.headers ?? {}).map(
        ([k, val]) => [k, k === "cookie" ? COOKIE : val] as [string, string],
      );
      const got = await send(raw(h, v.request.rawBody ?? JSON.stringify(v.request.body)));
      expect(got.status).toBe(v.response.status);
      expect(calls.issue).toBe(got.status === 200 ? 1 : 0);
      if (name === "content-length-invalid") return; // Node's parser answers -1 itself.
      expect(got.head["cache-control"]).toBe("no-store");
      expect(got.head["set-cookie"]).toBeUndefined();
      const body = JSON.parse(got.body) as Record<string, unknown>;
      if (got.status === 200) expect(body).toEqual(v.response.body);
      else expect(body).toMatchObject(v.response.body);
    },
  );
});

describe("refusals", () => {
  const good = JSON.stringify({ purpose: "assertion" });

  it.each([
    ["no cookie", headers("other=1"), good, 401],
    ["two content types", [...headers(), ["content-type", "application/json"]], good, 415],
    ["a BOM", headers(), `﻿${good}`, 400],
    ["invalid UTF-8", headers(), Buffer.from([0x7b, 0xff, 0x7d]), 400],
    ["an unknown purpose", headers(), '{"purpose":"login"}', 422],
    ["an extra field", headers(), '{"purpose":"assertion","x":1}', 422],
    ["an own __proto__", headers(), '{"purpose":"assertion","__proto__":{"x":1}}', 422],
    ["a purpose with CRLF", headers(), '{"purpose":"assertion\\r\\n"}', 422],
    ["a purpose with a tab", headers(), '{"purpose":"assertion\\t"}', 422],
    ["a purpose with NBSP", headers(), '{"purpose":"assertion\\u00a0"}', 422],
    ["a purpose with DEL", headers(), '{"purpose":"assertion\\u007f"}', 422],
    ["an array", headers(), "[]", 422],
    ["null", headers(), "null", 422],
  ] as [string, [string, string][], string | Buffer, number][])(
    "%s: %s before the port, and a live challenge stays",
    async (_name, h, body, status) => {
      await start();
      const live = store.issue(challengeSessionKey(TOKEN), "assertion")!;
      expect((await post(body, h)).status).toBe(status);
      expect(calls).toEqual({ list: [], issue: 0 });
      expect(take("assertion", live.challenge)).toBe("ok");
    },
  );

  it("a session this browser ended reads as no cookie: 401 before the port", async () => {
    await start();
    const got = await post(
      '{"purpose":"assertion"}',
      headers(`${COOKIE}; ductus-ended-${sessionTag(TOKEN)!}=1`),
    );
    expect(got.status).toBe(401);
    expect(calls).toEqual({ list: [], issue: 0 });
  });

  it("an origin that gives no rpId: 503 before the port", async () => {
    await start(undefined, { origin: "http://127.0.0.1:3000" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const got = await post('{"purpose":"registration"}');
    expect([got.status, codeOf(got)]).toEqual([503, "unavailable"]);
    expect(calls).toEqual({ list: [], issue: 0 });
    expect(error).toHaveBeenCalledOnce();
  });

  it.each([
    ["unauthenticated", async () => ({ status: "unauthenticated" }) as const, 401],
    [
      "unavailable",
      async () => ({ status: "unavailable", reason: "list_malformed" }) as const,
      503,
    ],
    ["a thrown error", () => Promise.reject(new Error(`boom ${TOKEN}`)), 503],
    [
      "17 keys",
      async () =>
        ({ status: "listed", credentials: Array.from({ length: 17 }, () => KEY) }) as const,
      503,
    ],
  ] as [string, () => Promise<WebAuthnListOutcome>, number][])(
    "%s from the port: %s, no challenge, the token never logged",
    async (_name, list, status) => {
      await start(list);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const got = await post('{"purpose":"assertion"}');
      expect(got.status).toBe(status);
      expect(calls).toEqual({ list: [TOKEN], issue: 0 });
      expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
      if (status === 503) expect(error).toHaveBeenCalledOnce();
    },
  );

  it("a clock that throws: 503", async () => {
    await start(undefined, {
      now: () => {
        throw new Error("clock");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await post('{"purpose":"registration"}')).status).toBe(503);
  });
});

describe("issued challenges", () => {
  it("a registration challenge is this session's, for registration, once", async () => {
    await start(async () => ({
      status: "listed",
      credentials: Array.from({ length: 17 }, () => KEY),
    }));
    const got = await post('{"purpose":"registration"}');
    expect(got.status).toBe(200);
    const body = JSON.parse(got.body) as { challenge: string; userHandle: string };
    expect(body.userHandle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(take("registration", body.challenge, OTHER)).toBe("invalid");
    expect(take("assertion", body.challenge)).toBe("invalid");
    expect(take("registration", body.challenge)).toBe("ok");
    expect(take("registration", body.challenge)).toBe("invalid");
  });

  it("an assertion challenge lists the keys in order; none gives an empty list", async () => {
    const second = { ...KEY, credentialId: Buffer.from([0xa2]) };
    await start(async () => ({ status: "listed", credentials: [KEY, second] }));
    const got = JSON.parse((await post('{"purpose":"assertion"}')).body) as {
      allowCredentials: string[];
    };
    expect(got.allowCredentials).toEqual(["lhCUskcQNi2uECPPWzNFXg", "og"]);
    listAnswer = async () => ({ status: "listed", credentials: [] });
    const none = JSON.parse((await post('{"purpose":"assertion"}')).body) as {
      allowCredentials: string[];
    };
    expect(none.allowCredentials).toEqual([]);
  });

  it("the last issue after list wins, not the last request", async () => {
    let release = () => {};
    let held = true;
    let byte = 0;
    await start(
      async () => {
        if (held) {
          held = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return { status: "listed", credentials: [] };
      },
      { fill: () => ++byte },
    );
    const slow = post('{"purpose":"registration"}');
    while (calls.list.length < 1) await new Promise((r) => setTimeout(r, 5));
    const fast = JSON.parse((await post('{"purpose":"registration"}')).body) as {
      challenge: string;
    };
    release();
    const late = JSON.parse((await slow).body) as { challenge: string };
    // A take spends the entry even on a mismatch, so only the winner is taken.
    expect(late.challenge).not.toBe(fast.challenge);
    expect(take("registration", late.challenge)).toBe("ok");
  });
});

describe("webauthnRpId", () => {
  it.each([
    ["https://x.example:8443", "x.example"],
    ["http://localhost:3000", "localhost"],
    ["http://127.0.0.1:3000", null],
    ["http://[::1]:3000", null],
    ["https://127.0.0.1", null],
    ["https://[::1]", null],
    ["http://x.example", null],
    ["not a url", null],
    [null, null],
  ])("%s gives %s", (origin, rpId) => {
    expect(webauthnRpId(origin)).toBe(rpId);
  });
});
