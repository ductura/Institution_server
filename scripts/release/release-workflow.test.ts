import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

// DAN-804: release.yml as GitHub reads it, against exact allow lists, in the
// style of the invariant 5 test of publish.yml (workflow.test.ts).
const ROOT = resolve(import.meta.dirname, "../..");
const RELEASE = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");

type Node = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value: unknown) => Object.keys((value ?? {}) as Node).join(",");

function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, path === "" ? key : `${path}.${key}`),
  );
}

const TOKEN = "${{ secrets.GITHUB_TOKEN }}";
const EXPRESSIONS: Readonly<Record<string, string>> = {
  "jobs.level.outputs.releases": "${{ steps.level.outputs.releases }}",
  "jobs.level.outputs.stopped": "${{ steps.level.outputs.stopped }}",
  "jobs.tag.steps.0.env.RELEASES": "${{ needs.level.outputs.releases }}",
  "jobs.tag.steps.0.env.GH_TOKEN": TOKEN,
  "jobs.tag.steps.0.env.REPO": "${{ github.repository }}",
  "jobs.tag.steps.0.env.SHA": "${{ github.sha }}",
  "jobs.report.steps.0.env.STOPPED": "${{ needs.level.outputs.stopped }}",
  "jobs.report.steps.0.env.GH_TOKEN": TOKEN,
  "jobs.report.steps.0.env.REPO": "${{ github.repository }}",
  "jobs.report.steps.0.env.SHA": "${{ github.sha }}",
  "jobs.report.steps.0.env.RUN": "${{ github.run_id }}",
};
const PERMISSIONS = {
  level: { contents: "read" },
  tag: { contents: "write", actions: "write" },
  report: { contents: "read", "pull-requests": "write" },
};
const LEVEL_USES = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
];
const STEP_KEYS = ["name", "id", "uses", "with", "env", "run"];

