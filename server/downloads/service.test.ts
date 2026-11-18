// DAN-932 (S-1H.5-b; UGOVOR Ductus#2028 c.6968257133): the manifest service
// reads the release configuration and answers it only whole and only as the
// contract's 200 body, by system then architecture, each pair once. Refusals
// first. All values are invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DESKTOP_RELEASES } from "./releases.ts";
import {
  createDownloadsService,
  DOWNLOADS_RELEASES_INVALID as INVALID,
  DOWNLOADS_RELEASES_ORDER as ORDER,
  DOWNLOADS_RELEASES_UNREADABLE as UNREADABLE,
} from "./service.ts";

type Row = Record<string, string>;
const READY = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/downloads.manifest.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: { name: string; response: { body: { packages: Row[] } } }[] }
).vectors.find((v) => v.name === "ready")!.response.body;
const rows = (): Row[] => READY.packages.map((row) => ({ ...row }));
const [A, B, C, D] = rows() as [Row, Row, Row, Row];
const manifestOf = (releases: () => unknown) => createDownloadsService({ releases }).manifest();
const refused = (error: unknown) => ({ ok: false, error });

describe("a release configuration the service cannot read is refused whole", () => {
  const hidden = { ...A };
  Object.defineProperty(hidden, "sha256", { value: A.sha256, enumerable: false });
  const protoKey = JSON.parse(`{"__proto__":{},${JSON.stringify(A).slice(1)}`) as Row;
  const cases: [string, unknown, unknown][] = [
    ["undefined", undefined, INVALID],
    ["null", null, INVALID],
    ["a list", [], INVALID],
    ["a string", JSON.stringify(READY), INVALID],
    ["packages missing", {}, INVALID],
    ["a foreign field", { packages: [], signature: "x" }, INVALID],
    ["five rows", { packages: [A, B, C, D, { ...D }] }, INVALID],
    ["the same pair twice", { packages: [A, { ...A }] }, ORDER],
    ["the same pair twice, other values", { packages: [A, { ...A, version: "1.0.1" }] }, ORDER],
    ["the pairs out of order", { packages: [B, A, C, D] }, ORDER],
    ["systems out of order", { packages: [C, A] }, ORDER],
    ["sha256 of 63 characters", { packages: [{ ...A, sha256: A.sha256!.slice(1) }] }, INVALID],
    ["sha256 in capitals", { packages: [{ ...A, sha256: A.sha256!.toUpperCase() }] }, INVALID],
    ["an unknown system", { packages: [{ ...A, system: "linux" }] }, INVALID],
    ["an http address", { packages: [{ ...A, url: "http://a.example.invalid/x.dmg" }] }, INVALID],
    ["an own __proto__ key", { packages: [protoKey] }, INVALID],
    ["a row whose fields are inherited", { packages: [Object.create(A) as Row] }, INVALID],
    ["a non-enumerable field", { packages: [hidden] }, INVALID],
    ["a function", { packages: [{ ...A, url: () => A.url }] }, UNREADABLE],
    ["a Proxy", { packages: [new Proxy({ ...A }, {})] }, UNREADABLE],
    ["a symbol", { packages: [{ ...A, url: Symbol("x") }] }, UNREADABLE],
    ["a Map", new Map([["packages", []]]), INVALID],
    ["a sparse list", { packages: Object.assign(new Array<Row>(3), { 0: A, 2: C }) }, INVALID],
  ];
  it.each(cases)("%s", (_name, releases, error) => {
    expect(manifestOf(() => releases)).toEqual(refused(error));
  });

  it("a configuration that throws, or a getter that throws", () => {
    const no = () => {
      throw new Error("no file");
    };
    expect(manifestOf(no)).toEqual(refused(UNREADABLE));
    const row = { ...A };
    Object.defineProperty(row, "url", { get: no, enumerable: true });
    expect(manifestOf(() => ({ packages: [row] }))).toEqual(refused(UNREADABLE));
  });

  it("a getter is read once, as a value, never trusted as a field", () => {
    let reads = 0;
    const row = { ...A };
    Object.defineProperty(row, "version", {
      get: () => (++reads === 1 ? "1.0.0" : "x"),
      enumerable: true,
    });
    const got = manifestOf(() => ({ packages: [row] }));
    expect(got).toEqual({ ok: true, value: { packages: [A] } });
    expect(reads).toBe(1);
  });
});

describe("a readable release configuration", () => {
  it("is the ready vector, the same fields in the same order", () => {
    const got = manifestOf(() => ({ packages: rows() }));
    expect(got).toEqual({ ok: true, value: READY });
    expect(got.ok && JSON.stringify(got.value)).toBe(JSON.stringify(READY));
  });

  it("is a copy: changing the configuration later never changes an answer", () => {
    const packages = rows();
    const got = manifestOf(() => ({ packages }));
    packages[0]!.sha256 = "0".repeat(64);
    packages.pop();
    expect(got).toEqual({ ok: true, value: READY });
  });

  it("is read on every call, so a later configuration is answered", () => {
    let releases: unknown = { packages: [] };
    const service = createDownloadsService({ releases: () => releases });
    expect(service.manifest()).toEqual({ ok: true, value: { packages: [] } });
    releases = { packages: [B] };
    expect(service.manifest()).toEqual({ ok: true, value: { packages: [B] } });
  });

  it("any subset in order", () => {
    expect(manifestOf(() => ({ packages: [A, D] }))).toEqual({
      ok: true,
      value: { packages: [A, D] },
    });
  });

  it("the built-in configuration is the default, is readable and is frozen", () => {
    // A guard for every later release: whatever it adds must stay readable.
    expect(createDownloadsService().manifest().ok).toBe(true);
    expect(createDownloadsService().manifest()).toEqual(manifestOf(() => DESKTOP_RELEASES));
    expect(Object.isFrozen(DESKTOP_RELEASES)).toBe(true);
    expect(Object.isFrozen((DESKTOP_RELEASES as { packages: unknown }).packages)).toBe(true);
  });

  it("no desktop release yet", () => {
    expect(createDownloadsService().manifest()).toEqual({ ok: true, value: { packages: [] } });
  });
});
