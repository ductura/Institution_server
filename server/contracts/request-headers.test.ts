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
  1,
  null,
  ["1"],
];
// None is canonical (new URL(o).origin !== o): the server can never be set to it.
const BAD_ORIGIN = [
  ...["", "null", `${SITE}/`, `${SITE}/put`, `${SITE}?a`, `${SITE}#a`, `${SITE}:`, `${SITE}:01`],
  ...["https://u:p@ductura.example.invalid", `${SITE}\r\n`, `\t${SITE}`, `${SITE}\u00a0`],
  ...[`${SITE}\u007f`, "C:\\ductura", "file:///C:/ductura", "https://Ductura.example.invalid"],
  ...[`${SITE}:443`, "http://ductura.example.invalid:80", `${SITE}:00`, `${SITE}:0443`],
  ...[`${SITE}:65536`, `${SITE}:100000`, "https://[::1", "https://[]", "https://[::FFFF:1]"],
  ...["wss://ductura.example.invalid", "http://a%41", "http://a b", "http://127.1", "http://0x."],
  ...["http://127.1:3000", "http://0x7f.0.0.1", "http://010.0.0.1", "http://999", "http://a.09"],
  ...["http://1.2.3", "http://256.0.0.1", "http://1.2.3.4.5", "http://1.2.3.04", "http://0x10"],
  ...["http://0xa", "http://a.0xff", "https://0", "http://a.0x", "http://1.2.3.4.", "http://a.1."],
];
// Each is canonical, so the server could be set to it (review FAIL c.6965388921).
const GOOD_ORIGIN = [
  ...["http://127.0.0.1:3000", "https://[::1]:8443", "http://localhost", `${SITE}:65535`],
  ...["http://255.255.255.255:65534", "http://200.1.2.3", "http://0.0.0.0", `${SITE}:50000`],
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
    // For both schemes (QA FAIL c.6965391343, c.6965783097): every port, with
    // and without a leading zero, and every printable ASCII code point inside
    // a host; the schema agrees with URL on each.
    const wrong: string[] = [];
    for (const scheme of ["http://", "https://"]) {
      const host = `${scheme}ductura.example.invalid`;
      const origins: string[] = [];
      for (let port = 0; port <= 65536; port++) origins.push(`${host}:${port}`, `${host}:0${port}`);
      for (let code = 0x20; code < 0x7f; code++)
        origins.push(`${scheme}a${String.fromCharCode(code)}b`);
      for (const origin of origins)
        if (schema && Value.Check(schema, { ...full, origin }) !== canonical(origin))
          wrong.push(origin);
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
