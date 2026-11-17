import { describe, expect, it } from "vitest";

import {
  HOSTILE_JSON,
  HOSTILE_KEYS,
  HOSTILE_STRINGS,
  hostileObjects,
  hostileStrings,
} from "./index.ts";

// DAN-947: every class has a predicate that its value must meet, so a class
// cannot go missing and an entry cannot lose the character it is named for.
const CLASS: Record<string, (value: string) => boolean> = {
  "yaml-escape": (v) => v.includes("\\n"),
  "yaml-mapping": (v) => v.includes(": "),
  "yaml-sequence": (v) => v.startsWith("- "),
  "yaml-comment": (v) => v.startsWith("#"),
  "double-quoted-key": (v) => v.startsWith('"') && v.endsWith('"'),
  "single-quoted-key": (v) => v.startsWith("'") && v.endsWith("'"),
  "lone-high-surrogate": (v) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(v),
  "lone-low-surrogate": (v) => /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v),
  crlf: (v) => v.endsWith("\r\n"),
  cr: (v) => /\r(?!\n)/.test(v),
  lf: (v) => /(?<!\r)\n/.test(v),
  tab: (v) => v.includes("\t"),
  nbsp: (v) => v.includes("\u00A0"),
  del: (v) => v.includes("\u007F"),
  "leading-space": (v) => v.startsWith(" "),
  "trailing-slash": (v) => v.endsWith("/"),
  "windows-path": (v) => /^[A-Z]:\\/.test(v),
  empty: (v) => v === "",
  space: (v) => v === " ",
  // Computed: a literal __proto__ key would set the prototype instead.
  ["__proto__"]: (v) => v === "__proto__",
  toString: (v: string) => v === "toString",
  constructor: (v: string) => v === "constructor",
};

describe("hostile inputs table", () => {
  it.each(["a", "fpzg", "ductus-institutions-v1"])(
    "covers every class around %j, each with its character",
    (valid) => {
      const table = hostileStrings(valid);
      expect(table.map((entry) => entry.name)).toEqual(Object.keys(CLASS));
      for (const { name, value } of table) expect(CLASS[name]?.(value), name).toBe(true);
      for (const { value } of table) expect(value === valid).toBe(false);
    },
  );

  it("is frozen, with unique names, and has the JSON null, [] and [null]", () => {
    for (const table of [HOSTILE_STRINGS, HOSTILE_KEYS, HOSTILE_JSON]) {
      expect(Object.isFrozen(table)).toBe(true);
      for (const entry of table) expect(Object.isFrozen(entry)).toBe(true);
      const names = table.map((entry) => (typeof entry === "string" ? entry : entry.name));
      expect(new Set(names).size).toBe(names.length);
    }
    expect(HOSTILE_STRINGS).toEqual(hostileStrings("a"));
    expect(HOSTILE_JSON.map(({ text }) => JSON.parse(text) as unknown)).toEqual([null, [], [null]]);
  });

  it("builds objects without touching or changing the valid one", () => {
    const valid = { slug: "fpzg", citationStyle: "fpzg" };
    const variants = hostileObjects(valid);
    expect(valid).toEqual({ slug: "fpzg", citationStyle: "fpzg" });
    expect(variants.map(({ name, refusal }) => [name, refusal])).toEqual([
      ...HOSTILE_KEYS.map((key) => [`own ${key}`, "fields"]),
      ["inherited slug", "fields"],
      ["getter slug", "accessor"],
      ["proxy with toString", "fields"],
    ]);
    for (const { name, touched } of variants) expect(touched(), name).toBe(0);
    const own = variants.map(({ value }) => Reflect.ownKeys(value as object));
    for (const [i, key] of HOSTILE_KEYS.entries()) expect(own[i]).toContain(key);
    const inherited = variants[HOSTILE_KEYS.length]?.value as object;
    expect([Object.hasOwn(inherited, "slug"), "slug" in inherited]).toEqual([false, true]);
  });

  it("counts a getter call and a get or has trap", () => {
    const variants = hostileObjects({ slug: "fpzg" });
    const getter = variants.find(({ name }) => name === "getter slug");
    const proxy = variants.find(({ name }) => name === "proxy with toString");
    void (getter?.value as { slug: unknown }).slug;
    expect(getter?.touched()).toBe(1);
    void ("slug" in (proxy?.value as object) && (proxy?.value as { slug: unknown }).slug);
    expect(proxy?.touched()).toBe(2);
  });
});
