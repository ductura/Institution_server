import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Origin, ORIGIN_MAX_LENGTH } from "./origin.ts";

// DAN-930-1d-a (ugovor Ductus#2028): Origin accepts exactly the subset below
// of the canonical http(s) origins, and a step counter, not a clock, shows
// that the check is linear in the length of the value.

/** isCanonicalOrigin of server/http, which contracts may not import. */
const canonical = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
};
/** The subset: canonical, at most 16 KiB, no xn-- label, IPv6 [::1] or uncompressed. */
const inSubset = (value: string) => {
  if (value.length > ORIGIN_MAX_LENGTH || !canonical(value)) return false;
  const host = new URL(value).hostname;
  if (host.startsWith("[")) return host === "[::1]" || !host.includes("::");
  return !host.split(".").some((label) => label.startsWith("xn--"));
};

// A backtracking matcher for the syntax the pattern uses, in ECMAScript's
// search order. A class or an escape matches one code unit and is decided by
// RegExp itself. A step is every call and every code unit a class examines; a
// quantified class is a loop that gives back one unit at a time, as greedy
// backtracking does, so 16 KiB does not overflow the stack.
type Node =
  | { t: "start" }
  | { t: "unit"; re: RegExp }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "not"; node: Node }
  | { t: "rep"; node: Node; min: number; max: number };

function parse(src: string): Node {
  let i = 0;
  const unit = (source: string): Node => ({ t: "unit", re: new RegExp(`^${source}$`) });
  const atom = (): Node => {
    const c = src[i++] ?? "";
    if (c === "^") return { t: "start" };
    if (c === "\\") return unit(c + src[i++]);
    if (c === "[") {
      const from = i - 1;
      if (src[i] === "^") i++;
      do i += src[i] === "\\" ? 2 : 1;
      while (src[i] !== "]");
      return unit(src.slice(from, ++i));
    }
    const group = c === "(" ? src.slice(i, i + 2) : "";
    if (group === "?:" || group === "?!") {
      i += 2;
      const node = alt();
      if (src[i++] !== ")") throw new Error(`unclosed group before ${i}`);
      return group === "?:" ? node : { t: "not", node };
    }
    if ("()|*+?{}$.]".includes(c)) throw new Error(`unsupported ${c} at ${i - 1}`);
    return unit(c.replace(/[/\\^$*+?.()|[\]{}-]/g, "\\$&"));
  };
  const quantified = (): Node => {
    const node = atom();
    const q = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})/.exec(src.slice(i));
    if (!q) return node;
    i += q[0].length;
    if (src[i] === "?") throw new Error(`lazy quantifier at ${i}`);
    const [, sign, low, comma, high] = q;
    const min = sign ? Number(sign === "+") : Number(low);
    const max = sign
      ? sign === "?"
        ? 1
        : Infinity
      : !comma
        ? min
        : high
          ? Number(high)
          : Infinity;
    return { t: "rep", node, min, max };
  };
  const seq = (): Node => {
    const items: Node[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") items.push(quantified());
    return { t: "seq", items };
  };
  const alt = (): Node => {
    const options = [seq()];
    while (src[i] === "|") (i++, options.push(seq()));
    return { t: "alt", options };
  };
  const root = alt();
  if (i !== src.length) throw new Error(`unparsed from ${i}`);
  return root;
}

/** Whether `root` matches `s`, by a search that throws past `limit` steps. */
function countSteps(root: Node, s: string, limit: number): { ok: boolean; steps: number } {
  let steps = 0;
  const tick = () => {
    if (++steps > limit) throw new Error(`over ${limit} steps`);
  };
  const m = (n: Node, i: number, k: (j: number) => boolean): boolean => {
    tick();
    switch (n.t) {
      case "start":
        return i === 0 && k(i);
      case "unit":
        return i < s.length && (tick(), n.re.test(s[i] ?? "")) && k(i + 1);
      case "seq": {
        const go = (x: number, j: number): boolean => {
          const item = n.items[x];
          return item ? m(item, j, (e) => go(x + 1, e)) : k(j);
        };
        return go(0, i);
      }
      case "alt":
        return n.options.some((o) => m(o, i, k));
      case "not":
        return !m(n.node, i, () => true) && k(i);
      case "rep": {
        const { node, min, max } = n;
        if (node.t === "unit") {
          let j = i;
          while (j - i < max && j < s.length && (tick(), node.re.test(s[j] ?? ""))) j++;
          for (; j >= i + min; j--) if (k(j)) return true;
          return false;
        }
        const go = (count: number, j: number): boolean =>
          (count < max && m(node, j, (e) => e !== j && go(count + 1, e))) || (count >= min && k(j));
        return go(0, i);
      }
    }
  };
  for (let at = 0; at <= s.length; at++) if (m(root, at, () => true)) return { ok: true, steps };
  return { ok: false, steps };
}

