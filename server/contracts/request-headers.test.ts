import { readFileSync } from "node:fs";

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";
import type { VectorFile } from "./vectors.ts";

// DAN-930-1a (ugovor Ductus#2028 c.6964645428): a route's contract declares the
// request headers the client must set itself, as a closed object every name of
// which is required. The schema is checked on the projection of those names.

const DECLARED = {
  "evidence.commit.post": ["ductus-protocol", "origin"],
  "evidence.open.post": ["ductus-protocol", "origin"],
  "evidence.replay.post": ["ductus-protocol", "origin"],
  "live.document.get": ["ductus-protocol"],
  "submission.submit.post": ["ductus-protocol", "origin"],
} as const;

// The protocols each route takes, as readEvidenceBody's lists (open, replay:
// "1"; commit: "1", and "2" with async signing) and, for the CONTRACT_ONLY
// submission and live read, the vectors. contracts may not import http.
const PROTOCOLS: Readonly<Record<string, readonly string[]>> = {
  "evidence.commit.post": ["1", "2"],
  "evidence.open.post": ["1"],
  "evidence.replay.post": ["1"],
  "live.document.get": ["1"],
  "submission.submit.post": ["1"],
};
const literals = (s: TSchema | undefined): unknown[] =>
  Array.isArray(s?.["anyOf"]) ? (s["anyOf"] as TSchema[]).flatMap(literals) : [s?.["const"]];

const SITE = "https://ductura.example.invalid";
// Values that are not text (orchestrator c.6966397404).
const NOT_TEXT = [null, true, false, 1, 0, {}, { value: "1" }, [], undefined];
const BAD_PROTOCOL = [
  "0",
  "3",
  "",
  " 1",
  "1 ",
  "2 ",
  "1\r\n",
  "\t1",
  "1\u00a0",
  "1\u007f",
  ...NOT_TEXT,
  ["1"],
];
// None is canonical (new URL(o).origin !== o): the server can never be set to it.
const BAD_ORIGIN = [
  ...["", "null", `${SITE}/`, `${SITE}/put`, `${SITE}?a`, `${SITE}#a`, `${SITE}:`, `${SITE}:01`],
  ...["https://u:p@ductura.example.invalid", `${SITE}\r\n`, `\t${SITE}`, `${SITE}\u00a0`],
  ...[`${SITE}\u007f`, "C:\\ductura", "file:///C:/ductura", "https://Ductura.example.invalid"],
  ...[`${SITE}:443`, "http://ductura.example.invalid:80", `${SITE}:00`, `${SITE}:0443`],
  ...[
    `${SITE}:65536`,
    `${SITE}:100000`,
    "https://[::1",
    "https://[]",
    "https://[::FFFF:1]",
    "https://[::ffff:1.2.3.4]",
  ],
  ...["wss://ductura.example.invalid", "http://a%41", "http://a b", "http://127.1", "http://0x."],
  ...["http://127.1:3000", "http://0x7f.0.0.1", "http://010.0.0.1", "http://999", "http://a.09"],
  ...["http://1.2.3", "http://256.0.0.1", "http://1.2.3.4.5", "http://1.2.3.04", "http://0x10"],
  ...["http://0xa", "http://a.0xff", "https://0", "http://a.0x", "http://1.2.3.4.", "http://a.1."],
  ...NOT_TEXT,
  [SITE],
];
// Each is canonical, so the server could be set to it (review FAIL c.6965388921).
const GOOD_ORIGIN = [
  ...["http://127.0.0.1:3000", "https://[::1]:8443", "http://localhost", `${SITE}:65535`],
  ...["http://255.255.255.255:65534", "http://203.0.113.3", "http://0.0.0.0", `${SITE}:50000`],
  ...[`${SITE}:4430`, `${SITE}:12345`, `${SITE}:60000`, `${SITE}:0`, "https://1a", "http://1.."],
  ...["https://a-1.b--c.example.invalid", "https://xn--mnchen-3ya.invalid", "https://a.0xg"],
  ...[
    "https://1-2",
    "https://a.26-27",
    "http://localhost.:4000",
    `${SITE}.`,
    "https://..",
    "http://-",
  ],
  ...["https://a-.example.invalid", "https://a_b.invalid", "https://a+b~c.invalid", "http://x.1-"],
];
const EXTRA = [
  "cookie",
  "sec-fetch-site",
  "content-type",
  "Origin",
  "Ductus-Protocol",
  "toString",
  "constructor",
];

/** isCanonicalOrigin of server/http, which contracts may not import. */
const canonical = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
};

