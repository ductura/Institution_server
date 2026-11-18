import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { Origin, ORIGIN_MAX_LENGTH } from "./origin.ts";

// DAN-930-1d-a1 (ugovor Ductus#2028): every named value Origin accepts is a
// canonical http(s) origin, every named value outside the subset is refused,
// and the bound is exactly 16 KiB. The step counter and the generated values
// come in 1d-a2.

/** The bound the contract sets, written out so the schema's constant cannot move it. */
const LIMIT = 16384;
/** isCanonicalOrigin of server/http, which contracts may not import. */
const canonical = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
};
const accepts = (value: unknown) => Value.Check(Origin, value);

const SITE = "https://ductura.example.invalid";
// From #284 (05d12f26), plus 15 IPv6 forms, 12 of which the old pattern took: none is canonical.
const NOT_CANONICAL = [
  ...["", "null", `${SITE}/`, `${SITE}/put`, `${SITE}?a`, `${SITE}#a`, `${SITE}:`, `${SITE}:01`],
  ...["https://u:p@ductura.example.invalid", `${SITE}\r\n`, `\t${SITE}`, `${SITE}\u00a0`],
  ...[`${SITE}\u007f`, "C:\\ductura", "file:///C:/ductura", "https://Ductura.example.invalid"],
  ...[`${SITE}:443`, "http://ductura.example.invalid:80", `${SITE}:00`, `${SITE}:0443`],
  ...[`${SITE}:65536`, `${SITE}:100000`, "https://[::1", "https://[]", "https://[::FFFF:1]"],
  ...["https://[::ffff:1.2.3.4]", "wss://ductura.example.invalid", "http://a%41", "http://a b"],
  ...["http://127.1", "http://0x.", "http://127.1:3000", "http://0x7f.0.0.1", "http://010.0.0.1"],
  ...["http://999", "http://a.09", "http://1.2.3", "http://256.0.0.1", "http://1.2.3.4.5"],
  ...["http://1.2.3.04", "http://0x10", "http://0xa", "http://a.0xff", "https://0", "http://a.0x"],
  ...["http://1.2.3.4.", "http://a.1.", "https://[1]", "https://[:]", "https://[0:0:1:2:3:4:5:6]"],
  ...["https://[1:2:3:4:5:6:7]", "https://[1:2:3:4:5:6:7:8:9]", "https://[01:2:3:4:5:6:7:8]"],
  ...["https://[1:2:3:4:5:6:0:0]", "https://[1:0:0:2:3:4:5:6]", "https://[12345:2:3:4:5:6:7:8]"],
  ...["https://[0::1]", "https://[::01]", "https://[0001:2:3:4:5:6:7:8]", "https://[::1]:443"],
  ...["https://[A:2:3:4:5:6:7:8]", "https://[1:2:3:4:5:6:1.2.3.4]"],
];
// Canonical, but outside the subset (decision c.6982431631).
const OUTSIDE = ["https://xn--mnchen-3ya.invalid", "https://[::]", "https://[2001:db8::1]"];
// Every label beginning with xn--. Node versions differ on whether URL takes
// these, so only the refusal is asserted. Capitals never pass the class.
const XN = [
  ...["https://xn--a.invalid", "https://a.xn--b.invalid", "https://a.b.xn--", "http://xn--a:8080"],
  ...["http://a.xn--", "https://a.xn--.b", "https://XN--a", "https://Xn--a.b"],
];
// From #284 (05d12f26), without https://xn--mnchen-3ya.invalid, then in the subset.
const GOOD = [
  ...["http://127.0.0.1:3000", "https://[::1]:8443", "http://localhost", `${SITE}:65535`],
  ...["https://[2001:db8:1:2:3:4:5:6]:8443", "http://255.255.255.255:65534", "http://203.0.113.3"],
  ...["http://0.0.0.0", `${SITE}:50000`, `${SITE}:4430`, `${SITE}:12345`, `${SITE}:60000`],
  ...[`${SITE}:0`, "https://1a", "http://1..", "https://a-1.b--c.example.invalid", "https://a.0xg"],
  ...["https://1-2", "https://a.26-27", "http://localhost.:4000", `${SITE}.`, "https://.."],
  ...["http://-", "https://a-.example.invalid", "https://a_b.invalid", "https://a+b~c.invalid"],
  ...["http://x.1-", "https://[0:1:2:3:4:5:6:0]", "https://[1:0:2:0:3:0:4:0]"],
  ...["https://[1:2:3:4:5:6:7:0]", "https://[1:2:3:4:5:6:102:304]", "https://a.invalid:80"],
  ...["http://a.invalid:443", "http://[::1]:443"],
];
const NOISE = [
  ...["\r\n", "\r", "\n", "\t", "\u00a0", "\u007f", "\0", " ", "/", "\\", "@", "u:p@"],
  ...["\u212a", "\u017f", "\u3002", "\uff0e", "\u00ad", "\u200b"],
];

describe("Origin", () => {
  it("rejects every non-canonical origin named here and in #284, and what is not text", () => {
    for (const value of NOT_CANONICAL)
      expect([value, canonical(value), accepts(value)]).toEqual([value, false, false]);
    for (const value of [null, true, 1, {}, [SITE], undefined]) expect(accepts(value)).toBe(false);
  });

  it("rejects canonical origins outside the subset, and the named xn-- labels", () => {
    for (const value of OUTSIDE)
      expect([value, canonical(value), accepts(value)]).toEqual([value, true, false]);
    for (const value of XN) expect([value, accepts(value)]).toEqual([value, false]);
  });

  it("rejects noise at every position of a good origin", () => {
    for (const good of ["https://a.invalid:8443", "http://[::1]", "http://192.0.2.1:8080"]) {
      expect([good, canonical(good), accepts(good)]).toEqual([good, true, true]);
      for (const noise of NOISE)
        for (let at = 0; at <= good.length; at++) {
          const value = good.slice(0, at) + noise + good.slice(at);
          expect([value, canonical(value), accepts(value)]).toEqual([value, false, false]);
        }
    }
  });

  it("accepts the canonical origins named in #284 but one, and more of the subset", () => {
    expect(GOOD).toHaveLength(34);
    for (const value of GOOD)
      expect([value, canonical(value), accepts(value)]).toEqual([value, true, true]);
  });

  it("accepts canonical origins of exactly 16 KiB and refuses one unit more", () => {
    const fill = (head: string, tail: string, unit: string, size: number) =>
      head + unit.repeat(size).slice(0, size - head.length - tail.length) + tail;
    expect(ORIGIN_MAX_LENGTH).toBe(LIMIT);
    for (const [head, tail, unit] of [
      ["https://", "", "a"],
      ["http://", ":65535", "a"],
      ["https://", "z", "b."],
    ] as const)
      for (const size of [LIMIT, LIMIT + 1]) {
        const value = fill(head, tail, unit, size);
        const fits = size === LIMIT;
        expect([value.length, canonical(value), accepts(value)]).toEqual([size, true, fits]);
      }
  });
});
