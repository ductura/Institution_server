import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildTarball,
  checkTarball,
  CONTRACTS,
  packTarball,
  readTarball,
  stagePackage,
  TEST_FAKES,
} from "./index.ts";
import { ROOT } from "./stage.ts";

// U10-b (DAN-742): the tarball publish.yml publishes is the tarball checked.
// Inside the repository, so the unpacked test-fakes resolve oidc-provider.
mkdirSync(join(ROOT, "dist"), { recursive: true });
const TMP = mkdtempSync(join(ROOT, "dist", "tarball-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

type Entry = readonly [path: string, body: string | Buffer, type?: string];

/** A ustar header for `path`, with its checksum. */
function header(path: string, size: number, type = "0", magic = "ustar\u000000"): Buffer {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100);
  block.write(size.toString(8).padStart(11, "0"), 124);
  block.write(type, 156);
  block.write(magic, 257, "latin1");
  block.fill(32, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "latin1");
  return block;
}

/** The blocks of one entry: header and padded body. */
function entry([path, body, type = "0"]: Entry): Buffer {
  const data = Buffer.from(body);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(path, data.length, type), data, padding]);
}

/** A gzipped ustar archive of `entries`, as npm writes one. */
const tarball = (entries: readonly Entry[], end = Buffer.alloc(1024)) =>
  gzipSync(Buffer.concat([...entries.map(entry), end]));

let run = 0;
const dir = () => join(TMP, String((run += 1)));

describe("readTarball", () => {
  it("reads regular files under package/", () => {
    const files = readTarball(
      tarball([
        ["package/a/b.js", "x"],
        ["package/c.json", "{}"],
      ]),
    );
    expect([...files.keys()]).toEqual(["a/b.js", "c.json"]);
    expect(files.get("a/b.js")?.toString()).toBe("x");
  });

  it.each<[string, Entry]>([
    ["a symlink", ["package/link.js", "", "2"]],
    ["a hard link", ["package/link.js", "", "1"]],
    ["a directory", ["package/dir/", "", "5"]],
    ["a pax header", ["package/PaxHeader", "", "x"]],
    ["a path outside package/", ["other/a.js", "x"]],
    ["an absolute path", ["/package/a.js", "x"]],
    ["..", ["package/../a.js", "x"]],
    [". as a segment", ["package/./a.js", "x"]],
    ["a backslash", ["package/a\\b.js", "x"]],
  ])("refuses %s", (_, entry) => {
    expect(() => readTarball(tarball([["package/ok.js", "x"], entry]))).toThrow(/^tarball: /);
  });

  it("refuses a path given twice and a size past the end", () => {
    const twice = tarball([
      ["package/a.js", "x"],
      ["package/a.js", "y"],
    ]);
    expect(() => readTarball(twice)).toThrow(/appears twice/);
    const long = header("package/a.js", 512);
    expect(() => readTarball(gzipSync(long))).toThrow(/bad size/);
  });

  // What npm's tar reads past: a bad checksum, another magic, a lone zero block.
  it("refuses a bad checksum, a header that is not ustar, and data after a zero block", () => {
    const bad = entry(["package/a.js", "x"]);
    bad[148] = 0x37;
    expect(() => readTarball(gzipSync(Buffer.concat([bad, Buffer.alloc(1024)])))).toThrow(
      /bad checksum/,
    );
    const gnu = Buffer.concat([
      header("package/a.js", 0, "0", "ustar  \u0000"),
      Buffer.alloc(1024),
    ]);
    expect(() => readTarball(gzipSync(gnu))).toThrow(/not a ustar header/);
    const hidden = Buffer.concat([
      Buffer.alloc(512),
      entry(["package/a.js", "evil"]),
      Buffer.alloc(1024),
    ]);
    expect(() => readTarball(tarball([["package/a.js", "x"]], hidden))).toThrow(
      /data after the end/,
    );
  });
});

describe("packTarball", () => {
  it.each([
    ["version", "9.9.9", /npm pack version 9\.9\.9 is not/],
    ["name", "@ductura/other", /npm pack names @ductura\/other/],
  ])("refuses a staged package whose %s is not the source", (key, value, error) => {
    const staged = stagePackage(CONTRACTS, dir());
    const path = join(staged, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, [key]: value }));
    const out = dir();
    mkdirSync(out, { recursive: true });
    expect(() => packTarball(CONTRACTS, staged, out)).toThrow(error);
  });
});

describe("buildTarball", () => {
  const built = [CONTRACTS, TEST_FAKES].map((spec) => ({ spec, ...buildTarball(spec, TMP) }));

  it.each(built.map((b) => [b.spec.name, b] as const))(
    "%s: the real tarball passes the whole check and has a sha256",
    (_, { spec, file, sha256, path }) => {
      expect(file).toMatch(/^ductura-(contracts|test-fakes)-\d+\.\d+\.\d+\.tgz$/);
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect([...readTarball(readFileSync(path)).keys()].sort()).toEqual(spec.files);
    },
  );

  /** The tarball of `spec` with `change` applied to its files. */
  function changed(spec = TEST_FAKES, change: (files: Map<string, Buffer>) => void): Buffer {
    const { path } = built.find((b) => b.spec === spec)!;
    const files = readTarball(readFileSync(path));
    change(files);
    return tarball([...files].map(([name, body]) => [`package/${name}`, body]));
  }

  it("refuses an extra file in the tarball", () => {
    const file = changed(CONTRACTS, (files) => files.set(".env", Buffer.from("A=1\n")));
    expect(checkTarball(CONTRACTS, file, dir())).toContain(
      "@ductura/contracts: on disk: unexpected file .env",
    );
  });

  it("refuses a tarball with a private key in a listed file", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    const file = changed(CONTRACTS, (files) => files.set("README.md", Buffer.from(key)));
    expect(checkTarball(CONTRACTS, file, dir()).join("\n")).toMatch(/README\.md/);
  });

  it("refuses a test-fakes tarball whose entry loads in production", () => {
    const entry = "packages/test-fakes/clock/index.js";
    const file = changed(TEST_FAKES, (files) => files.set(entry, Buffer.from("export {};\n")));
    expect(checkTarball(TEST_FAKES, file, dir())).toContain(
      "@ductura/test-fakes: export ./clock (./packages/test-fakes/clock/index.js) is not refused by the guard with NODE_ENV=production",
    );
  });
});