/** Every rule release.yml breaks. */
export function releaseErrors(text: string): string[] {
  const errors: string[] = [];
  let doc: Node;
  try {
    doc = parse(text, { uniqueKeys: true, merge: false }) as Node;
  } catch (error) {
    return [`not YAML: ${String(error)}`];
  }
  const jobs = (doc.jobs ?? {}) as Record<string, Node>;
  if (keys(doc) !== "name,on,permissions,concurrency,jobs") errors.push(`top: ${keys(doc)}`);
  if (!same(doc.on, { push: { branches: ["main"] } })) errors.push("trigger is not push to main");
  if (!same(doc.permissions, {})) errors.push("top permissions are not {}");
  if (!same(doc.concurrency, { group: "auto-release", "cancel-in-progress": false }))
    errors.push("runs are not serialized");
  if (keys(jobs) !== "level,tag,report") errors.push(`jobs: ${keys(jobs)}`);
  for (const [name, permissions] of Object.entries(PERMISSIONS))
    if (!same(jobs[name]?.permissions, permissions)) errors.push(`${name} permissions`);
  if (!same(jobs.tag?.needs, "level") || !same(jobs.report?.needs, "level"))
    errors.push("tag or report does not need level");
  if (jobs.tag?.if !== "needs.level.outputs.releases != ''") errors.push("tag condition");
  if (jobs.report?.if !== "needs.level.outputs.stopped != ''") errors.push("report condition");
  for (const [path, value] of strings(doc)) {
    if (value.includes("${{") && EXPRESSIONS[path] !== value)
      errors.push(`expression at ${path}: ${value}`);
    if (/secrets\.|github\.token/u.test(value) && EXPRESSIONS[path] !== TOKEN)
      errors.push(`token at ${path}`);
  }
  for (const [, uses = ""] of text.matchAll(/^\s*(?:- )?uses: (.*)$/gmu))
    if (!/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u.test(uses))
      errors.push(`not pinned: ${uses}`);
  for (const [name, job] of Object.entries(jobs)) {
    const steps = (job.steps ?? []) as Node[];
    for (const [i, step] of steps.entries())
      if (Object.keys(step).some((key) => !STEP_KEYS.includes(key)))
        errors.push(`${name} step ${i}: ${keys(step)}`);
    // Only level checks out and runs code of this repository.
    if (name !== "level" && (steps.length !== 1 || steps[0]?.uses !== undefined))
      errors.push(`${name} is not one gh step`);
  }
  const level = (jobs.level?.steps ?? []) as Node[];
  if (
    !same(
      level.slice(0, 3).map((s) => s.uses),
      LEVEL_USES,
    )
  )
    errors.push("level actions");
  if (!same(level[0]?.with, { "fetch-depth": 0, "persist-credentials": false }))
    errors.push("level checkout keeps credentials");
  const runs = level.flatMap((s) => (s.run === undefined ? [] : [s.run]));
  if (!same(runs, ["pnpm install --frozen-lockfile", "pnpm release:level"]))
    errors.push(`level runs: ${runs.join(" | ")}`);
  const tagRun = String(((jobs.tag?.steps ?? []) as Node[])[0]?.run ?? "");
  for (const needed of [
    '[ "$tip" != "$SHA" ]',
    '"repos/$REPO/git/refs" -f "ref=refs/tags/$tag"',
    '"repos/$REPO/actions/workflows/publish.yml/dispatches" -f "ref=$tag"',
  ])
    if (!tagRun.includes(needed)) errors.push(`tag run without ${needed}`);
  if (/-f "force|PATCH|-X DELETE|git push/u.test(tagRun)) errors.push("tag may move or delete");
  // Defence in depth: every value is matched before use, and a stop fails the run.
  const reportRun = String(((jobs.report?.steps ?? []) as Node[])[0]?.run ?? "");
  for (const [run, needed] of [
    [tagRun, '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]'],
    [
      tagRun,
      '[[ "$tag" =~ ^(contracts|test-fakes)-v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]',
    ],
    [reportRun, '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]'],
    [reportRun, '[[ "$RUN" =~ ^[0-9]+$ ]]'],
    [
      reportRun,
      "stopped_re='^(contracts|test-fakes):(major|blocked)( (contracts|test-fakes):(major|blocked))?$'",
    ],
    [reportRun, '[[ "$STOPPED" =~ $stopped_re ]]'],
    [reportRun, 'if [[ "$pr" =~ ^[0-9]+$ ]]; then'],
    [reportRun, "exit 1"],
  ] as const)
    if (!run.split("\n").some((line) => line.trim() === needed || line.trim().startsWith(needed)))
      errors.push(`run without ${needed}`);
  return errors;
}

describe("release.yml", () => {
  it("keeps every rule", () => {
    expect(releaseErrors(RELEASE)).toEqual([]);
  });

  const replace = (from: string, to: string) => {
    expect(RELEASE, from).toContain(from);
    return RELEASE.replace(from, to);
  };
  const branches = "    branches: [main]\n";
  const tagPermissions = "      contents: write\n      actions: write\n";

  it.each([
    ["pull_request_target", branches, `${branches}  pull_request_target:\n`],
    ["workflow_dispatch", branches, `${branches}  workflow_dispatch:\n`],
    ["another branch", "[main]", "[main, dev]"],
    ["cancel-in-progress", "cancel-in-progress: false", "cancel-in-progress: true"],
    ["no concurrency", "concurrency:\n  group: auto-release\n  cancel-in-progress: false\n", ""],
    ["write at the top", "permissions: {}\n", "permissions: write-all\n"],
    [
      "contents: write in level",
      "      contents: read\n    outputs:",
      "      contents: write\n    outputs:",
    ],
    ["packages: write in tag", tagPermissions, `${tagPermissions}      packages: write\n`],
    [
      "issues: write in report",
      "      pull-requests: write\n",
      "      pull-requests: write\n      issues: write\n",
    ],
    [
      "a checkout in tag",
      "      - name: Oznaka\n",
      `      - uses: ${LEVEL_USES[0]} # v7.0.1\n      - name: Oznaka\n`,
    ],
    [
      "an expression in run",
      "for tag in $RELEASES; do",
      "for tag in ${{ needs.level.outputs.releases }}; do",
    ],
    [
      "the ref name in env",
      "SHA: ${{ github.sha }}\n        run: |\n          [[",
      "SHA: ${{ github.ref_name }}\n        run: |\n          [[",
    ],
    [
      "another secret",
      "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          REPO",
      "GH_TOKEN: ${{ secrets.PAT }}\n          REPO",
    ],
    ["an unpinned action", `${LEVEL_USES[0]} # v7.0.1`, "actions/checkout@v7 # v7.0.1"],
    ["credentials kept", "          persist-credentials: false\n", ""],
    ["tagging off the tip of main", 'if [ "$tip" != "$SHA" ]; then', "if false; then"],
    ["a forced tag", '-f "sha=$SHA"', '-f "sha=$SHA" -f "force=true"'],
    ["no dispatch of publish.yml", "/actions/workflows/publish.yml/dispatches", "/dispatches"],
    [
      "continue-on-error",
      "        id: level\n",
      "        id: level\n        continue-on-error: true\n",
    ],
    [
      "tag without level",
      "    needs: level\n    if: needs.level.outputs.releases",
      "    if: needs.level.outputs.releases",
    ],
    ["a duplicate key", "permissions: {}\n", "permissions: {}\npermissions: {}\n"],
    ["no check of the tag name", '          [[ "$tag" =~', '          echo "$tag" #'],
    [
      "no check of STOPPED",
      '          [[ "$STOPPED" =~ $stopped_re ]]',
      '          echo "$STOPPED"',
    ],
    ["no check of the PR number", 'if [[ "$pr" =~ ^[0-9]+$ ]]; then', "if true; then"],
    ["report that does not fail", "          exit 1\n", "          exit 0\n"],
  ])("refuses %s", (_, from, to) => {
    expect(releaseErrors(replace(from, to))).not.toEqual([]);
  });
});

// Review on #93 (c.6906332117): the run blocks are executed, not only read.
// GitHub runs them with `bash -e`; gh is a stub that logs its arguments.
describe("release.yml run blocks under bash", () => {
  const doc = parse(RELEASE) as { jobs: Record<string, { steps: { run?: string }[] }> };
  const runOf = (job: string) => doc.jobs[job]!.steps[0]!.run!;
  const dir = mkdtempSync(join(tmpdir(), "release-run-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "gh.log");
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$GH_LOG"',
      'case "$*" in',
      '  *git/ref/heads/main*) echo "$TIP" ;;',
      '  *commits/*/pulls*) echo "7" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  const SHA = "d".repeat(40);
  const run = (job: string, env: Record<string, string>) => {
    writeFileSync(log, "");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", runOf(job)],
      {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          GH_LOG: log,
          GH_TOKEN: "invented-token",
          REPO: "example/repo",
          SHA,
          TIP: SHA,
          ...env,
        },
      },
    );
    return { status: result.status, stdout: result.stdout, calls: readFileSync(log, "utf8") };
  };

  it.each(["level", "tag", "report"])("%s parses under bash -n", (job) => {
    const steps = doc.jobs[job]!.steps.flatMap((step) => (step.run ? [step.run] : []));
    for (const script of steps) expect(spawnSync("bash", ["-n", "-c", script]).status).toBe(0);
  });

  it.each(["contracts:major", "test-fakes:blocked", "contracts:major test-fakes:blocked"])(
    "report comments on the merged PR and fails for STOPPED=%s",
    (stopped) => {
      const result = run("report", { STOPPED: stopped, RUN: "123" });
      expect(result.status).toBe(1);
      expect(result.calls).toContain("repos/example/repo/commits/" + SHA + "/pulls");
      expect(result.calls).toContain("-X POST repos/example/repo/issues/7/comments");
      expect(result.stdout).toContain(`::error::Automatsko izdanje je stalo (${stopped})`);
    },
  );

  it.each(["contracts:minor", "contracts:major;id", "evil:major", ""])(
    "report refuses STOPPED=%j before calling gh",
    (stopped) => {
      const result = run("report", { STOPPED: stopped, RUN: "123" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe("");
    },
  );

  it("tag creates the tag and dispatches publish.yml on the tip of main", () => {
    const result = run("tag", { RELEASES: "contracts-v1.2.0 test-fakes-v0.3.1" });
    expect(result.status).toBe(0);
    for (const tag of ["contracts-v1.2.0", "test-fakes-v0.3.1"]) {
      expect(result.calls).toContain(
        `-X POST repos/example/repo/git/refs -f ref=refs/tags/${tag} -f sha=${SHA}`,
      );
      expect(result.calls).toContain(`actions/workflows/publish.yml/dispatches -f ref=${tag}`);
    }
  });

  it("tag does nothing when main moved on", () => {
    const result = run("tag", { RELEASES: "contracts-v1.2.0", TIP: "e".repeat(40) });
    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("git/refs -f");
  });

  it.each(["contracts-v1.2.0;id", "contracts-v01.2.0", "other-v1.0.0"])(
    "tag refuses RELEASES=%j before creating anything",
    (releases) => {
      const result = run("tag", { RELEASES: releases });
      expect(result.status).not.toBe(0);
      expect(result.calls).not.toContain("git/refs -f");
    },
  );
});
