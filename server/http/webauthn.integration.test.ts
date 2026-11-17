// DAN-840-3c (contract Ductus#1836 c.6940962622): POST
// /api/v1/auth/webauthn/challenge on a real server with the real pipeline, a
// fake WebAuthnCredentials port and a real challenge store. The vectors'
// cookies are not tokens, so a valid invented token stands in for them (as in
// profile-interface-locale.integration.test.ts). No refusal calls issue or
// spoils a challenge already issued. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { createSoftwareAuthenticator } from "@ductura/test-fakes/fido2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WebAuthnAddOutcome,
  WebAuthnCredential,
  WebAuthnCredentials,
  WebAuthnListOutcome,
} from "../database/index.ts";
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
const reg = {
  add: [] as [string, WebAuthnCredential][],
  activity: [] as boolean[],
  answer: async (): Promise<WebAuthnAddOutcome> => ({ status: "added" }),
  activityAnswer: (): Promise<unknown> => Promise.resolve(),
};
let clock = 0;
let listAnswer: () => Promise<WebAuthnListOutcome>;

async function start(
  list: () => Promise<WebAuthnListOutcome> = async () => ({ status: "listed", credentials: [KEY] }),
  {
    origin = ORIGIN,
    now = () => clock,
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
    add: async (token: string, credential: WebAuthnCredential) => {
      reg.add.push([token, credential]);
      return reg.answer();
    },
  } as unknown as WebAuthnCredentials;
  let current: { writableEnded: boolean } | undefined;
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
      recordActivity: (token) => {
        expect(token).toBe(TOKEN);
        reg.activity.push(current?.writableEnded ?? false);
        return reg.activityAnswer();
      },
    }).map((route) => ({
      ...route,
      handle: (request, response) => {
        current = response;
        return route.handle(request, response);
      },
    })),
  });
}
afterEach(async () => {
  calls.list.length = 0;
  calls.issue = 0;
  reg.add.length = 0;
  reg.activity.length = 0;
  reg.answer = async () => ({ status: "added" });
  reg.activityAnswer = () => Promise.resolve();
  clock = 0;
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
function raw(headers: [string, string][], body?: string | Buffer, path = PATH): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  if (body !== undefined && !all.some(([k]) => k.toLowerCase() === "content-length"))
    all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
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
/** The JSON lines a spy on console.error saw (QA on #215: each fault names its closed reason). */
const records = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
const fault = (route: string, reason: string) => ({
  event: "webauthn_fault",
  route,
  reason,
  requestId: expect.any(String),
});
const thrown = (route: string) => ({
  event: "server_error",
  where: "route",
  errorClass: "other",
  requestId: expect.any(String),
  route,
});
const CHALLENGE_ROUTE = "auth.webauthn-challenge.post";
const REGISTRATION_ROUTE = "auth.webauthn-registration.post";
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
    expect(records(error)).toEqual([fault(CHALLENGE_ROUTE, "no_rp_id")]);
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
      "an unknown reason",
      async () => ({ status: "unavailable", reason: `x ${TOKEN}` }) as const,
      503,
    ],
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
      const expected: Record<string, unknown[]> = {
        unavailable: [fault(CHALLENGE_ROUTE, "list_malformed")],
        "a thrown error": [thrown(CHALLENGE_ROUTE)],
        "17 keys": [fault(CHALLENGE_ROUTE, "too_many_credentials")],
        "an unknown reason": [fault(CHALLENGE_ROUTE, "unknown")],
      };
      expect(records(error)).toEqual(expected[_name] ?? []);
    },
  );

  it("a clock that throws: 503", async () => {
    await start(undefined, {
      now: () => {
        throw new Error("clock");
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await post('{"purpose":"registration"}')).status).toBe(503);
    expect(records(error)).toEqual([fault(CHALLENGE_ROUTE, "clock")]);
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

// DAN-840-3d (contract Ductus#1836 c.6941302150): the registration route.
const REG_PATH = "/api/v1/auth/webauthn/registration";
const REG_VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/auth.webauthn-registration.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const REGISTERED = REG_VECTORS.find((v) => v.name === "registered")!.request.body as Record<
  string,
  string
>;
const register = (body: unknown, h = headers()) =>
  send(raw(h, typeof body === "string" ? body : JSON.stringify(body), REG_PATH));
const empty = async (): Promise<WebAuthnListOutcome> => ({ status: "listed", credentials: [] });

describe("registration vectors", () => {
  const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
  const BEFORE_CEREMONY = new Set([401, 403, 408, 413, 415, 422]);
  it.each(REG_VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (name, v) => {
      const byte = name === "client-data-origin-mismatch" ? 3 : 1;
      await start(empty, { fill: () => byte });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      if (name === "already-has-key") reg.answer = async () => ({ status: "forbidden" });
      if (name === "credential-registered") reg.answer = async () => ({ status: "conflict" });
      if (name === "unavailable")
        reg.answer = async () => ({ status: "unavailable", reason: "add_malformed" });
      const challenge = store.issue(challengeSessionKey(TOKEN), "registration")!.challenge;
      const h = Object.entries(v.request.headers ?? {}).map(
        ([k, val]) => [k, k === "cookie" ? COOKIE : val] as [string, string],
      );
      const body = v.request.rawBody ?? JSON.stringify(v.request.body);
      if (name === "challenge-replayed")
        expect((await send(raw(h, body, REG_PATH))).status).toBe(204);
      if (name === "challenge-expired") clock = 60_000;
      const got = await send(raw(h, body, REG_PATH));
      expect(got.status).toBe(v.response.status);
      if (got.status === 204) {
        expect(got.body).toBe("");
        expect(got.head["content-type"]).toBeUndefined();
      } else if (name !== "content-length-invalid") {
        expect(JSON.parse(got.body)).toMatchObject(v.response.body);
      }
      if (name !== "content-length-invalid") {
        expect(got.head["cache-control"]).toBe("no-store");
        expect(got.head["set-cookie"]).toBeUndefined();
      }
      // A refusal before the ceremony leaves the challenge.
      if (reg.add.length === 0 && BEFORE_CEREMONY.has(got.status))
        expect(store.take(challengeSessionKey(TOKEN), "registration", challenge)).toBe("ok");
    },
  );
});

describe("registration with the software authenticator", () => {
  const authenticator = (origin = ORIGIN) =>
    createSoftwareAuthenticator({ rpId: "ductura.example.invalid", origin });
  const bodyOf = (r: {
    clientDataJSON: Buffer;
    authenticatorData: Buffer;
    credentialId: Buffer;
  }) => ({
    clientDataJSON: r.clientDataJSON.toString("base64url"),
    authenticatorData: r.authenticatorData.toString("base64url"),
    credentialId: r.credentialId.toString("base64url"),
  });
  const challengeOf = async () => {
    const got = await post('{"purpose":"registration"}');
    return Buffer.from((JSON.parse(got.body) as { challenge: string }).challenge, "base64url");
  };

  it("registers the key from authenticatorData, then records activity after the answer", async () => {
    await start(empty);
    const made = authenticator().register(await challengeOf());
    const got = await register(bodyOf(made));
    expect([got.status, got.body, got.head["content-type"]]).toEqual([204, "", undefined]);
    expect(got.head["cache-control"]).toBe("no-store");
    expect(reg.add).toEqual([
      [TOKEN, { credentialId: made.credentialId, publicKey: made.cosePublicKey, signCount: 0 }],
    ]);
    await vi.waitFor(() => expect(reg.activity).toEqual([true]));
  });

  it.each([
    ["a rejected", () => Promise.reject(new Error("touch"))],
    [
      "a thrown",
      () => {
        throw new Error("touch");
      },
    ],
  ])("%s activity record does not change the 204", async (_name, activity) => {
    await start(empty);
    reg.activityAnswer = activity as () => Promise<unknown>;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const got = await register(bodyOf(authenticator().register(await challengeOf())));
    expect(got.status).toBe(204);
    await vi.waitFor(() => expect(reg.activity).toEqual([true]));
    expect(error).not.toHaveBeenCalled();
  });

  it("another session's or purpose's challenge is refused and theirs stays", async () => {
    await start(empty, { fill: () => 1 });
    const other = store.issue(challengeSessionKey(OTHER), "registration")!.challenge;
    const assertion = store.issue(challengeSessionKey(TOKEN), "assertion")!.challenge;
    const got = await register(REGISTERED);
    expect([got.status, codeOf(got)]).toEqual([400, "challenge_invalid"]);
    expect(store.take(challengeSessionKey(OTHER), "registration", other)).toBe("ok");
    expect(store.take(challengeSessionKey(TOKEN), "assertion", assertion)).toBe("ok");
    expect(reg.add).toEqual([]);
  });

  it("unreadable client data spends the challenge: ceremony_invalid, then challenge_invalid", async () => {
    await start(empty, { fill: () => 1 });
    store.issue(challengeSessionKey(TOKEN), "registration");
    const bad = await register({
      ...REGISTERED,
      clientDataJSON: Buffer.from([0xff]).toString("base64url"),
    });
    expect([bad.status, codeOf(bad)]).toEqual([400, "ceremony_invalid"]);
    const late = await register(REGISTERED);
    expect([late.status, codeOf(late)]).toEqual([400, "challenge_invalid"]);
  });

  it("a wrong origin and an id one byte off are ceremony_invalid, without the port", async () => {
    await start(empty);
    const foreign = authenticator("https://drugo.example.invalid").register(await challengeOf());
    const wrong = await register(bodyOf(foreign));
    expect([wrong.status, codeOf(wrong)]).toEqual([400, "ceremony_invalid"]);
    const made = authenticator().register(await challengeOf());
    const id = Buffer.from(made.credentialId);
    id[0] = (id[0] ?? 0) ^ 1;
    const off = await register({ ...bodyOf(made), credentialId: id.toString("base64url") });
    expect([off.status, codeOf(off)]).toEqual([400, "ceremony_invalid"]);
    expect(reg.add).toEqual([]);
  });

  it("without rpId: 503 before the ceremony, the challenge stays", async () => {
    await start(empty, { origin: null, fill: () => 1 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const live = store.issue(challengeSessionKey(TOKEN), "registration")!.challenge;
    expect((await register(REGISTERED)).status).toBe(503);
    expect(store.take(challengeSessionKey(TOKEN), "registration", live)).toBe("ok");
    expect(records(error)).toEqual([fault(REGISTRATION_ROUTE, "no_rp_id")]);
  });

  it.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["conflict", 409],
    ["invalid", 503],
    ["unavailable", 503],
    ["thrown", 503],
  ] as const)("the port's %s is %s, without activity", async (status, code) => {
    await start(empty, { fill: () => 1 });
    store.issue(challengeSessionKey(TOKEN), "registration");
    reg.answer =
      status === "thrown"
        ? () => Promise.reject(new Error(`boom ${TOKEN}`))
        : async () =>
            (status === "unavailable"
              ? { status, reason: "add_malformed" }
              : { status }) as WebAuthnAddOutcome;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await register(REGISTERED)).status).toBe(code);
    expect(reg.activity).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
    const expected: Record<string, unknown[]> = {
      invalid: [fault(REGISTRATION_ROUTE, "add_invalid")],
      unavailable: [fault(REGISTRATION_ROUTE, "add_malformed")],
      thrown: [thrown(REGISTRATION_ROUTE)],
    };
    expect(records(error)).toEqual(expected[status] ?? []);
  });
});

describe("registration body validation", () => {
  const cut = (field: string) => {
    const copy: Record<string, unknown> = { ...REGISTERED };
    delete copy[field];
    return copy;
  };
  it.each([
    ["CRLF", { ...REGISTERED, credentialId: `${REGISTERED.credentialId}\r\n` }],
    ["a tab", { ...REGISTERED, credentialId: `${REGISTERED.credentialId}\t` }],
    ["NBSP", { ...REGISTERED, credentialId: `${REGISTERED.credentialId} ` }],
    ["DEL", { ...REGISTERED, credentialId: `${REGISTERED.credentialId}\u007f` }],
    ["padding", { ...REGISTERED, credentialId: `${REGISTERED.credentialId}==` }],
    ["one character", { ...REGISTERED, credentialId: "A" }],
    ["a stray character", { ...REGISTERED, clientDataJSON: `${REGISTERED.clientDataJSON}Q` }],
    ["stray trailing bits", { ...REGISTERED, credentialId: "lhCUskcQNi2uECPPWzNFXh" }],
    ["an empty field", { ...REGISTERED, credentialId: "" }],
    ["a missing field", cut("credentialId")],
    ["null", { ...REGISTERED, credentialId: null }],
    ["a number", { ...REGISTERED, credentialId: 1 }],
    ["an array", { ...REGISTERED, credentialId: [REGISTERED.credentialId] }],
    ["2049 characters", { ...REGISTERED, clientDataJSON: "A".repeat(2049) }],
    ["1365 characters", { ...REGISTERED, credentialId: "A".repeat(1365) }],
    ["an extra field", { ...REGISTERED, extra: "x" }],
  ])("%s: 422, the challenge stays", async (_name, body) => {
    await start(empty, { fill: () => 1 });
    const live = store.issue(challengeSessionKey(TOKEN), "registration")!.challenge;
    const got = await register(body);
    expect([got.status, codeOf(got)]).toEqual([422, "invalid_input"]);
    expect(store.take(challengeSessionKey(TOKEN), "registration", live)).toBe("ok");
  });

  it("an own __proto__: 422", async () => {
    await start(empty, { fill: () => 1 });
    const text = JSON.stringify(REGISTERED).replace("{", '{"__proto__":{"x":1},');
    expect((await register(text)).status).toBe(422);
  });
});
