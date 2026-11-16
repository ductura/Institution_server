import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions, parseVersion } from "./level.ts";
import { CONTRACTS, TEST_FAKES, type PackageSpec } from "./manifest.ts";
import { ROOT } from "./stage.ts";

// `pnpm release:tag` (U10-b, DAN-742): the first step of publish.yml. The tag
// name is outside input (git allows `$`, `(` and `;`, and the trigger glob lets
// them through), so it is matched in full before anything uses it, and only
// the package's short name reaches $GITHUB_OUTPUT.

const TAG = /^(contracts|test-fakes)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SPECS: Readonly<Record<string, PackageSpec>> = {
  contracts: CONTRACTS,
  "test-fakes": TEST_FAKES,
};

export type TagInput = {
  readonly ref: string | undefined;
  readonly refName: string | undefined;
  readonly sha: string | undefined;
  /** `version` of the source package.json of `spec`. */
  readonly version: (spec: PackageSpec) => string;
  /** info.version of openapi/v1.json, the API_VERSION. */
  readonly apiVersion: string;
  /** Whether `sha` is an ancestor of origin/main; throws when git cannot tell. */
  readonly onMain: (sha: string) => boolean;
};

/** The short name of the package the tag publishes, or an error naming why not. */
export function checkTag(input: TagInput): "contracts" | "test-fakes" {
  const name = input.refName ?? "";
  const match = TAG.exec(name);
  if (match === null) throw new Error("tag: name is not <contracts|test-fakes>-vX.Y.Z");
  if (input.ref !== `refs/tags/${name}`) throw new Error("tag: GITHUB_REF is not this tag");
  const [, short = "", version = ""] = match;
  const spec = SPECS[short]!;
  // DAN-804 (b): the tag carries the version; package.json is the floor of its major.
  const floor = parseVersion(input.version(spec));
  const tagged = parseVersion(version)!;
  if (floor === null || floor[0] !== tagged[0] || compareVersions(tagged, floor) < 0)
    throw new Error(
      `tag: version ${version} is below or off the major of ${spec.dir}/package.json`,
    );
  // DAN-869: the contracts major follows breaking changes of the TypeScript types,
  // not of the wire, so it may be above the API major but never below it.
  if (spec === CONTRACTS) {
    const api = parseVersion(input.apiVersion);
    if (api === null) throw new Error(`tag: API_VERSION ${input.apiVersion} is not X.Y.Z`);
    if (tagged[0] < api[0])
      throw new Error(
        `tag: major ${tagged[0]} is below the major of API_VERSION ${input.apiVersion}`,
      );
  }
  const sha = input.sha ?? "";
  if (!SHA.test(sha)) throw new Error("tag: GITHUB_SHA is not a full commit SHA");
  if (!input.onMain(sha)) throw new Error("tag: commit is not on main");
  return short as "contracts" | "test-fakes";
}

/**
 * `git merge-base --is-ancestor`, without a shell: 0 yes, 1 no, anything else
 * fails. The full ref, since a tag named origin/main would win over the short name.
 */
export function isAncestorOfMain(sha: string, cwd = ROOT): boolean {
  const main = "refs/remotes/origin/main";
  const run = spawnSync("git", ["merge-base", "--is-ancestor", sha, main], { cwd });
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  throw new Error(`tag: git merge-base failed (${String(run.status)})`);
}

type Json = { version?: unknown; info?: { version?: unknown } };
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Json;

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const short = checkTag({
    ref: process.env.GITHUB_REF,
    refName: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
    version: (spec) => String(readJson(join(ROOT, spec.dir, "package.json")).version),
    apiVersion: String(readJson(join(ROOT, "openapi", "v1.json")).info?.version),
    onMain: (sha) => isAncestorOfMain(sha),
  });
  // The version is the tag's, matched by TAG above.
  const version = String(process.env.GITHUB_REF_NAME).slice(short.length + 2);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `package=${short}\nversion=${version}\n`);
  console.log(`release: tag publishes ${SPECS[short]!.name}`);
}
