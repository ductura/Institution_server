import { readFileSync } from "node:fs";

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
const BAD_ORIGIN = [
  ...["", "null", `${SITE}/`, `${SITE}/put`, `${SITE}?a`, `${SITE}#a`, `${SITE}:`],
  ...[
    "https://u:p@ductura.example.invalid",
    `${SITE}\r\n`,
    `\t${SITE}`,
    `${SITE}\u00a0`,
    `${SITE}\u007f`,
  ],
  ...["C:\\ductura", "file:///C:/ductura", "https://Ductura.example.invalid", `${SITE}:443`],
  ...["http://ductura.example.invalid:80", `${SITE}:0`, `${SITE}:0443`, `${SITE}:65536`],
  ...["https://..", "http://-", "https://[::1", 1],
];
const GOOD_ORIGIN = [
  "http://127.0.0.1:3000",
  "https://[::1]:8443",
  "http://localhost",
  `${SITE}:65535`,
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
    for (const value of BAD_ORIGIN)
      expect(check({ ...full, origin: value }), JSON.stringify(value)).toBe(false);
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
      expect(new URL(origin).origin).toBe(origin);
      expect(check({ ...full, origin }), origin).toBe(true);
    }
  });

  it("is closed, every name required and a lowercase token, every value a string", () => {
    expect(schema?.additionalProperties).toBe(false);
    expect([...(schema?.required ?? [])].sort()).toEqual(names);
    for (const name of names) expect(name).toMatch(/^[a-z0-9!#$%&'*+.^_`|~-]+$/);
    for (const property of Object.values(schema?.properties ?? {}))
      expect(Value.Check(property, 1)).toBe(false);
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
