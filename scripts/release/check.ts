import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Every problem of the staged package of `spec` in `dir`. */
export function checkStaged(spec: PackageSpec, dir: string): string[] {
  const pack = packFiles(dir)[0];
  const paths = pack.files.map((file) => file.path);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const errors = [
    ...(pack.name === spec.name ? [] : [`npm pack names ${pack.name}`]),
    ...compareFiles(paths, spec.files),
    ...manifestErrors(spec, manifest),
    ...scanSecrets(
      Object.fromEntries(paths.map((path) => [path, readFileSync(join(dir, path), "utf8")])),
    ).map((finding) => `${finding.kind} in ${finding.path}`),
  ];
  if (spec === TEST_FAKES) {
    for (const file of Object.values(spec.exports)) {
      const entry = join(dir, file.replace(/\.ts$/u, ".js"));
      if (importStaged(entry, "production").status === 0)
        errors.push(`${file} loads with NODE_ENV=production`);
      const local = importStaged(entry, "test");
      if (local.status !== 0) errors.push(`${file} does not load in test: ${local.stderr}`);
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
