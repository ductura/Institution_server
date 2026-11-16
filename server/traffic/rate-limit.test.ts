// Rate limit rules (S-1C.3, DAN-814; attack plan ductura/server#117, N…).
// Addresses come from the documentation ranges only; cookies are invented.
import type { IncomingMessage } from "node:http";

import { createFakeClock } from "@ductura/test-fakes";
import { describe, expect, it } from "vitest";

import { clientIpLayer, parseTrustedProxies } from "./client-ip.ts";
import {
  checkRateLimits,
  classOf,
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
  type RateLimits,
} from "./rate-limit.ts";

const COOKIE = "__Host-test_session";

/** Reads the test cookie as server/session reads its own: one exact pair. */
function testToken(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  const found = header
    .split(";")
    .map((part) => part.replace(/^[ \t]+/u, ""))
    .filter((pair) => pair.slice(0, pair.indexOf("=")) === COOKIE && pair.includes("="));
  return found.length === 1 ? found[0]?.slice(COOKIE.length + 1) : undefined;
}

type Shape = {
  ip?: string;
  method?: string;
  url?: string;
  cookie?: string;
  forwarded?: string;
  trusted?: string;
};

async function request(shape: Shape = {}): Promise<IncomingMessage> {
  const headers: Record<string, string> = {};
  if (shape.cookie !== undefined) headers.cookie = shape.cookie;
  if (shape.forwarded !== undefined) headers["x-forwarded-for"] = shape.forwarded;
  const message = {
    method: shape.method ?? "GET",
    url: shape.url ?? "/api/v1/student/assignments",
    headers,
    socket: { remoteAddress: shape.ip ?? "203.0.113.7" },
  } as unknown as IncomingMessage;
  await clientIpLayer(parseTrustedProxies(shape.trusted) ?? [])(message);
  return message;
}

const small: RateLimits = {
  login: { perIp: 3, perAccount: null },
  enroll: { perIp: 6, perAccount: 2 },
  save: { perIp: 10, perAccount: 4 },
  default: { perIp: 5, perAccount: 3 },
};

function limiter(limits: RateLimits = small, maxBuckets?: number) {
  const clock = createFakeClock(0);
  const rl = createRateLimiter({
    limits,
    now: clock.nowMs,
    sessionTokenOf: testToken,
    ...(maxBuckets === undefined ? {} : { maxBuckets }),
  });
  return { clock, rl };
}

async function run(rl: ReturnType<typeof limiter>["rl"], shape: Shape, times: number) {
  const out: string[] = [];
  for (let i = 0; i < times; i += 1) {
    const decision = rl.check(await request(shape));
    out.push(decision.allowed ? "ok" : `${decision.bucket}:${decision.retryAfter}`);
  }
  return out;
}

describe("classOf (N11)", () => {
  it.each([
    ["GET", "/api/v1/auth/login", "login"],
    ["GET", "/api/v1/auth/login?return=%2F", "login"],
    ["HEAD", "/api/v1/auth/callback", "login"],
    ["POST", "/api/v1/evidence/commit", "save"],
    ["POST", "/api/v1/evidence/commit?x=1", "save"],
  ])("%s %s is %s", (method, url, expected) => {
    expect(classOf(method, url)).toBe(expected);
  });

  it.each([
    ["GET", "/api/v1/auth/login/"],
    ["GET", "/API/v1/auth/login"],
    ["GET", "//api/v1/auth/login"],
    ["GET", "/api/v1/auth%2Flogin"],
    ["GET", "/api/v1/evidence/commit"],
    ["POST", "/api/v1/evidence/commit/"],
    ["POST", "/api/v1/evidence/open"],
    [undefined, undefined],
  ])("%s %s falls into default, which has a limit too", (method, url) => {
    expect(classOf(method, url)).toBe("default");
  });
});

