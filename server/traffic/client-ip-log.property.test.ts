// DAN-831-1: whatever clientIpOf writes passes the `ip` field of the log
// catalogue unchanged, so a traffic record is never refused for its address.
// Documentation ranges only: 192.0.2.0/24, 203.0.113.0/24 and 2001:db8::/32.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { checkEvent } from "../log/index.ts";

import { NO_TRUSTED_PROXIES, resolveClientIp } from "./client-ip.ts";

// Zero words are frequent, so runs of zeros of every length and position occur.
const word = fc.oneof(fc.constant(0), fc.constant(0xffff), fc.integer({ min: 0, max: 0xffff }));
const v6 = fc.array(word, { minLength: 6, maxLength: 6 }).map((rest) => [0x2001, 0xdb8, ...rest]);
const octet = fc.integer({ min: 0, max: 255 });
const v4 = fc.tuple(fc.constantFrom("192.0.2", "203.0.113"), octet).map(([n, o]) => `${n}.${o}`);
// Any valid spelling the socket might report: padded, upper case, uncompressed or mapped.
const remote = fc.oneof(
  v4,
  v4.map((ip) => `::ffff:${ip}`),
  fc.tuple(v6, fc.boolean(), fc.boolean()).map(([ws, pad, upper]) =>
    ws
      .map((w) => w.toString(16).padStart(pad ? 4 : 1, "0"))
      .join(":")
      [upper ? "toUpperCase" : "toLowerCase"](),
  ),
);

const recordWith = (ip: string) => ({
  time: "2026-11-16T09:30:00.000Z",
  event: "traffic.request",
  requestId: "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192",
  accountKind: "anonymous",
  fields: {
    ...{ method: "GET", route: "none", status: 200, durationMs: 3, ip },
    ...{ ipRule: "not_checked", rateLimit: "allowed" },
  },
});

describe("client IP in the traffic record", () => {
  it("passes the catalogue for every address clientIpOf can write", () => {
    fc.assert(
      fc.property(remote, (address) => {
        const ip = resolveClientIp(address, undefined, NO_TRUSTED_PROXIES);
        expect(ip).not.toBeNull();
        expect(checkEvent(recordWith(ip ?? "")), `${address} → ${ip}`).toMatchObject({ ok: true });
      }),
      { numRuns: 2000 },
    );
  });
});
