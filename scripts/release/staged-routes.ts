import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Files } from "./level.ts";

// DAN-974-4a/4c: the routes the published fake server of @ductura/test-fakes
// really exports. The staged package is written outside the repository and the
// public entry is imported as a consumer imports it (NODE_ENV=test, the guard
// first), in a separate `node` process that may only read that folder and the
// installed dependencies, with no environment but PATH and NODE_ENV; the
// snapshot is ROUTE_TABLE right after the import. The module is the output of
// our own build at the tag and HEAD, not an attacker's code.

export const ROUTES_JS = "server/contracts/generated/fake-server/index.js";
/** The public entry a consumer imports: the guard, then a re-export of the fake server. */
export const PUBLIC_ROUTES_JS = "packages/test-fakes/fake-server/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/**
 * The installed dependencies of test-fakes (oidc-provider for the guard),
 * linked into the staged folder and read only (DAN-974-4c). pnpm links them
 * into the store under the root node_modules, which is readable too.
 */
const MODULES = join(ROOT, "packages", "test-fakes", "node_modules");
const STORE = join(ROOT, "node_modules");

/** Route id → canonical JSON of its row. */
export type Snapshot = ReadonlyMap<string, string>;

// Runs in the child. The module under the snapshot is the output of our own
// build at the tag and at HEAD, not an attacker's code (DAN-974-4b). Still,
// everything the reader uses after the import is taken before it: built-in
// functions, prototypes and the output channel. After the import it calls no
// method through a prototype (no for-of, no destructuring, no array methods),
// reads properties only through own descriptors, and builds its output in
// arrays without a prototype. Data only: strings, finite numbers (not -0),
// booleans, null, plain arrays without holes and plain objects, every
// property an own enumerable data property with a string key. Objects are
// written as sorted [key, value] pairs, so field order does not count.
const CHILD = String.raw`
const { ownKeys, getPrototypeOf } = Reflect;
const setPrototypeOf = Object.setPrototypeOf;
const describe = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const { isProxy } = (await import("node:util")).types;
const { pathToFileURL } = await import("node:url");
const { writeSync } = await import("node:fs");
const stringify = JSON.stringify;
const isArray = Array.isArray;
const finite = Number.isFinite;
const same = Object.is;
const OBJECT = Object.prototype;
const ARRAY = Array.prototype;
const Failure = Error;
const file = pathToFileURL(process.argv[1]).href;
// The snapshot has a channel of its own (fd 3): whatever the module prints is not it.
const write = (text) => writeSync(3, text);
const fail = (why) => { throw new Failure(why); };
const list = () => setPrototypeOf([], null);
const add = (out, item) => { out[out.length] = item; };
const fields = (value, at) => {
  const out = list();
  const keys = ownKeys(value);
  const array = isArray(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== "string") fail(at + ": symbol key");
    if (array && key === "length") continue;
    const d = describe(value, key);
    // Own fields of the descriptor only: an inherited value, get or set does not count.
    if (!hasOwn(d, "value") || hasOwn(d, "get") || hasOwn(d, "set") || d.enumerable !== true)
      fail(at + "." + key + ": not an enumerable data property");
    const pair = list();
    add(pair, key);
    add(pair, d.value);
    add(out, pair);
  }
  return out;
};
const sorted = (pairs) => {
  for (let i = 1; i < pairs.length; i++)
    for (let j = i; j > 0 && pairs[j - 1][0] > pairs[j][0]; j--) {
      const swap = pairs[j];
      pairs[j] = pairs[j - 1];
      pairs[j - 1] = swap;
    }
  return pairs;
};
const tagged = (tag, items) => {
  const out = list();
  add(out, tag);
  add(out, items);
  return out;
};
const data = (value, at) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value) && !same(value, -0) ? value : fail(at + ": number");
  if (typeof value !== "object") return fail(at + ": " + typeof value);
  if (isProxy(value)) fail(at + ": Proxy");
  const proto = getPrototypeOf(value);
  const items = fields(value, at);
  const out = list();
  if (isArray(value)) {
    if (proto !== ARRAY) fail(at + ": array prototype");
    if (items.length !== describe(value, "length").value) fail(at + ": array hole");
    for (let i = 0; i < items.length; i++) {
      if (items[i][0] !== "" + i) fail(at + ": array hole or extra key");
      add(out, data(items[i][1], at + "." + i));
    }
    return tagged("a", out);
  }
  if (proto !== OBJECT && proto !== null) fail(at + ": not a plain object");
  for (let i = 0; i < items.length; i++) {
    const pair = list();
    add(pair, items[i][0]);
    add(pair, data(items[i][1], at + "." + items[i][0]));
    add(out, pair);
  }
  return tagged("o", sorted(out));
};
const ns = await import(file);
const exported = describe(ns, "ROUTE_TABLE");
if (exported === undefined) fail("no ROUTE_TABLE");
const table = data(exported.value, "ROUTE_TABLE");
if (table[0] !== "o") fail("ROUTE_TABLE is not an object");
const rows = list();
for (let i = 0; i < table[1].length; i++) {
  const pair = list();
  add(pair, table[1][i][0]);
  add(pair, stringify(table[1][i][1]));
  add(rows, pair);
}
write(stringify(rows));
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
    symlinkSync(MODULES, join(dir, "node_modules"), "dir");
    // The public entry, as a consumer loads it: the guard (and what it imports) runs first.
    const run = spawnSync(
      process.execPath,
      [
        `--permission`,
        `--allow-fs-read=${dir}`,
        `--allow-fs-read=${MODULES}`,
        `--allow-fs-read=${STORE}`,
        "--input-type=module",
        "-e",
        CHILD,
        join(dir, PUBLIC_ROUTES_JS),
      ],
      {
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" },
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
