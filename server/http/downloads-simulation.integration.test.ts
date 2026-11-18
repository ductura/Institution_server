// DAN-932 (S-1H.6; UGOVOR Ductus#2028 c.6968257133): the download simulation
// for the four combinations, Windows and macOS on x64 and arm64. A client
// reads the manifest from a real server over HTTP, finds its one row,
// downloads the file at its url and checks the SHA-256 before it would open
// it. Desktop releases do not exist yet, so the packages are fake files of
// invented bytes on a local package server; a root path resolves on it, as
// /preuzimanje/ does on the same address (D-306 t. 1). A wrong hash fails.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabases } from "./databases.ts";
import { createDownloadsManifestRoute } from "./downloads-manifest.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const COMBINATIONS = [
  ["macos", "arm64"],
  ["macos", "x64"],
  ["windows", "arm64"],
  ["windows", "x64"],
] as const;
type Combination = (typeof COMBINATIONS)[number];
type Row = { system: string; architecture: string; version: string; url: string; sha256: string };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const urlOf = ([system, architecture]: Combination) =>
  `/preuzimanje/ductura/1.0.0/ductura-${system}-${architecture}.${system === "macos" ? "dmg" : "msi"}`;
/** Invented bytes, different for every combination. */
const FILES = new Map(
  COMBINATIONS.map((c) => [urlOf(c), Buffer.from(`fake package ${c.join(" ")} 1.0.0\n`)]),
);
const rowOf = (c: Combination, bytes = FILES.get(urlOf(c))!): Row => ({
  system: c[0],
  architecture: c[1],
  version: "1.0.0",
  url: urlOf(c),
  sha256: sha256(bytes),
});

let api: Running | undefined;
let packages: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await api?.close();
  await new Promise((resolve) => (packages ? packages.close(resolve) : resolve(undefined)));
  api = undefined;
  packages = undefined;
});

/** The manifest server over `releases` and a package server over `files`. */
async function start(releases: unknown, files = FILES) {
  api = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createDownloadsManifestRoute(() => releases)],
  });
  packages = createServer((request, response) => {
    const bytes = files.get(request.url ?? "");
    if (bytes === undefined) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
  });
  await new Promise<void>((resolve) => packages!.listen(0, "127.0.0.1", resolve));
  return {
    manifest: `http://127.0.0.1:${api.port}/api/v1/downloads/manifest`,
    origin: `http://127.0.0.1:${(packages.address() as AddressInfo).port}`,
  };
}

type Outcome = { ok: true; sha256: string } | { ok: false; reason: string };
/** The client: one row for its combination, the file at its url, then the SHA-256 check. */
async function download(at: { manifest: string; origin: string }, c: Combination) {
  const answer = await fetch(at.manifest);
  if (answer.status !== 200) return { ok: false, reason: `manifest ${answer.status}` } as Outcome;
  const { packages: rows } = (await answer.json()) as { packages: Row[] };
  const mine = rows.filter((row) => row.system === c[0] && row.architecture === c[1]);
  if (mine.length !== 1) return { ok: false, reason: `${mine.length} rows` } as Outcome;
  const file = await fetch(new URL(mine[0]!.url, at.origin));
  if (file.status !== 200) return { ok: false, reason: `file ${file.status}` } as Outcome;
  const got = sha256(new Uint8Array(await file.arrayBuffer()));
  if (got !== mine[0]!.sha256) return { ok: false, reason: "sha256 mismatch" } as Outcome;
  return { ok: true, sha256: got } as Outcome;
}

describe("the download simulation for the four combinations", () => {
  it.each(COMBINATIONS)("%s %s gets its file with the exact SHA-256", async (...c) => {
    const at = await start({ packages: COMBINATIONS.map((x) => rowOf(x)) });
    const expected = createHash("sha256")
      .update(FILES.get(urlOf(c))!)
      .digest("hex");
    expect(await download(at, c)).toEqual({ ok: true, sha256: expected });
  });

  it("the four files and hashes differ, so a row cannot pass with another's file", () => {
    const hashes = COMBINATIONS.map((c) => rowOf(c).sha256);
    expect(new Set(hashes).size).toBe(4);
  });
});

describe("a wrong hash fails", () => {
  const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

  it.each(COMBINATIONS)("%s %s: the hash of another combination's file", async (...c) => {
    const other = COMBINATIONS.find((x) => x.join() !== c.join())!;
    const rows = COMBINATIONS.map((x) =>
      x.join() === c.join() ? rowOf(x, FILES.get(urlOf(other))) : rowOf(x),
    );
    const at = await start({ packages: rows });
    expect(await download(at, c)).toEqual({ ok: false, reason: "sha256 mismatch" });
  });

  it.each(COMBINATIONS)("%s %s: one hex digit of the hash changed", async (...c) => {
    const rows = COMBINATIONS.map((x) => {
      const row = rowOf(x);
      return x.join() === c.join() ? { ...row, sha256: flip(row.sha256) } : row;
    });
    const at = await start({ packages: rows });
    expect(await download(at, c)).toEqual({ ok: false, reason: "sha256 mismatch" });
  });

  const SERVED = COMBINATIONS.flatMap((c) => [
    [...c, "one byte more", Buffer.concat([FILES.get(urlOf(c))!, Buffer.from("x")])] as const,
    [...c, "cut short", FILES.get(urlOf(c))!.subarray(0, -1)] as const,
  ]);
  it.each(SERVED)("%s %s: a file %s served at the address", async (system, arch, _how, bytes) => {
    const c = [system, arch] as Combination;
    const files = new Map(FILES);
    files.set(urlOf(c), bytes);
    const at = await start({ packages: COMBINATIONS.map((x) => rowOf(x)) }, files);
    expect(await download(at, c)).toEqual({ ok: false, reason: "sha256 mismatch" });
  });

  it.each(COMBINATIONS)("%s %s: no file at the address", async (...c) => {
    const files = new Map(FILES);
    files.delete(urlOf(c));
    const at = await start({ packages: COMBINATIONS.map((x) => rowOf(x)) }, files);
    expect(await download(at, c)).toEqual({ ok: false, reason: "file 404" });
  });

  it("a hash that is not a SHA-256 makes the whole manifest 503, so nothing downloads", async () => {
    const rows = COMBINATIONS.map((x) => rowOf(x));
    rows[2] = { ...rows[2]!, sha256: rows[2]!.sha256.slice(1) };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const at = await start({ packages: rows });
    for (const c of COMBINATIONS) {
      expect(await download(at, c)).toEqual({ ok: false, reason: "manifest 503" });
    }
  });
});