// Hosts by kind, without the scheme or port (QA c.6965391343, c.6965783097,
// c.6966049680, c.6966779387; review c.6966316345; 930-1c self-check):
const ipv4 = (octet: string, place: number) =>
  ["192", "0", "2", "42"].map((part, i) => (i === place ? octet : part)).join(".");
const ipv6 = (groups: readonly string[]) => new URL(`http://[${groups.join(":")}]`).host;
const ASCII = Array.from({ length: 0x5f }, (_, c) => String.fromCharCode(c + 0x20));
const HOSTS: Readonly<Record<string, readonly string[]>> = {
  // every printable ASCII code point first, inside and last, and long names;
  domain: [
    ...ASCII.flatMap((c) => [`${c}a.invalid`, `a${c}b`, `a.invalid${c}`]),
    `${"a".repeat(250)}.invalid`,
    `${"a.".repeat(120)}invalid`,
    `${"b".repeat(1000)}.invalid`,
    ...["a..b", "a...b", "{}", "1-23"],
  ],
  // every octet 0-256 in every place, with and without a leading zero;
  ipv4: Array.from({ length: 257 }, (_, n) => [`${n}`, `0${n}`])
    .flat()
    .flatMap((octet) => [0, 1, 2, 3].map((place) => ipv4(octet, place))),
  // a last label that is or is not a number, after zero to three labels,
  // before one trailing dot or not;
  numeric: [
    ...["0", "1", "09", "256", "0x", "0x10", "0xa", "0xg", "1a", "1-", "a", "4294967296"],
    ...["00000000001", "0x100000000", "0x0123456789abcdef", "0x23456789bcde", "0x1g"],
  ].flatMap((last) =>
    ["", "a.", "1.", "127.", "1.2.", "1.2.3.", "a_b.", "!.", "{}.", "a-.", ".", "a..b."].flatMap(
      (head) => [`${head}${last}`, `${head}${last}.`],
    ),
  ),
  // each hex digit in each of eight groups, a zero run at every start and
  // length (compressed or not, as URL writes it) and the longest literal;
  ipv6: [
    ..."0123456789abcdef"
      .split("")
      .flatMap((d) =>
        [0, 1, 2, 3, 4, 5, 6, 7].map((place) =>
          ipv6(["2001", "db8", "1", "2", "3", "4", "5", "6"].with(place, `${d}${d}`)),
        ),
      ),
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((start) =>
      Array.from({ length: 8 - start }, (_, n) =>
        ipv6(["a", "b", "c", "d", "e", "f", "1", "2"].fill("0", start, start + n + 1)),
      ),
    ),
    ipv6(Array.from({ length: 8 }, () => "ffff")),
    ipv6(["2001", "db8", "1", "2", "3", "4", "5", "6"]),
    ...["::ffff:c000:22a", "::ffff:cb00:7103", "64:ff9b::c000:22a"].map((v) => ipv6([v])),
    ...["[A::1]", "[]", "[::1", "[::FFFF:1]", "[::ffff:1.2.3.4]"],
  ],
};
// Every host of every kind takes each of these ports.
const PORTS = [
  ...["", ":", ":0", ":00", ":01", ":1", ":80", ":443", ":1234", ":8080", ":54321"],
  ...[":65534", ":65535", ":65536", ":99999"],
];
// A few hosts of each kind also take each of these around them.
const HEADS = ["", "\t", " ", "u:p@", "U"];
const TAILS = [
  ...["", "/", "/put", "?a", "#a", ".", ":100000", "\r\n", "\n", "\r", "\t", " "],
  ...["\u00a0", "\u007f", "\u2028", "\ufeff"],
];
// The same few hosts also take each of these before the scheme.
const LEADS = ["\n", "\r\n", " ", "\t", "\ufeff", "x"];

const project = (names: readonly string[], headers: Readonly<Record<string, string>> = {}) =>
  Object.fromEntries(names.flatMap((n) => (Object.hasOwn(headers, n) ? [[n, headers[n]]] : [])));

