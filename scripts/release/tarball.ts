import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { checkStaged } from "./check.ts";
import { CONTRACTS, TEST_FAKES, type PackageSpec } from "./manifest.ts";
import { compareFiles, npmCliPath, parsePackOutput } from "./pack.ts";
import { releaseVersion, ROOT, STAGE_DIR, stagePackage } from "./stage.ts";

// `pnpm release:tarball <contracts|test-fakes>...` (U10-b, DAN-742): packs the
// staged package for real, unpacks those exact bytes and runs the whole
// checkStaged of U10-a over them, then prints the sha256 that publish.yml
// checks before `npm publish` of the same file. Nothing is published here.

export const TARBALL_DIR = join(STAGE_DIR, "tarball");
const EXTRACT_DIR = join(STAGE_DIR, "extracted");
const SPECS: Readonly<Record<string, PackageSpec>> = {
  contracts: CONTRACTS,
  "test-fakes": TEST_FAKES,
};
// Inside package/, relative, no "..", no backslash: what a regular file may be.
const ENTRY = /^package\/(?!(?:.*\/)?\.\.?(?:\/|$))[^\\]+$/u;

const field = (header: Buffer, start: number, length: number) =>
  header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/su, "");

/**
 * Every entry of a gzipped ustar archive as path (without "package/") → bytes,
 * read as strictly as npm's tar would agree with: every header has its
 * checksum and the ustar magic, only regular files under package/, no path
 * twice, and nothing but zeros after the first zero block. A link, directory,
 * pax or GNU header, an absolute path or ".." refuses the archive.
 */
export function readTarball(gzipped: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gzipped);
  const files = new Map<string, Buffer>();
  let offset = 0;
  for (; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 155);
    const path = prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`;
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (Number.parseInt(field(header, 148, 8).trim() || "x", 8) !== sum)
      throw new Error(`tarball: ${path} has a bad checksum`);
    if (header.subarray(257, 265).toString("latin1") !== "ustar\u000000")
      throw new Error(`tarball: ${path} is not a ustar header`);
    const type = field(header, 156, 1);
    const size = Number.parseInt(field(header, 124, 12).trim() || "x", 8);
    if (type !== "0" && type !== "") throw new Error(`tarball: ${path} is not a regular file`);
    if (!ENTRY.test(path)) throw new Error(`tarball: entry ${path} is outside package/`);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length)
      throw new Error(`tarball: ${path} has a bad size`);
    const name = path.slice("package/".length);
    if (files.has(name)) throw new Error(`tarball: ${path} appears twice`);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!tar.subarray(offset).every((byte) => byte === 0))
    throw new Error("tarball: data after the end of the archive");
  return files;
}

/** `npm pack` of `dir` into `out`, without a shell; the path of the tarball. */
export function packTarball(spec: PackageSpec, dir: string, out: string, release?: string): string {
  const cli = npmCliPath({
    execPath: process.execPath,
    platform: process.platform,
    npmExecPath: process.env.npm_execpath,
    exists: existsSync,
  });
  const args = [cli, "pack", "--json", "--ignore-scripts", "--pack-destination", out];
  const run = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`npm pack failed in ${dir}: ${run.stderr}`);
  const [result] = parsePackOutput(run.stdout);
  const version = releaseVersion(
    String(
      (
        JSON.parse(readFileSync(join(ROOT, spec.dir, "package.json"), "utf8")) as {
          version?: unknown;
        }
      ).version,
    ),
    release,
  );
  const errors = [
    ...(result.name === spec.name ? [] : [`npm pack names ${result.name}`]),
    ...(result.version === version ? [] : [`npm pack version ${result.version} is not ${version}`]),
    ...compareFiles(
      result.files.map((file) => file.path),
      spec.files,
    ),
  ];
  if (errors.length > 0) throw new Error(errors.map((e) => `${spec.name}: ${e}`).join("\n"));
  return join(out, `${spec.name.slice(1).replace("/", "-")}-${version}.tgz`);
}

/** Every problem of the tarball `bytes` of `spec`, checked as unpacked into `into`. */
export function checkTarball(spec: PackageSpec, bytes: Buffer, into: string): string[] {
  rmSync(into, { recursive: true, force: true });
  for (const [path, body] of readTarball(bytes)) {
    mkdirSync(dirname(join(into, path)), { recursive: true });
    writeFileSync(join(into, path), body);
  }
  return checkStaged(spec, into);
}

/** Stages, packs and checks `spec`: the tarball, its file name and sha256. */
export function buildTarball(spec: PackageSpec, out = TARBALL_DIR, version?: string) {
  const short = spec.name.slice("@ductura/".length);
  const path = packTarball(spec, stagePackage(spec, STAGE_DIR, version), out, version);
  // One read: the bytes checked are the bytes hashed.
  const bytes = readFileSync(path);
  const errors = checkTarball(spec, bytes, join(EXTRACT_DIR, short));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path, file: path.slice(out.length + 1), sha256 };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  if (names.length === 0 || names.some((name) => SPECS[name] === undefined))
    throw new Error("usage: release:tarball <contracts|test-fakes>...");
  // DAN-804: publish.yml passes the tag's version for its one package.
  const version = process.env.RELEASE_VERSION || undefined;
  if (version !== undefined && names.length !== 1)
    throw new Error("release:tarball: RELEASE_VERSION is for one package");
  rmSync(TARBALL_DIR, { recursive: true, force: true });
  mkdirSync(TARBALL_DIR, { recursive: true });
  const built = names.map((name) => buildTarball(SPECS[name]!, TARBALL_DIR, version));
  for (const { file, sha256 } of built) console.log(`release: ${sha256}  ${file}`);
  if (process.env.GITHUB_OUTPUT && built.length === 1)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `file=${built[0]!.file}\nsha256=${built[0]!.sha256}\n`,
    );
}
