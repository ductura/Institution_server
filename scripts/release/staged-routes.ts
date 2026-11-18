import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Files } from "./level.ts";

// DAN-974-4a: the routes the published fake server of @ductura/test-fakes
// really exports. The staged package is written outside the repository and its
// module runs in a separate `node` process that may only read that folder, with
// no environment but PATH; the snapshot is ROUTE_TABLE right after the import.
// Threat model: an accidental change of the generator or the code, not an
// attack (code on main has already passed the gate).

export const ROUTES_JS = "server/contracts/generated/fake-server/index.js";
/** The public entry re-exports the fake server; a local ROUTE_TABLE in it would shadow it. */
export const PUBLIC_ROUTES_JS = "packages/test-fakes/fake-server/index.js";

/** Route id → canonical JSON of its row. */
export type Snapshot = ReadonlyMap<string, string>;

// Runs in the child. Everything it relies on is taken before the module is
// imported, since the module may replace globals. Data only: strings, finite
// numbers (not -0), booleans, null, plain arrays without holes and plain
// objects, every property an enumerable data property with a string key.
// Objects are written as sorted [key, value] pairs, so field order does not count.
const CHILD = String.raw`
const { ownKeys, getPrototypeOf } = Reflect;
const describe = Object.getOwnPropertyDescriptor;
const { isProxy } = (await import("node:util")).types;
const { pathToFileURL } = await import("node:url");
const stringify = JSON.stringify;
const isArray = Array.isArray;
const finite = Number.isFinite;
const same = Object.is;
const OBJECT = Object.prototype;
const ARRAY = Array.prototype;
const Failure = Error;
const { writeSync } = await import("node:fs");
// The snapshot has a channel of its own (fd 3): whatever the module prints is not it.
const write = (text) => writeSync(3, text);
const fail = (why) => { throw new Failure(why); };
const fields = (value, at) => {
  const out = [];
  for (const key of ownKeys(value)) {
    if (typeof key !== "string") fail(at + ": symbol key");
    if (isArray(value) && key === "length") continue;
    const d = describe(value, key);
    if (!("value" in d) || !d.enumerable) fail(at + "." + key + ": not an enumerable data property");
    out.push([key, d.value]);
  }
  return out;
};
const data = (value, at) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value) && !same(value, -0) ? value : fail(at + ": number");
  if (typeof value !== "object") return fail(at + ": " + typeof value);
  if (isProxy(value)) fail(at + ": Proxy");
  const proto = getPrototypeOf(value);
  if (isArray(value)) {
    if (proto !== ARRAY) fail(at + ": array prototype");
    const items = fields(value, at);
    items.forEach(([key], i) => key === String(i) || fail(at + ": array hole or extra key"));
    if (items.length !== value.length) fail(at + ": array hole");
    return ["a", items.map(([key, item]) => data(item, at + "." + key))];
  }
  if (proto !== OBJECT && proto !== null) fail(at + ": not a plain object");
  const pairs = fields(value, at).map(([key, item]) => [key, data(item, at + "." + key)]);
  return ["o", pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))];
};
const ns = await import(pathToFileURL(process.argv[1]).href);
if (!("ROUTE_TABLE" in ns)) fail("no ROUTE_TABLE");
const table = data(ns.ROUTE_TABLE, "ROUTE_TABLE");
if (table[0] !== "o") fail("ROUTE_TABLE is not an object");
write(stringify(table[1].map(([id, row]) => [id, stringify(row)])));
`;

/** The routes of the fake server in `files`; any failure throws, so the level is blocked. */
export function stagedRoutes(files: Files, timeout = 20_000): Snapshot {
  const dir = mkdtempSync(join(tmpdir(), "staged-routes-"));
  try {
    for (const [path, content] of files) {
      if (path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
        throw new Error(`fake server routes: unsafe path ${path}`);
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const run = spawnSync(
      process.execPath,
      [
        `--permission`,
        `--allow-fs-read=${dir}`,
        "--input-type=module",
        "-e",
        CHILD,
        join(dir, ROUTES_JS),
      ],
      {
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "" },
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        // stdout is ignored; the snapshot comes on fd 3.
        stdio: ["ignore", "ignore", "pipe", "pipe"],
      },
    );
    if (run.error !== undefined || run.signal !== null || run.status !== 0)
      throw new Error(
        `fake server routes: ${run.signal ?? run.error?.message ?? run.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
    return snapshot(String(run.output[3] ?? ""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A row as the child writes it: a plain object, ["o", sorted pairs]. */
const isRow = (text: string): boolean => {
  const row: unknown = JSON.parse(text);
  return Array.isArray(row) && row.length === 2 && row[0] === "o" && Array.isArray(row[1]);
};

function snapshot(text: string): Snapshot {
  const pairs: unknown = JSON.parse(text);
  if (!Array.isArray(pairs)) throw new Error("fake server routes: not a snapshot");
  const out = new Map<string, string>();
  for (const pair of pairs as unknown[]) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    )
      throw new Error("fake server routes: not a snapshot");
    if (out.has(pair[0])) throw new Error(`fake server routes: ${pair[0]} twice`);
    if (!isRow(pair[1])) throw new Error(`fake server routes: ${pair[0]} is not an object`);
    out.set(pair[0], pair[1]);
  }
  return out;
}