describe.each(Object.entries(DECLARED))("%s", (id, names) => {
  const route = ROUTES.find((r) => r.id === id);
  const schema = route?.request.headers;
  const file = new URL(`./vectors/${id}.json`, import.meta.url);
  const { vectors } = JSON.parse(readFileSync(file, "utf8")) as VectorFile;
  const success = vectors.filter((v) => v.kind === "success");
  const full = project(names, success[0]?.request.headers);
  const check = (value: unknown) => {
    expect(schema, `${id} declares no headers`).toBeDefined();
    return schema !== undefined && Value.Check(schema, value);
  };

  it("declares headers, and has a success vector for the full set", () => {
    expect(schema).toBeDefined();
    expect(Object.keys(full).sort()).toEqual(names);
  });

  it("refuses a set without any one declared header", () => {
    for (const name of names) {
      const missing: Record<string, unknown> = { ...full };
      delete missing[name];
      expect(check(missing), name).toBe(false);
    }
  });

  it("refuses one more header, an inherited name or another case included", () => {
    for (const name of EXTRA) expect(check({ ...full, [name]: "1" }), name).toBe(false);
    const proto = JSON.parse(`{"__proto__": "1"}`) as Record<string, unknown>;
    expect(Object.hasOwn(proto, "__proto__")).toBe(true);
    expect(check({ ...full, ...proto })).toBe(false);
  });

  it("refuses a value outside the declared ones", () => {
    const protocols = id === "evidence.commit.post" ? BAD_PROTOCOL : [...BAD_PROTOCOL, "2"];
    for (const value of protocols)
      expect(check({ ...full, "ductus-protocol": value }), JSON.stringify(value)).toBe(false);
    if (!names.some((n) => n === "origin")) return;
    for (const value of BAD_ORIGIN) {
      if (typeof value === "string") expect(canonical(value), value).toBe(false);
      expect(check({ ...full, origin: value }), JSON.stringify(value)).toBe(false);
    }
  });

  it("refuses the 426 vectors and one without a declared header, accepts every other", () => {
    for (const v of vectors) {
      const given = project(names, v.request.headers);
      const ok = v.code !== "upgrade_required" && Object.keys(given).length === names.length;
      expect(check(given), v.name).toBe(ok);
    }
  });

  it("accepts every full set of its success vectors, also with no prototype", () => {
    for (const v of success) {
      const given = project(names, v.request.headers);
      expect(check(given), v.name).toBe(true);
      expect(check(Object.assign(Object.create(null), given)), v.name).toBe(true);
    }
    if (!names.some((n) => n === "origin")) return;
    for (const origin of GOOD_ORIGIN) {
      expect(canonical(origin), origin).toBe(true);
      expect(check({ ...full, origin }), origin).toBe(true);
    }
    // One loop, scheme x kind of host (930-1c, Ductus#2028 c.6966917804): for
    // http and https alike, every host of every kind with every port, a few
    // of each with junk around them, every listed example in either scheme
    // and every port 0-65536 agree with URL.
    const wrong: string[] = [];
    const agree = (origin: string) => {
      if (schema && Value.Check(schema, { ...full, origin }) !== canonical(origin))
        wrong.push(origin);
    };
    const listed = [...GOOD_ORIGIN, ...BAD_ORIGIN].flatMap((o) =>
      typeof o === "string" ? [o.replace(/^https?:\/\//, "")] : [],
    );
    for (const scheme of ["http://", "https://"]) {
      for (const [kind, hosts] of Object.entries(HOSTS)) {
        const origins = hosts.flatMap((host) => PORTS.map((port) => `${scheme}${host}${port}`));
        expect(origins.filter(canonical).length, `${scheme} ${kind}`).toBeGreaterThan(0);
        origins.forEach(agree);
        for (const host of [...hosts.slice(0, 3), ...hosts.slice(-2)])
          for (const head of HEADS)
            for (const tail of TAILS)
              for (const port of ["", ":1"]) agree(`${scheme}${head}${host}${port}${tail}`);
        for (const host of [...hosts.slice(0, 3), ...hosts.slice(-2)])
          for (const lead of LEADS) agree(`${lead}${scheme}${host}`);
      }
      listed.forEach((rest) => agree(`${scheme}${rest}`));
      for (let port = 0; port <= 65536; port++) {
        agree(`${scheme}a.invalid:${port}`);
        agree(`${scheme}a.invalid:0${port}`);
      }
    }
    expect(schema).toBeDefined();
    expect(wrong).toEqual([]);
  });

  it("is closed, every name required and a lowercase token, every value a string", () => {
    expect(schema?.additionalProperties).toBe(false);
    expect([...(schema?.required ?? [])].sort()).toEqual(names);
    for (const name of names) expect(name).toMatch(/^[a-z0-9!#$%&'*+.^_`|~-]+$/);
    for (const property of Object.values(schema?.properties ?? {}))
      expect(Value.Check(property, 1)).toBe(false);
    expect(literals(schema?.properties["ductus-protocol"]).sort()).toEqual(
      [...(PROTOCOLS[id] ?? [])].sort(),
    );
  });
});

it("exactly these routes declare headers, with exactly these names", () => {
  const found = Object.fromEntries(
    ROUTES.flatMap((r) =>
      r.request.headers === undefined
        ? []
        : [[r.id, Object.keys(r.request.headers.properties).sort()]],
    ),
  );
  expect(found).toEqual(DECLARED);
});
