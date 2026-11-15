// Properties of the client IP rule (S-1C.1, DAN-790). Addresses come from the
// documentation ranges only: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
// and 2001:db8::/32.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseTrustedProxies, resolveClientIp, type TrustedProxies } from "./client-ip.ts";

const trust = (text: string): TrustedProxies => parseTrustedProxies(text) ?? [];
// 192.0.2.0/24 and 2001:db8:1::/48 are proxies; 203.0.113.0/24 and
// 2001:db8:2::/48 are clients.
const PROXIES = trust("192.0.2.0/24, 2001:db8:1::/48");

const octet = fc.integer({ min: 0, max: 255 });
const word = fc.integer({ min: 0, max: 0xffff });
const proxy4 = octet.map((o) => `192.0.2.${o}`);
const client4 = octet.map((o) => `203.0.113.${o}`);
const words = (prefix: number[]) =>
  fc
    .array(word, { minLength: 8 - prefix.length, maxLength: 8 - prefix.length })
    .map((rest) => [...prefix, ...rest]);
const proxy6 = words([0x2001, 0xdb8, 1]);
const client6 = words([0x2001, 0xdb8, 2]);

/** One IPv6 address as eight words, written in any valid spelling. */
function spell(ws: number[], style: { upper: boolean; pad: boolean; compress: boolean }): string {
  const hex = ws.map((w) => {
    const h = w.toString(16).padStart(style.pad ? 4 : 1, "0");
    return style.upper ? h.toUpperCase() : h;
  });
  if (!style.compress) return hex.join(":");
  const zero = ws.indexOf(0);
  if (zero < 0) return hex.join(":");
  let end = zero;
  while (end < 8 && ws[end] === 0) end += 1;
  return `${hex.slice(0, zero).join(":")}::${hex.slice(end).join(":")}`;
}
const styles = fc.record({ upper: fc.boolean(), pad: fc.boolean(), compress: fc.boolean() });
const anyProxy = fc.oneof(
  proxy4,
  proxy4.map((a) => `::ffff:${a}`),
  fc.tuple(proxy6, styles).map(([w, s]) => spell(w, s)),
);
const anyClient = fc.oneof(
  client4,
  client4.map((a) => `::ffff:${a}`),
  fc.tuple(client6, styles).map(([w, s]) => spell(w, s)),
);
const junk = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom("unknown", "_hidden", "[", "]:", "::%", "1.2.3", " , ", ","),
);
const leftovers = fc.array(fc.oneof(anyClient, anyProxy, junk), { maxLength: 8 });

describe("client IP properties", () => {
  it("an untrusted peer is the client whatever the header says", () => {
    fc.assert(
      fc.property(anyClient, fc.option(fc.string({ maxLength: 300 })), (peer, header) => {
        const plain = resolveClientIp(peer, undefined, PROXIES);
        expect(resolveClientIp(peer, header ?? undefined, PROXIES)).toBe(plain);
        expect(plain).not.toBeNull();
      }),
    );
  });

  it("an empty list never reads the header", () => {
    fc.assert(
      fc.property(anyProxy, fc.string({ maxLength: 300 }), (peer, header) => {
        expect(resolveClientIp(peer, header, [])).toBe(resolveClientIp(peer, undefined, []));
      }),
    );
  });

  it("nothing left of the first untrusted address moves the choice", () => {
    fc.assert(
      fc.property(
        anyProxy,
        leftovers,
        anyClient,
        fc.array(anyProxy, { maxLength: 6 }),
        (peer, left, client, hops) => {
          const expected = resolveClientIp(client, undefined, PROXIES);
          const header = [...left, client, ...hops].join(",");
          expect(resolveClientIp(peer, header, PROXIES)).toBe(expected);
        },
      ),
    );
  });

  it("every spelling of an address gives the same result and trust", () => {
    fc.assert(
      fc.property(fc.oneof(proxy6, client6), styles, styles, (ws, a, b) => {
        const one = resolveClientIp("192.0.2.1", `203.0.113.1, ${spell(ws, a)}`, PROXIES);
        const two = resolveClientIp("192.0.2.1", `203.0.113.1, ${spell(ws, b)}`, PROXIES);
        expect(one).toBe(two);
        expect(one === "203.0.113.1").toBe(ws[2] === 1);
      }),
    );
    fc.assert(
      fc.property(octet, (o) => {
        const plain = resolveClientIp("192.0.2.1", `192.0.2.${o}`, PROXIES);
        expect(resolveClientIp("192.0.2.1", `::ffff:192.0.2.${o}`, PROXIES)).toBe(plain);
        const hex = `::ffff:c000:2${o.toString(16).padStart(2, "0")}`;
        expect(resolveClientIp("192.0.2.1", hex, PROXIES)).toBe(plain);
      }),
    );
  });

  it("CIDR membership matches a reference check on numbers", () => {
    const toNumber = (ws: number[]) => ws.reduce((acc, w) => (acc << 16n) | BigInt(w), 0n);
    fc.assert(
      fc.property(
        words([0x2001, 0xdb8]),
        words([0x2001, 0xdb8]),
        fc.integer({ min: 32, max: 128 }),
        (net, ip, prefix) => {
          const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
          const base = toNumber(net) & mask;
          const baseWords = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) =>
            Number((base >> s) & 0xffffn),
          );
          const list = parseTrustedProxies(
            `${spell(baseWords, { upper: false, pad: false, compress: true })}/${prefix}`,
          );
          expect(list).not.toBeNull();
          const inside = (toNumber(ip) & mask) === base;
          const address = spell(ip, { upper: false, pad: true, compress: false });
          // A trusted peer reads the header; an untrusted one keeps itself.
          const out = resolveClientIp(address, "203.0.113.9", list ?? []);
          expect(out === "203.0.113.9").toBe(inside);
        },
      ),
    );
  });

  it("never throws on any input", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 60 })),
        fc.option(fc.oneof(fc.string({ maxLength: 400 }), fc.array(fc.string(), { maxLength: 4 }))),
        fc.string({ maxLength: 120 }),
        (peer, header, list) => {
          parseTrustedProxies(list);
          resolveClientIp(peer ?? undefined, header ?? undefined, PROXIES);
        },
      ),
    );
  });
});
