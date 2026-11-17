import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isWorkId, workIdFromPath } from "../../server/contracts/index.ts";

// DAN-942: the work id cases as JSON vectors that clients read too. The server
// runs the same file from disk. The test sits here and not beside work-id.ts,
// because server/contracts is another writer's area (DAN-903, Ductus#1836).
const FORMAT = "ductura-work-id-vectors-v1";
const MAX_REPEAT = 1024;
type Check = "isWorkId" | "workIdFromPath";
type Vector = { name: string; check: Check; input: unknown; accepted: boolean; id?: string };
type Read = { ok: true; vectors: Vector[] } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Exactly these own keys, in any order: an extra, missing or inherited-name key fails.
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

function readVector(raw: unknown, at: number): Vector | string {
  if (!isObject(raw)) return `#${at}: not an object`;
  // Every field is checked by type before use: a name of another type or an
  // empty one would otherwise pass under a made-up label (review FAIL c.6949034737).
  const { name } = raw;
  if (typeof name !== "string" || name === "") return `#${at}: name is not a non-empty string`;
  const { check, accepted, repeat } = raw;
  if (check !== "isWorkId" && check !== "workIdFromPath") return `${name}: unknown check`;
  if (typeof accepted !== "boolean") return `${name}: accepted is not a boolean`;
  const withId = check === "workIdFromPath" && accepted;
  const keys = ["name", "check", "accepted", Object.hasOwn(raw, "repeat") ? "repeat" : "input"];
  if (!hasKeys(raw, withId ? [...keys, "id"] : keys)) return `${name}: wrong fields`;
  let input = raw.input;
  if (Object.hasOwn(raw, "repeat")) {
    if (!isObject(repeat) || !hasKeys(repeat, ["text", "count"])) return `${name}: bad repeat`;
    const { text, count } = repeat;
    if (typeof text !== "string" || text === "") return `${name}: bad repeat`;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_REPEAT) {
      return `${name}: bad repeat`;
    }
    input = text.repeat(count as number);
  }
  if (check === "workIdFromPath" && typeof input !== "string") return `${name}: path not a string`;
  if (withId && typeof raw.id !== "string") return `${name}: id is not a string`;
  return { name, check, input, accepted, ...(withId ? { id: raw.id as string } : {}) };
}

function readVectors(raw: unknown): Read {
  if (!isObject(raw) || !hasKeys(raw, ["format", "vectors"])) return { ok: false, error: "root" };
  if (raw.format !== FORMAT) return { ok: false, error: "format" };
  if (!Array.isArray(raw.vectors)) return { ok: false, error: "vectors" };
  const vectors: Vector[] = [];
  for (const [at, item] of (raw.vectors as unknown[]).entries()) {
    const vector = readVector(item, at);
    if (typeof vector === "string") return { ok: false, error: vector };
    vectors.push(vector);
  }
  return { ok: true, vectors };
}

const FILE = readFileSync(new URL("./vectors/work-id.json", import.meta.url), "utf8");
const read = readVectors(JSON.parse(FILE));
const VECTORS = read.ok ? read.vectors : [];

describe("work id vectors (@ductura/contracts/vectors/work-id.json)", () => {
  it("the file is read strictly, with unique names and both verdicts for each check", () => {
    expect(read).toMatchObject({ ok: true });
    const names = VECTORS.map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    for (const check of ["isWorkId", "workIdFromPath"]) {
      const verdicts = VECTORS.filter((v) => v.check === check).map((v) => v.accepted);
      expect(new Set(verdicts)).toEqual(new Set([true, false]));
    }
  });

  it.each(VECTORS)("$check: $name", ({ check, input, accepted, id }) => {
    if (check === "isWorkId") expect(isWorkId(input)).toBe(accepted);
    else expect(workIdFromPath(input as string)).toBe(accepted ? id : null);
  });
});

describe("work id vectors: a broken file is refused", () => {
  const ok = { name: "v", check: "isWorkId", input: "doc", accepted: true };
  const path = { name: "p", check: "workIdFromPath", input: "doc", accepted: true, id: "doc" };
  const file = (...vectors: unknown[]): unknown => ({ format: FORMAT, vectors });
  // Own keys with inherited names, written as JSON text: a literal would set the prototype.
  const ownKey = (key: string): unknown =>
    JSON.parse(`{"name":"v","check":"isWorkId","input":"doc","accepted":true,"${key}":1}`);

  it.each<[string, unknown, string]>([
    ...["null", "[]", "[null]"].map((text): [string, unknown, string] => [
      `root ${text}`,
      JSON.parse(text),
      "root",
    ]),
    ["vectors null", { format: FORMAT, vectors: null }, "vectors"],
    ["another format", { format: `${FORMAT} `, vectors: [] }, "format"],
    ["an extra root key", { format: FORMAT, vectors: [], x: 1 }, "root"],
    ["a vector null", file(null), "#0: not an object"],
    ["a vector []", file([]), "#0: not an object"],
    ["a vector [null]", file([null]), "#0: not an object"],
    ...["__proto__", "toString", "constructor", "valueOf", "hasOwnProperty"].map(
      (key): [string, unknown, string] => [`own key ${key}`, file(ownKey(key)), "v: wrong fields"],
    ),
    ...[7, "", null, true, ["v"], { v: 1 }].map((name): [string, unknown, string] => [
      `name ${JSON.stringify(name)}`,
      file({ ...ok, name }),
      "#0: name is not a non-empty string",
    ]),
    [
      "a missing name",
      file({ check: "isWorkId", input: "doc", accepted: true }),
      "#0: name is not a non-empty string",
    ],
    ["a missing input", file({ name: "v", check: "isWorkId", accepted: true }), "v: wrong fields"],
    ["an unknown check", file({ ...ok, check: "isWorkID" }), "v: unknown check"],
    ["accepted not a boolean", file({ ...ok, accepted: "true" }), "v: accepted is not a boolean"],
    ["an id on isWorkId", file({ ...ok, id: "doc" }), "v: wrong fields"],
    [
      "an accepted path without id",
      file({ name: "p", check: "workIdFromPath", input: "doc", accepted: true }),
      "p: wrong fields",
    ],
    ["an id on a refused path", file({ ...path, accepted: false }), "p: wrong fields"],
    ["an id not a string", file({ ...path, id: 7 }), "p: id is not a string"],
    ["a path not a string", file({ ...path, input: 7 }), "p: path not a string"],
    ["input and repeat", file({ ...ok, repeat: { text: "d", count: 2 } }), "v: wrong fields"],
    ...[0, 1.5, MAX_REPEAT + 1, "2"].map((count): [string, unknown, string] => [
      `repeat count ${JSON.stringify(count)}`,
      file({ name: "v", check: "isWorkId", repeat: { text: "d", count }, accepted: true }),
      "v: bad repeat",
    ]),
  ])("%s", (_, raw, error) => {
    expect(readVectors(raw)).toEqual({ ok: false, error });
  });

  it("reads a valid file, repeat included", () => {
    const long = { name: "r", check: "isWorkId", repeat: { text: "d", count: 3 }, accepted: true };
    expect(readVectors(file(ok, path, long))).toEqual({
      ok: true,
      vectors: [ok, path, { name: "r", check: "isWorkId", input: "ddd", accepted: true }],
    });
  });
});