const PATTERN = Origin.pattern ?? "";
const TREE = parse(PATTERN);
const budget = (value: string) => 64 * (value.length + 16);
/** Checks `value` by the counter first, within budget, then by RegExp and Value.Check. */
const check = (value: string) => {
  const { ok, steps } = countSteps(TREE, value, budget(value));
  expect([value, ok]).toEqual([value, new RegExp(PATTERN).test(value)]);
  return { accepted: Value.Check(Origin, value), steps };
};

const SITE = "https://ductura.example.invalid";
// From #284 (05d12f26), plus IPv6 the old pattern took: none is canonical.
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
      expect([value, canonical(value), check(value).accepted]).toEqual([value, false, false]);
    for (const value of [null, true, 1, {}, [SITE], undefined])
      expect(Value.Check(Origin, value)).toBe(false);
  });

  it("rejects canonical origins outside the subset, and every xn-- label", () => {
    for (const value of OUTSIDE)
      expect([value, canonical(value), check(value).accepted]).toEqual([value, true, false]);
    for (const value of XN) expect([value, check(value).accepted]).toEqual([value, false]);
  });

  it("rejects noise at every position of a good origin", () => {
    for (const good of ["https://a.invalid:8443", "http://[::1]", "http://192.0.2.1:80"])
      for (const noise of NOISE)
        for (let at = 0; at <= good.length; at++) {
          const value = good.slice(0, at) + noise + good.slice(at);
          expect([value, check(value).accepted]).toEqual([value, false]);
        }
  });

  it("accepts the canonical origins named in #284 but one, and more of the subset", () => {
    expect(GOOD.slice(0, 27)).not.toContain("https://xn--mnchen-3ya.invalid");
    for (const value of GOOD)
      expect([value, canonical(value), check(value).accepted]).toEqual([value, true, true]);
  });

  it("accepts canonical origins of exactly 16 KiB and refuses one unit more", () => {
    const fill = (head: string, tail: string, unit: string, size: number) =>
      head + unit.repeat(size).slice(0, size - head.length - tail.length) + tail;
    for (const [head, tail, unit] of [
      ["https://", "", "a"],
      ["http://", ":65535", "a"],
      ["https://", ".z", "b."],
    ] as const)
      for (const size of [ORIGIN_MAX_LENGTH, ORIGIN_MAX_LENGTH + 1]) {
        const value = fill(head, tail, unit, size);
        const fits = size === ORIGIN_MAX_LENGTH;
        expect([value.length, canonical(value), check(value).accepted]).toEqual([size, true, fits]);
      }
  });

  it("takes steps linear in the length on inputs that fail late, by a counter", () => {
    const families: ((n: number) => string)[] = [
      (n) => `https://${"a".repeat(n)}/`,
      (n) => `https://${"a".repeat(n)}\r\n`,
      (n) => `http://${"1.".repeat(n / 2)}1\u00a0`,
      (n) => `https://${"a.".repeat(n / 2)}xn`,
      (n) => `https://${"-.".repeat(n / 2)}0x`,
      (n) => `https://[${"0:".repeat(n / 2)}`,
      (n) => `https://[${"1:".repeat(n / 2)}1]`,
      (n) => `http://a.0x${"1".repeat(n)}:`,
      (n) => `http://a:${"9".repeat(n)}`,
      (n) => `https://${"{".repeat(n)}:443`,
    ];
    for (const make of families)
      for (const n of [256, 512, 1024, 2048]) {
        const [single, double] = [check(make(n)).steps, check(make(2 * n)).steps];
        expect([make(2), double <= 2 * single + 64]).toEqual([make(2), true]);
      }
  });

  it("has a counter that sees a domain which backtracks", () => {
    const domain = "[-!\"$&'()*+,.0-9;=_`a-z{}~]";
    const value = `https://${"a".repeat(256)}/`;
    expect(PATTERN.split(`${domain}+`)).toHaveLength(3);
    for (const slow of [`(?:${domain}+)+`, `${domain}*${domain}*`, `${domain}+${domain}+`])
      expect(() =>
        countSteps(parse(PATTERN.split(`${domain}+`).join(slow)), value, budget(value)),
      ).toThrow(/^over/);
  });

  it("accepts exactly the subset of generated values, in linear steps", () => {
    const letters = [..."-!\"$&'()*+,;=_`{}~0123456789abcdefxnAXN%^|<>"];
    const word = fc.string({ unit: fc.constantFrom(...letters), maxLength: 6 });
    const hex = fc.string({ unit: fc.constantFrom(..."0123456789abcdefABCDEF"), maxLength: 5 });
    const label = fc.oneof(
      word,
      word.map((w) => `xn--${w}`),
      hex.map((h) => `0x${h}`),
    );
    const octet = fc.nat(300).chain((n) => fc.constantFrom(`${n}`, `0${n}`));
    const group = fc.oneof(
      { weight: 12, arbitrary: fc.constantFrom("0", "1", "a", "ffff", "12") },
      fc.constantFrom("01", "12345", "A", ""),
      hex,
    );
    const host = fc.oneof(
      fc.array(label, { minLength: 1, maxLength: 4 }).map((l) => ["domain", l.join(".")]),
      fc.array(octet, { minLength: 3, maxLength: 5 }).map((l) => ["ipv4", l.join(".")]),
      fc
        .oneof(fc.array(group, { minLength: 8, maxLength: 8 }), fc.array(group, { maxLength: 9 }))
        .map((g) => ["ipv6", `[${g.join(":")}]`]),
      fc.constantFrom(["ipv6", "[::1]"], ["domain", "a."], ["domain", "localhost"]),
    );
    const port = fc.oneof(
      fc.constant(""),
      fc.nat(65535).map((p) => `:${p}`),
      fc.constantFrom(":", ":80", ":443", ":65536", ":99999", ":080", ":0"),
    );
    const scheme = fc.oneof(
      { weight: 6, arbitrary: fc.constantFrom("https://", "http://") },
      fc.constantFrom("HTTP://", "ws://", "https:/", "https:\\\\", "", "u:p@"),
    );
    const noise = fc.oneof({ weight: 6, arbitrary: fc.constant("") }, fc.constantFrom(...NOISE));
    const sample = fc
      .tuple(
        scheme,
        fc.constantFrom("", "", "", "", "u@", "u:p@", "@"),
        host,
        port,
        noise,
        fc.nat(),
      )
      .map(([s, user, [kind, h], p, n, at]) => {
        const v = s + user + h + p;
        return {
          kind: `${kind} ${s}`,
          value: v.slice(0, at % (v.length + 1)) + n + v.slice(at % (v.length + 1)),
        };
      });
    const tally = new Map<string, [number, number]>();
    for (const { kind, value } of fc.sample(sample, { numRuns: 20_000, seed: 930 })) {
      const { accepted } = check(value);
      expect([value, accepted]).toEqual([value, inSubset(value)]);
      const [yes, no] = tally.get(kind) ?? [0, 0];
      tally.set(kind, accepted ? [yes + 1, no] : [yes, no + 1]);
    }
    for (const kind of ["domain", "ipv4", "ipv6"])
      for (const s of ["https://", "http://"])
        expect([kind, s, ...(tally.get(`${kind} ${s}`) ?? [0, 0]).map((c) => c > 0)]).toEqual([
          kind,
          s,
          true,
          true,
        ]);
    // A slice repeated 64-512 times: quadratic steps pass the budget from about 64 units.
    const pumped = fc
      .tuple(sample, fc.nat(), fc.nat(), fc.integer({ min: 64, max: 512 }))
      .map(([{ value: v }, a, b, times]) => {
        const [from, to] = [a % (v.length + 1), b % (v.length + 1)].sort((x, y) => x - y);
        return v.slice(0, from) + v.slice(from, to).repeat(times) + v.slice(to);
      });
    for (const value of fc.sample(pumped, { numRuns: 1_000, seed: 931 }))
      expect([value, check(value).accepted]).toEqual([value, inSubset(value)]);
  });
});
