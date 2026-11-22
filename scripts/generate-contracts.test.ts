// The cleanup of compiled validators in the contract generator (DAN-758):
// it must touch only what TypeBox writes, never a field name or pattern text.
import { Type } from "@sinclair/typebox";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compileValidator, typeScriptOf } from "./index.ts";

/** The compiled check, transpiled to JavaScript and run. */
function run(code: string): (value: unknown) => boolean {
  const js = ts.transpileModule(`return ${code};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(js)() as (value: unknown) => boolean;
}

// The name TypeBox gives its own regex constants, used here as a field name.
const FIELD = "local_0";

describe("compileValidator", () => {
  it("keeps a field named local_0 and a pattern that says local_1", () => {
    const schema = Type.Object(
      { [FIELD]: Type.String({ pattern: "^local_1$" }) },
      { additionalProperties: false },
    );
    const code = compileValidator(schema, "test:body");
    expect(code).toContain("value['local_0']");
    expect(code).toContain("local_1");
    expect(code).not.toMatch(/const local_\d+ =/);
    const check = run(code);
    expect(check({ [FIELD]: "local_1" })).toBe(true);
    expect(check({ [FIELD]: "local1" })).toBe(false);
    expect(check({ local0: "local_1" })).toBe(false);
  });

  it("checks array items, integer bounds and closed objects", () => {
    const schema = Type.Object(
      {
        n: Type.Integer({ minimum: 0 }),
        list: Type.Array(Type.String({ pattern: "^a+$" }), { minItems: 1, maxItems: 1 }),
      },
      { additionalProperties: false },
    );
    const check = run(compileValidator(schema, "test:body"));
    expect(check({ n: 0, list: ["aa"] })).toBe(true);
    expect(check({ n: 0.5, list: ["aa"] })).toBe(false);
    expect(check({ n: "0", list: ["aa"] })).toBe(false);
    expect(check({ n: 0, list: ["b"] })).toBe(false);
    expect(check({ n: 0, list: ["a", "a"] })).toBe(false);
    expect(check({ n: 0, list: ["a"], extra: 1 })).toBe(false);
  });
  it("checks bounded integer items of an array, typed before the bounds are read", () => {
    const schema = Type.Object(
      { gaps: Type.Array(Type.Integer({ minimum: 0, maximum: 9 }), { minItems: 1 }) },
      { additionalProperties: false },
    );
    const code = compileValidator(schema, "test:body");
    expect(code).toContain("(typeof value === 'number' && Number.isInteger(value))");
    const check = run(code);
    expect(check({ gaps: [0, 9] })).toBe(true);
    expect(check({ gaps: [10] })).toBe(false);
    expect(check({ gaps: [-1] })).toBe(false);
    expect(check({ gaps: [1.5] })).toBe(false);
    expect(check({ gaps: ["1"] })).toBe(false);
  });
  it("checks a closed object one level inside the body without reading past a failed test", () => {
    const inner = Type.Object(
      {
        family: Type.Literal("other"),
        major: Type.Union([Type.Integer({ maximum: 9 }), Type.Null()]),
      },
      { additionalProperties: false },
    );
    const schema = Type.Object({ browser: inner }, { additionalProperties: false });
    const code = compileValidator(schema, "test:body");
    expect(code).toContain("nestedBrowser['family']");
    expect(code).not.toContain("value['browser']['");
    const check = run(code);
    expect(check({ browser: { family: "other", major: 9 } })).toBe(true);
    expect(check({ browser: { family: "other", major: null } })).toBe(true);
    expect(check({ browser: { family: "other", major: 10 } })).toBe(false);
    expect(check({ browser: { family: "other", major: 1.5 } })).toBe(false);
    expect(check({ browser: { family: "other", major: "9" } })).toBe(false);
    expect(check({ browser: { family: "other", major: 9, extra: 1 } })).toBe(false);
    expect(check({ browser: { family: "safari", major: 9 } })).toBe(false);
    for (const value of [null, undefined, 1, "x", [], {}, { browser: null }, { browser: [] }])
      expect(check(value)).toBe(false);
  });

  it("refuses a nested object two levels deep or inside an array", () => {
    const leaf = Type.Object({ x: Type.String() });
    const deep = Type.Object({ a: Type.Object({ b: leaf }) });
    expect(() => compileValidator(deep, "test:deep")).toThrow(/unexpected nested validator shape/u);
    const dashed = Type.Object({ "a-b": Type.Object({ f: Type.Integer() }) });
    expect(() => compileValidator(dashed, "test:dashed")).toThrow(
      /unexpected nested validator shape/u,
    );
    const listed = Type.Object({ a: leaf, list: Type.Array(Type.Object({ c: leaf })) });
    expect(() => compileValidator(listed, "test:listed")).toThrow(
      /unexpected nested validator shape/u,
    );
  });
});

describe("typeScriptOf", () => {
  it("keeps the value type of a map keyed by pattern (DAN-818, resumeDocuments)", () => {
    const map = Type.Record(Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.String(), {
      additionalProperties: false,
    });
    expect(typeScriptOf(map)).toBe("{ [key: string]: string }");
    expect(typeScriptOf(Type.Object({ a: Type.Number() }, { additionalProperties: false }))).toBe(
      '{ "a": number }',
    );
    expect(typeScriptOf(Type.Object({}))).toBe("{ [key: string]: unknown }");
  });
});
