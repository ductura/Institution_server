import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PACKAGES, TEST_FAKES, type PackageSpec } from "./manifest.ts";
import { compareFiles, packFiles } from "./pack.ts";
import { scanSecrets } from "./secrets.ts";
import { manifestErrors, STAGE_DIR, stagePackage } from "./stage.ts";

// `pnpm release:check` (U10, DAN-742): stages every package and refuses one
// whose tarball differs from its list, whose manifest is not fit to publish,
// that holds something like a secret, or (test-fakes) that loads in production.

/** Exit code and stderr of importing `entry` with NODE_ENV=`nodeEnv` in plain node. */
export function importStaged(entry: string, nodeEnv: string) {
  const code = `await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: nodeEnv },
    encoding: "utf8",
  });
  return { status: run.status, stderr: run.stderr };
}

const GUARD_MESSAGE = "fake OIDC runs only locally and in CI";
// `from` or `import` as a keyword, never as a member such as the generated
// `value['from'] === 'number'` of a body with a `from` field (DAN-818).
const SPECIFIER = /(?<![\w$.]|\[\s*["'])(?:from|import)\s*\(?\s*["']([^"']+)["']/gu;

/** [subpath, target] for every string target of `exports`, at any depth of conditions. */
export function exportTargets(exports: unknown, path = "."): [string, string][] {
  if (typeof exports === "string") return [[path, exports]];
  if (typeof exports !== "object" || exports === null) return [];
  return Object.entries(exports).flatMap(([key, value]) =>
    exportTargets(value, key.startsWith(".") ? key : path),
  );
}

/** Every file under `dir`, as a path relative to it with "/". */
function filesOnDisk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

/**
 * Every import of the packed JavaScript that the installed package could not
 * satisfy: a relative file outside the list, or a package it does not declare.
 */
export function importErrors(
  code: Readonly<Record<string, string>>,
  files: readonly string[],
  dependencies: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(code))
    for (const [, specifier = ""] of text.matchAll(SPECIFIER)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!files.includes(target))
          errors.push(`${path} imports ${specifier}, not in the package`);
        continue;
      }
      const name = specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/");
      if (!dependencies.includes(name)) errors.push(`${path} imports undeclared ${name}`);
    }
  return errors;
}

/** Every problem of the staged package of `spec` in `dir`. */
export function checkStaged(spec: PackageSpec, dir: string): string[] {
  const pack = packFiles(dir)[0];
  const paths = pack.files.map((file) => file.path);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const read = (list: readonly string[]) =>
    Object.fromEntries(list.map((path) => [path, readFileSync(join(dir, path), "utf8")]));
  const errors = [
    ...(pack.name === spec.name ? [] : [`npm pack names ${pack.name}`]),
    ...compareFiles(paths, spec.files),
    ...compareFiles(filesOnDisk(dir), spec.files).map((error) => `on disk: ${error}`),
    ...importErrors(
      read(paths.filter((path) => path.endsWith(".js"))),
      paths,
      Object.keys((manifest.dependencies ?? {}) as object),
    ),
    ...manifestErrors(spec, manifest),
    ...scanSecrets(read(paths)).map((finding) => `${finding.kind} in ${finding.path}`),
  ];
  if (spec === TEST_FAKES) {
    // What a consumer loads: every target of the published exports, not the
    // source entries of the spec.
    const targets = exportTargets(manifest.exports).filter(([, t]) => !t.endsWith(".d.ts"));
    if (targets.length === 0) errors.push("exports nothing to check against the guard");
    for (const [path, target] of targets) {
      const entry = resolve(dir, target);
      if (relative(dir, entry).startsWith("..")) {
        errors.push(`export ${path} points outside the package: ${target}`);
        continue;
      }
      // Refused by the guard, not by some other error.
      const production = importStaged(entry, "production");
      if (production.status === 0 || !production.stderr.includes(GUARD_MESSAGE))
        errors.push(
          `export ${path} (${target}) is not refused by the guard with NODE_ENV=production`,
        );
      const local = importStaged(entry, "test");
      if (local.status !== 0)
        errors.push(`export ${path} (${target}) does not load in test: ${local.stderr}`);
    }
  }
  return errors.map((error) => `${spec.name}: ${error}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stageOnly = process.argv.includes("--stage-only");
  const errors = PACKAGES.flatMap((spec) => {
    const dir = stagePackage(spec, STAGE_DIR);
    return stageOnly ? [] : checkStaged(spec, dir);
  });
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exit(1);
  console.log(`release: ${PACKAGES.map((spec) => spec.name).join(", ")} staged in ${STAGE_DIR}`);
}
