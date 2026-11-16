// Properties of the token buckets with a fake clock (S-1C.3, DAN-814; attack
// plan ductura/server#117 N6, N8, N9). Addresses are from the documentation
// ranges; cookies are invented.
import type { IncomingMessage } from "node:http";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { clientIpLayer } from "./client-ip.ts";
import { createRateLimiter, type RateLimits } from "./rate-limit.ts";

const COOKIE = "__Host-test_session";

async function request(ip: number, account: number | null): Promise<IncomingMessage> {
  const message = {
    method: "GET",
    url: "/api/v1/student/assignments",
    headers: account === null ? {} : { cookie: `${COOKIE}=acct-${account}` },
    socket: { remoteAddress: `203.0.113.${ip}` },
  } as unknown as IncomingMessage;
  await clientIpLayer([])(message);
  return message;
}

const limitsWith = (perIp: number, perAccount: number): RateLimits => ({
  login: { perIp, perAccount: null },
  enroll: { perIp, perAccount },
  save: { perIp, perAccount },
  default: { perIp, perAccount },
});

type Step = { readonly wait: number; readonly ip: number; readonly account: number | null };
const step = fc.record({
  wait: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 0, max: 5_000 }),
    fc.integer({ min: 0, max: 120_000 }),
  ),
  ip: fc.integer({ min: 0, max: 2 }),
  account: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
});
const limit = fc.integer({ min: 1, max: 40 });

/** Runs the steps; true for each allowed request. */
async function replay(perIp: number, perAccount: number, steps: readonly Step[]) {
  let now = 0;
  const rl = createRateLimiter({
    limits: limitsWith(perIp, perAccount),
    now: () => now,
    cookieName: COOKIE,
  });
  const out: { at: number; allowed: boolean; retryAfter: number }[] = [];
  for (const s of steps) {
    now += s.wait;
    const decision = rl.check(await request(s.ip, s.account));
    out.push({
      at: now,
      allowed: decision.allowed,
      retryAfter: decision.allowed ? 0 : decision.retryAfter,
    });
  }
  return out;
}

describe("rate limit properties", () => {
  it("one address never passes more than its limit plus the refill of a window", async () => {
    await fc.assert(
      fc.asyncProperty(
        limit,
        fc.array(fc.integer({ min: 0, max: 20_000 }), { maxLength: 120 }),
        async (perIp, waits) => {
          const out = await replay(
            perIp,
            40,
            waits.map((wait) => ({ wait, ip: 1, account: null })),
          );
          for (let i = 0; i < out.length; i += 1) {
            for (let j = i; j < out.length; j += 1) {
              const window = (out[j]?.at ?? 0) - (out[i]?.at ?? 0);
              const passed = out.slice(i, j + 1).filter((o) => o.allowed).length;
              expect(passed).toBeLessThanOrEqual(perIp + Math.floor((window * perIp) / 60_000));
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a refused request changes nothing: without the refused ones the rest decide the same (N6)", async () => {
    await fc.assert(
      fc.asyncProperty(
        limit,
        limit,
        fc.array(step, { maxLength: 80 }),
        async (perIp, perAccount, steps) => {
          const first = await replay(perIp, perAccount, steps);
          // Keep the time of a dropped step by folding its wait into the next one.
          const kept: Step[] = [];
          let carry = 0;
          steps.forEach((s, i) => {
            if (first[i]?.allowed === true) {
              kept.push({ ...s, wait: s.wait + carry });
              carry = 0;
            } else {
              carry += s.wait;
            }
          });
          const second = await replay(perIp, perAccount, kept);
          expect(second.every((o) => o.allowed)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("Retry-After is a whole number of seconds in 1..60, and after it one request passes (N8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        limit,
        limit,
        fc.array(step, { minLength: 1, maxLength: 80 }),
        async (perIp, perAccount, steps) => {
          const out = await replay(perIp, perAccount, steps);
          const index = out.findLastIndex((o) => !o.allowed);
          if (index < 0) return;
          const refused = out[index]!;
          expect(Number.isInteger(refused.retryAfter)).toBe(true);
          expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
          expect(refused.retryAfter).toBeLessThanOrEqual(60);
          const prefix = steps.slice(0, index + 1);
          const again = { ...steps[index]!, wait: refused.retryAfter * 1000 };
          const after = await replay(perIp, perAccount, [...prefix, again]);
          expect(after.at(-1)?.allowed).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a clock that jumps back and forth never gives more than the refill of its highest time (N9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        limit,
        fc.array(
          fc.oneof(
            fc.integer({ min: -1e9, max: 1e9 }),
            fc.constant(Number.NaN),
            fc.constant(Number.POSITIVE_INFINITY),
          ),
          {
            maxLength: 100,
          },
        ),
        async (perIp, times) => {
          let index = 0;
          const rl = createRateLimiter({
            limits: limitsWith(perIp, 40),
            now: () => times[index] ?? 0,
            cookieName: COOKIE,
          });
          let passed = 0;
          let high = Number.NEGATIVE_INFINITY;
          let low = Number.POSITIVE_INFINITY;
          for (index = 0; index < times.length; index += 1) {
            const t = times[index]!;
            if (Number.isFinite(t)) [high, low] = [Math.max(high, t), Math.min(low, t)];
            if (rl.check(await request(1, null)).allowed) passed += 1;
          }
          const span = Number.isFinite(high) ? high - Math.min(low, 0) : 0;
          expect(passed).toBeLessThanOrEqual(perIp + Math.floor((span * perIp) / 60_000));
        },
      ),
      { numRuns: 150 },
    );
  });
});
