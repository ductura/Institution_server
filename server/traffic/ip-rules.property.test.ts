// Properties of the IP rules (S-1C.2, DAN-832-1): the decision is the numeric
// comparison of the address with the range. Synthetic addresses only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { networkAllows, parseAllowedNetworks } from "./ip-rules.ts";

const octet = fc.integer({ min: 0, max: 255 });
const word = fc.integer({ min: 0, max: 0xffff });

describe("networkAllows", () => {
  it("an IPv4 address is allowed exactly when its top prefix bits equal the network's", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 32 }), octet, octet, (prefix, a, b) => {
        const net = ((198 << 24) | (51 << 16) | (a << 8)) >>> 0;
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        const base = (net & mask) >>> 0;
        const text = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join(".");
        const networks = parseAllowedNetworks(`${text(base)}/${prefix}`) ?? [];
        const ip = ((198 << 24) | (51 << 16) | (b << 8) | a) >>> 0;
        const inside = (ip & mask) >>> 0 === base;
        expect(networkAllows(networks, text(ip))).toBe(inside);
        expect(networkAllows(networks, `::ffff:${text(ip)}`)).toBe(inside);
      }),
    );
  });

  it("an IPv6 address in 2001:db8::/32 is allowed and one outside it is not", () => {
    const networks = parseAllowedNetworks("2001:db8::/32") ?? [];
    fc.assert(
      fc.property(fc.array(word, { minLength: 6, maxLength: 6 }), word, (rest, second) => {
        const ip = (head: number) => [0x2001, head, ...rest].map((w) => w.toString(16)).join(":");
        expect(networkAllows(networks, ip(0xdb8))).toBe(true);
        expect(networkAllows(networks, ip(second))).toBe(second === 0xdb8);
      }),
    );
  });
});