describe("sessionTokenOf decides the account bucket (N12, self-attack B1)", () => {
  const counted = async (sessionTokenOf: (r: IncomingMessage) => string | null | undefined) => {
    const clock = createFakeClock(0);
    const rl = createRateLimiter({ limits: small, now: clock.nowMs, sessionTokenOf });
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const decision = rl.check(await request({ ip: `203.0.113.${i}` }));
      out.push(decision.allowed ? "ok" : decision.bucket);
    }
    return out;
  };

  it("counts one account across addresses by the token it gives", async () => {
    expect(await counted(() => "same-token")).toEqual(["ok", "ok", "ok", "per_account"]);
  });

  it.each([
    ["null", () => null],
    ["undefined", () => undefined],
    ["an empty token", () => ""],
    [
      "a throw",
      () => {
        throw new Error("x");
      },
    ],
  ])("%s means no account bucket and no throw", async (_name, reader) => {
    expect(await counted(reader)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("is handed the request itself", async () => {
    const seen: IncomingMessage[] = [];
    const rl = createRateLimiter({ limits: small, sessionTokenOf: (r) => (seen.push(r), null) });
    const message = await request({ cookie: `${COOKIE}=a` });
    rl.check(message);
    expect(seen).toEqual([message]);
  });
});

describe("checkRateLimits (N14)", () => {
  it("takes the defaults and the bounds", () => {
    expect(checkRateLimits(DEFAULT_RATE_LIMITS)).toEqual(DEFAULT_RATE_LIMITS);
    expect(checkRateLimits({ ...small, save: { perIp: 100_000, perAccount: 1 } })).not.toBeNull();
  });

  it.each([
    ["zero", { ...small, save: { perIp: 0, perAccount: 4 } }],
    ["above the bound", { ...small, save: { perIp: 100_001, perAccount: 4 } }],
    ["a fraction", { ...small, default: { perIp: 1.5, perAccount: 3 } }],
    ["NaN", { ...small, default: { perIp: Number.NaN, perAccount: 3 } }],
    ["no account limit", { ...small, enroll: { perIp: 6, perAccount: null } }],
    ["a missing class", { login: small.login, enroll: small.enroll, save: small.save }],
  ])("refuses %s", (_name, limits) => {
    expect(checkRateLimits(limits as RateLimits)).toBeNull();
    expect(() =>
      createRateLimiter({ limits: limits as RateLimits, sessionTokenOf: testToken }),
    ).toThrow();
  });
});

describe("createRateLimiter", () => {
  it("lets exactly the limit through, then 429 with Retry-After", async () => {
    const { rl } = limiter();
    expect(await run(rl, {}, 6)).toEqual(["ok", "ok", "ok", "ok", "ok", "per_address:12"]);
  });

  it("refills over a minute; Retry-After is enough for one more", async () => {
    const { rl, clock } = limiter();
    await run(rl, {}, 5);
    const refused = rl.check(await request());
    expect(refused).toMatchObject({ allowed: false, retryAfter: 12 });
    clock.advance(11_999);
    expect((await run(rl, {}, 1))[0]).toBe("per_address:1");
    clock.advance(1);
    expect(await run(rl, {}, 2)).toEqual(["ok", "per_address:12"]);
  });

  it("keeps classes apart: a full default leaves login and save open", async () => {
    const { rl } = limiter();
    await run(rl, {}, 5);
    expect(await run(rl, { url: "/api/v1/auth/login" }, 1)).toEqual(["ok"]);
    expect(await run(rl, { method: "POST", url: "/api/v1/evidence/commit" }, 1)).toEqual(["ok"]);
  });

  it("limits an account on any IP (N4)", async () => {
    const { rl } = limiter();
    const out: string[] = [];
    for (const ip of ["203.0.113.1", "203.0.113.2", "2001:db8::3", "203.0.113.4"]) {
      out.push(...(await run(rl, { ip, cookie: `${COOKIE}=acct-one` }, 1)));
    }
    expect(out).toEqual(["ok", "ok", "ok", "per_account:20"]);
  });

  it("random cookies give an IP no extra room (N3)", async () => {
    const { rl } = limiter();
    const out: string[] = [];
    for (let i = 0; i < 6; i += 1) out.push(...(await run(rl, { cookie: `${COOKIE}=r${i}` }, 1)));
    expect(out).toEqual(["ok", "ok", "ok", "ok", "ok", "per_address:12"]);
  });

  it("an ambiguous cookie counts only per address (N12)", async () => {
    const { rl } = limiter();
    const shape = { cookie: `${COOKIE}=a; ${COOKIE}=b` };
    expect(await run(rl, shape, 6)).toEqual(["ok", "ok", "ok", "ok", "ok", "per_address:12"]);
  });

  it("a refusal per account takes no token per address (N6)", async () => {
    const { rl } = limiter();
    await run(rl, { cookie: `${COOKIE}=acct` }, 3);
    expect(await run(rl, { cookie: `${COOKIE}=acct` }, 5)).toEqual(Array(5).fill("per_account:20"));
    // Two tokens per address are left, untouched by the five refusals.
    expect(await run(rl, {}, 3)).toEqual(["ok", "ok", "per_address:12"]);
  });

  it("Retry-After is the longest wait of all short buckets", async () => {
    const limits: RateLimits = { ...small, default: { perIp: 1, perAccount: 1 } };
    const { rl, clock } = limiter(limits);
    await run(rl, { ip: "203.0.113.2" }, 1);
    clock.advance(19);
    await run(rl, { ip: "203.0.113.1", cookie: `${COOKIE}=acct` }, 1);
    clock.advance(5_981);
    // The address waits 54 s, the account 54.019 s: the answer is 55.
    const shape = { ip: "203.0.113.2", cookie: `${COOKIE}=acct` };
    expect(await run(rl, shape, 1)).toEqual(["per_account:55"]);
    clock.advance(55_000);
    expect(await run(rl, shape, 1)).toEqual(["ok"]);
  });

  it("login has no account bucket", async () => {
    const { rl } = limiter();
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      out.push(...(await run(rl, { url: "/api/v1/auth/login", cookie: `${COOKIE}=x` }, 1)));
    }
    expect(out).toEqual(["ok", "ok", "ok", "per_address:20"]);
  });

  it("a request without a socket address shares one bucket (N10)", async () => {
    const { rl } = limiter();
    const none = async () => {
      const message = {
        method: "GET",
        url: "/x",
        headers: {},
        socket: {},
      } as unknown as IncomingMessage;
      await clientIpLayer([])(message);
      return message;
    };
    const out: boolean[] = [];
    for (let i = 0; i < 6; i += 1) out.push(rl.check(await none()).allowed);
    expect(out).toEqual([true, true, true, true, true, false]);
  });

  it("a forged X-Forwarded-For from a direct peer is not read (N1)", async () => {
    const { rl } = limiter();
    const out: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      out.push(...(await run(rl, { forwarded: `198.51.100.${i}` }, 1)));
    }
    expect(out.at(-1)).toBe("per_address:12");
  });

  it("forged entries left of a trusted proxy's own do not move the bucket (N2)", async () => {
    const { rl } = limiter();
    const out: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      out.push(
        ...(await run(
          rl,
          { ip: "192.0.2.1", trusted: "192.0.2.0/24", forwarded: `198.51.100.${i}, 203.0.113.9` },
          1,
        )),
      );
    }
    expect(out.at(-1)).toBe("per_address:12");
  });

  it("holds at most maxBuckets buckets (N5)", async () => {
    const { rl } = limiter(small, 4);
    for (let i = 0; i < 50; i += 1)
      await run(rl, { ip: `203.0.113.${i}`, cookie: `${COOKIE}=c${i}` }, 1);
    expect(rl.size()).toBe(4);
  });

  it("a refused bucket counts as used and is not pushed out first (self-attack N2)", async () => {
    const { rl } = limiter(small, 3);
    const victim = { ip: "203.0.113.200" };
    await run(rl, victim, 5);
    await run(rl, { ip: "203.0.113.1" }, 1);
    expect(await run(rl, victim, 1)).toEqual(["per_address:12"]);
    await run(rl, { ip: "203.0.113.2" }, 1);
    await run(rl, { ip: "203.0.113.3" }, 1);
    // Without the touch the victim's empty bucket would be the oldest and go.
    expect(await run(rl, victim, 1)).toEqual(["per_address:12"]);
  });

  it("a clock that goes back adds nothing (N9)", async () => {
    let now = 60_000;
    const rl = createRateLimiter({ limits: small, now: () => now, sessionTokenOf: testToken });
    for (let i = 0; i < 5; i += 1) rl.check(await request());
    now = 0;
    expect(rl.check(await request()).allowed).toBe(false);
    now = Number.NaN;
    expect(rl.check(await request()).allowed).toBe(false);
  });

  it("never names an IP, a cookie or its hash in a decision (N16)", async () => {
    const { rl } = limiter();
    const shape = { cookie: `${COOKIE}=secret-value`, ip: "203.0.113.77" };
    await run(rl, shape, 3);
    const text = JSON.stringify(rl.check(await request(shape)));
    expect(text).not.toMatch(/203\.0\.113|secret-value/);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "allowed",
      "bucket",
      "limitClass",
      "retryAfter",
    ]);
  });
});
