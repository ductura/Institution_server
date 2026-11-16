import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

// DAN-804: release.yml as GitHub reads it, against exact allow lists, in the
// style of the invariant 5 test of publish.yml (workflow.test.ts).
// DAN-866: tag pushes the tag with the release deploy key, not GITHUB_TOKEN.
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
const DEPLOY_KEY = "${{ secrets.RELEASE_DEPLOY_KEY }}";
const EXPRESSIONS: Readonly<Record<string, string>> = {
  "jobs.level.outputs.releases": "${{ steps.level.outputs.releases }}",
  "jobs.level.outputs.stopped": "${{ steps.level.outputs.stopped }}",
  "jobs.tag.steps.0.env.RELEASES": "${{ needs.level.outputs.releases }}",
  "jobs.tag.steps.0.env.DEPLOY_KEY": DEPLOY_KEY,
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
  // No GITHUB_TOKEN at all: the deploy key pushes, and its push starts publish.yml.
  tag: {},
  report: { contents: "read", "pull-requests": "write" },
};
const LEVEL_USES = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
];
const STEP_KEYS = ["name", "id", "uses", "with", "env", "run"];

// github.com's published ed25519 host key (SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU).
const GITHUB_HOST_KEY =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const TAG_RE = "(contracts|test-fakes)-v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)";
const VERSION_RE = "v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)";
/** The lines of the tag run, in this order; every check comes before the key and the network. */
const TAG_LINES = [
  '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]',
  '[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]]',
  `releases_re='^(contracts-${VERSION_RE}|test-fakes-${VERSION_RE}|contracts-${VERSION_RE} test-fakes-${VERSION_RE})$'`,
  '[[ "$RELEASES" =~ $releases_re ]]',
  `[[ "$tag" =~ ^${TAG_RE}$ ]]`,
  'refs+=("$SHA:refs/tags/$tag")',
  '[ -n "$DEPLOY_KEY" ]',
  'work="$(mktemp -d)"',
  `trap '[ -z "\${SSH_AGENT_PID:-}" ] || ssh-agent -k > /dev/null; rm -rf "$work"' EXIT`,
  'eval "$(ssh-agent -s)" > /dev/null',
  "printf '%s\\n' \"$DEPLOY_KEY\" | ssh-add -q -",
  "unset DEPLOY_KEY",
  `echo "${GITHUB_HOST_KEY}" > "$work/known_hosts"`,
  'export GIT_SSH_COMMAND="ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=$work/known_hosts"',
  'remote="git@github.com:$REPO.git"',
  'tip="$(git ls-remote "$remote" refs/heads/main | cut -f1)"',
  'if [ "$tip" != "$SHA" ]; then echo "::notice::main moved on; a later run releases"; exit 0; fi',
  'git init -q "$work/repo"',
  'git -C "$work/repo" fetch -q --depth=1 --no-tags "$remote" "$SHA"',
  'git -C "$work/repo" push --atomic "$remote" "${refs[@]}"',
];
/** The only lines of the tag run that may name the key. */
const KEY_LINES = new Set(TAG_LINES.filter((line) => line.includes("DEPLOY_KEY")));

/** Every rule the tag run breaks. */
function tagRunErrors(run: string): string[] {
  const errors: string[] = [];
  const lines = run.split("\n").map((line) => line.trim());
  let at = -1;
  for (const needed of TAG_LINES) {
    const found = lines.indexOf(needed, at + 1);
    if (found === -1) errors.push(`tag run without ${needed} (in order)`);
    else at = found;
  }
  for (const line of lines) {
    if (line.includes("DEPLOY_KEY") && !KEY_LINES.has(line)) errors.push(`key used in: ${line}`);
    if (/StrictHostKeyChecking=(?!yes\b)|UserKnownHostsFile=\/dev\/null/u.test(line))
      errors.push(`host key not checked: ${line}`);
  }
  // A tag is never moved, deleted or dispatched on, and nothing is traced.
  if (
    /--force|--delete|--mirror|\s-f\b|\s\+|:\+|"\+|\+\$SHA|\bgh\b|dispatches|set -x|GH_TOKEN|curl/u.test(
      run,
    )
  )
    errors.push("tag may move, delete, dispatch or trace");
  return errors;
}

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
  // Each secret only where EXPRESSIONS puts it: the key only in the tag step.
  for (const [path, value] of strings(doc))
    if (/\$\{\{|secrets|github\.token/u.test(value) && EXPRESSIONS[path] !== value)
      errors.push(`expression at ${path}: ${value}`);
  if (/dispatches/u.test(text)) errors.push("publish.yml is dispatched as well");
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
      errors.push(`${name} is not one run step`);
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
  errors.push(...tagRunErrors(String(((jobs.tag?.steps ?? []) as Node[])[0]?.run ?? "")));
  // Defence in depth: every value is matched before use, and a stop fails the run.
  const reportRun = String(((jobs.report?.steps ?? []) as Node[])[0]?.run ?? "");
  for (const needed of [
    '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$RUN" =~ ^[0-9]+$ ]]',
    "stopped_re='^(contracts|test-fakes):(major|blocked)( (contracts|test-fakes):(major|blocked))?$'",
    '[[ "$STOPPED" =~ $stopped_re ]]',
    'if [[ "$pr" =~ ^[0-9]+$ ]]; then',
    "exit 1",
  ])
    if (!reportRun.split("\n").some((line) => line.trim() === needed))
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
  const tagPermissions = "    permissions: {}\n    steps:\n      # Only";
  const keyEnv = "          DEPLOY_KEY: ${{ secrets.RELEASE_DEPLOY_KEY }}\n";
  const push = 'push --atomic "$remote" "${refs[@]}"';

  it.each([
    ["pull_request_target", branches, `${branches}  pull_request_target:\n`],
    ["workflow_dispatch", branches, `${branches}  workflow_dispatch:\n`],
    ["another branch", "[main]", "[main, dev]"],
    ["cancel-in-progress", "cancel-in-progress: false", "cancel-in-progress: true"],
    ["no concurrency", "concurrency:\n  group: auto-release\n  cancel-in-progress: false\n", ""],
    ["write at the top", "permissions: {}\n\nconcurrency", "permissions: write-all\n\nconcurrency"],
    [
      "contents: write in level",
      "      contents: read\n    outputs:",
      "      contents: write\n    outputs:",
    ],
    [
      "contents: write in tag",
      tagPermissions,
      "    permissions:\n      contents: write\n    steps:\n      # Only",
    ],
    [
      "actions: write in tag",
      tagPermissions,
      "    permissions:\n      actions: write\n    steps:\n      # Only",
    ],
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
    ["GITHUB_TOKEN in tag", keyEnv, `${keyEnv}          GH_TOKEN: ${TOKEN}\n`],
    ["the key from another secret", keyEnv, "          DEPLOY_KEY: ${{ secrets.PAT }}\n"],
    [
      "the key in a job env",
      "    permissions: {}\n    steps:",
      `    permissions: {}\n    env:\n      K: ${DEPLOY_KEY}\n    steps:`,
    ],
    [
      "the key in report",
      "          RUN: ${{ github.run_id }}\n",
      `          RUN: \${{ github.run_id }}\n          K: ${DEPLOY_KEY}\n`,
    ],
    [
      "another secret in report",
      "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          REPO",
      "GH_TOKEN: ${{ secrets.PAT }}\n          REPO",
    ],
    ["an unpinned action", `${LEVEL_USES[0]} # v7.0.1`, "actions/checkout@v7 # v7.0.1"],
    ["credentials kept", "          persist-credentials: false\n", ""],
    ["tagging off the tip of main", 'if [ "$tip" != "$SHA" ]; then', "if false; then"],
    ["a forced push", push, `push --atomic --force "$remote" "\${refs[@]}"`],
    ["a forced refspec", 'refs+=("$SHA:refs', 'refs+=("+$SHA:refs'],
    ["a push without --atomic", push, 'push "$remote" "${refs[@]}"'],
    ["a deleting push", push, `${push} --delete`],
    [
      "a dispatch of publish.yml",
      `${push}\n`,
      `${push}\n          gh api -X POST "repos/$REPO/actions/workflows/publish.yml/dispatches" -f "ref=$tag"\n`,
    ],
    ["tracing", '          [[ "$SHA" =~', '          set -x\n          [[ "$SHA" =~'],
    [
      "the key printed",
      "          unset DEPLOY_KEY\n",
      '          echo "$DEPLOY_KEY"\n          unset DEPLOY_KEY\n',
    ],
    [
      "the key in a file",
      "          unset DEPLOY_KEY\n",
      '          printf \'%s\\n\' "$DEPLOY_KEY" > "$work/key"\n          unset DEPLOY_KEY\n',
    ],
    ["the key kept for git and ssh", "          unset DEPLOY_KEY\n", ""],
    ["no check of an empty key", '          [ -n "$DEPLOY_KEY" ]\n', ""],
    ["an unchecked host key", "StrictHostKeyChecking=yes", "StrictHostKeyChecking=no"],
    ["a new host key accepted", "StrictHostKeyChecking=yes", "StrictHostKeyChecking=accept-new"],
    [
      "another host key",
      "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJx",
    ],
    ["the user's ssh config", "ssh -F /dev/null", "ssh"],
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
    [
      "a duplicate key",
      "permissions: {}\n\nconcurrency",
      "permissions: {}\npermissions: {}\n\nconcurrency",
    ],
    ["no check of the tag name", '            [[ "$tag" =~', '            echo "$tag" #'],
    ["no check of RELEASES", '          [[ "$RELEASES" =~ $releases_re ]]\n', ""],
    ["no check of REPO", '          [[ "$REPO" =~', '          echo "$REPO" #'],
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

  it("refuses the names checked after the first network call", () => {
    const check = '          [[ "$RELEASES" =~ $releases_re ]]\n';
    const moved = replace(check, "").replace(
      '          git init -q "$work/repo"\n',
      `          git init -q "$work/repo"\n${check}`,
    );
    expect(moved).not.toBe(replace(check, ""));
    expect(releaseErrors(moved)).not.toEqual([]);
  });
});

// Review on #93 (c.6906332117): the run blocks are executed, not only read.
// GitHub runs them with `bash -e`; gh, ssh-agent, ssh-add and ssh are stubs.
// git is real: ssh runs git-upload-pack and git-receive-pack on a local bare
// repository, which stands in for GitHub.
describe("release.yml run blocks under bash", () => {
  const doc = parse(RELEASE) as { jobs: Record<string, { steps: { run?: string }[] }> };
  const runOf = (job: string) => doc.jobs[job]!.steps[0]!.run!;
  const dir = mkdtempSync(join(tmpdir(), "release-run-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
    chmodSync(join(bin, name), 0o755);
  };
  stub("gh", [
    'echo "$*" >> "$GH_LOG"',
    'case "$*" in',
    '  *commits/*/pulls*) echo "7" ;;',
    "esac",
  ]);
  // The agent is a file: -s creates it, ssh-add appends the key, -k removes it.
  stub("ssh-agent", [
    'echo "ssh-agent $*" >> "$SSH_LOG"',
    'if [ "$1" = -s ]; then',
    '  : > "$AGENT_DIR/agent.sock"',
    '  echo "SSH_AUTH_SOCK=$AGENT_DIR/agent.sock; export SSH_AUTH_SOCK;"',
    '  echo "SSH_AGENT_PID=4242; export SSH_AGENT_PID;"',
    'elif [ "$1" = -k ] && [ "$SSH_AGENT_PID" = 4242 ]; then rm "$SSH_AUTH_SOCK"',
    "else exit 2; fi",
  ]);
  stub("ssh-add", [
    'echo "ssh-add $*" >> "$SSH_LOG"',
    '[ "$*" = "-q -" ] && [ -f "$SSH_AUTH_SOCK" ] || exit 2',
    'cat >> "$AGENT_DIR/held"',
  ]);
  stub("ssh", [
    'echo "ssh $*" >> "$SSH_LOG"',
    '[ -z "${DEPLOY_KEY+set}" ] || echo "ssh sees DEPLOY_KEY" >> "$SSH_LOG"',
    '[ -f "$SSH_AUTH_SOCK" ] || echo "ssh without the agent" >> "$SSH_LOG"',
    'cd "$REMOTE_ROOT" && exec sh -c "${@: -1}"',
  ]);

  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const home = join(dir, "home");
  mkdirSync(home);
  const GIT_ENV = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ["GIT_CONFIG_NOSYSTEM"]: "1",
    ["GIT_AUTHOR_NAME"]: "Invented",
    ["GIT_AUTHOR_EMAIL"]: "invented@example.invalid",
    ["GIT_COMMITTER_NAME"]: "Invented",
    ["GIT_COMMITTER_EMAIL"]: "invented@example.invalid",
  };
  // An invented key: the stubs only carry it, nothing parses it.
  const KEY = "invented-release-deploy-key-for-tests-only";
  let round = 0;
  /** A fresh "GitHub" with two commits on main; the older and the tip. */
  const remote = () => {
    const root = join(dir, `remote-${++round}`);
    const bare = join(root, "example", "repo.git");
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(work, "init", "-q", "-b", "main");
    git(work, "commit", "-q", "--allow-empty", "-m", "one");
    const older = git(work, "rev-parse", "HEAD");
    git(work, "commit", "-q", "--allow-empty", "-m", "two");
    const tip = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", bare, "main");
    const tags = () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags");
    return { root, bare, older, tip, tags };
  };

  const log = join(dir, "gh.log");
  const sshLog = join(dir, "ssh.log");
  const run = (job: string, env: Record<string, string>) => {
    writeFileSync(log, "");
    writeFileSync(sshLog, "");
    const agent = mkdtempSync(join(dir, "agent-"));
    const temp = mkdtempSync(join(dir, "tmp-"));
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", runOf(job)],
      {
        encoding: "utf8",
        env: {
          ...GIT_ENV,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ["TMPDIR"]: temp,
          ["GH_LOG"]: log,
          ["SSH_LOG"]: sshLog,
          ["AGENT_DIR"]: agent,
          ["GH_TOKEN"]: "invented-token",
          ["REPO"]: "example/repo",
          ["SHA"]: "d".repeat(40),
          ...env,
        },
      },
    );
    const held = join(agent, "held");
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      stdout: result.stdout,
      calls: readFileSync(log, "utf8"),
      ssh: readFileSync(sshLog, "utf8"),
      held: existsSync(held) ? readFileSync(held, "utf8") : "",
      agentLeft: existsSync(join(agent, "agent.sock")),
      tempLeft: readdirSync(temp),
    };
  };

  it.each(["level", "tag", "report"])("%s parses under bash -n", (job) => {
    const steps = doc.jobs[job]!.steps.flatMap((step) => (step.run ? [step.run] : []));
    for (const script of steps) expect(spawnSync("bash", ["-n", "-c", script]).status).toBe(0);
  });

  it.each(["contracts:major", "test-fakes:blocked", "contracts:major test-fakes:blocked"])(
    "report comments on the merged PR and fails for STOPPED=%s",
    (stopped) => {
      const result = run("report", { ["STOPPED"]: stopped, ["RUN"]: "123" });
      expect(result.status).toBe(1);
      expect(result.calls).toContain("repos/example/repo/commits/" + "d".repeat(40) + "/pulls");
      expect(result.calls).toContain("-X POST repos/example/repo/issues/7/comments");
      expect(result.stdout).toContain(`::error::Automatsko izdanje je stalo (${stopped})`);
    },
  );

  it.each(["contracts:minor", "contracts:major;id", "evil:major", ""])(
    "report refuses STOPPED=%j before calling gh",
    (stopped) => {
      const result = run("report", { ["STOPPED"]: stopped, ["RUN"]: "123" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe("");
    },
  );

  /** The step left nothing behind: no agent, no temporary folder, no key in the log. */
  const clean = (result: ReturnType<typeof run>) => {
    expect(result.agentLeft).toBe(false);
    expect(result.tempLeft).toEqual([]);
    expect(result.output).not.toContain(KEY);
    expect(result.ssh).not.toContain(KEY);
    expect(result.ssh).not.toContain("ssh sees DEPLOY_KEY");
    expect(result.ssh).not.toContain("ssh without the agent");
    expect(result.calls).toBe("");
  };

  it("tag pushes the tags with the key, on the tip of main, without gh", () => {
    const github = remote();
    const env = {
      ["RELEASES"]: "contracts-v1.2.0 test-fakes-v0.3.1",
      ["SHA"]: github.tip,
      ["DEPLOY_KEY"]: KEY,
      ["REMOTE_ROOT"]: github.root,
    };
    const result = run("tag", env);
    expect(result.status, result.output).toBe(0);
    expect(github.tags()).toBe(
      [
        `refs/tags/contracts-v1.2.0 ${github.tip}`,
        `refs/tags/test-fakes-v0.3.1 ${github.tip}`,
      ].join("\n"),
    );
    expect(result.held).toBe(`${KEY}\n`);
    const ssh = result.ssh.split("\n").filter((line) => line.startsWith("ssh "));
    expect(ssh.length).toBeGreaterThanOrEqual(3);
    for (const line of ssh) {
      expect(line).toContain(
        "ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=",
      );
      expect(line).toContain("git@github.com");
    }
    expect(result.ssh).toContain("git-receive-pack 'example/repo.git'");
    expect(result.ssh).toContain("ssh-agent -k");
    clean(result);
    // A second run of the same commit changes nothing and succeeds.
    const again = run("tag", env);
    expect(again.status, again.output).toBe(0);
    expect(github.tags()).toContain(`refs/tags/contracts-v1.2.0 ${github.tip}`);
    clean(again);
  });

  it("tag never moves an existing tag and then creates none (atomic)", () => {
    const github = remote();
    git(github.bare, "update-ref", "refs/tags/contracts-v1.2.0", github.older);
    const result = run("tag", {
      ["RELEASES"]: "contracts-v1.2.0 test-fakes-v0.3.1",
      ["SHA"]: github.tip,
      ["DEPLOY_KEY"]: KEY,
      ["REMOTE_ROOT"]: github.root,
    });
    expect(result.status).not.toBe(0);
    expect(github.tags()).toBe(`refs/tags/contracts-v1.2.0 ${github.older}`);
    clean(result);
  });

  it("tag pushes nothing when main moved on", () => {
    const github = remote();
    const result = run("tag", {
      ["RELEASES"]: "contracts-v1.2.0",
      ["SHA"]: github.older,
      ["DEPLOY_KEY"]: KEY,
      ["REMOTE_ROOT"]: github.root,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("::notice::main moved on");
    expect(github.tags()).toBe("");
    expect(result.ssh).not.toContain("git-receive-pack");
    clean(result);
  });

  // Every class of outside input is refused before the key or the network.
  const RELEASES_BAD = [
    "contracts-v1.2.0;id",
    "contracts-v01.2.0",
    "other-v1.0.0",
    "contracts-v1.2.0 x",
    "test-fakes-v0.3.1 contracts-v1.2.0",
    "contracts-v1.2.0 contracts-v1.3.0",
    "contracts-v1.2.0  test-fakes-v0.3.1",
    "contracts-v1.2.0\ttest-fakes-v0.3.1",
    "contracts-v1.2.0\ntest-fakes-v0.3.1",
    "contracts-v1.2.0\r",
    "contracts-v1.2.0\r\ntest-fakes-v0.3.1",
    "contracts-v1.2.0 ",
    "contracts-v1.2.0\u007f",
    " contracts-v1.2.0",
    "contracts-v1.2.0 ",
    "contracts-v1.2",
    "",
  ];
  it.each([
    ...RELEASES_BAD.map((releases) => ({ ["RELEASES"]: releases })),
    { ["SHA"]: "d".repeat(39) },
    { ["SHA"]: "D".repeat(40) },
    { ["SHA"]: `${"d".repeat(40)}\n` },
    { ["SHA"]: `${"d".repeat(40)}\r` },
    { ["SHA"]: `${"d".repeat(39)} ` },
    { ["REPO"]: "example/repo;id" },
    { ["REPO"]: "example/repo x" },
    { ["REPO"]: "example" },
    { ["REPO"]: "example/repo\t" },
    { ["REPO"]: "example/repo\u007f" },
    { ["REPO"]: "../repo" },
    { ["DEPLOY_KEY"]: "" },
  ])("tag refuses %j before the key and the network", (bad) => {
    const github = remote();
    const result = run("tag", {
      ["RELEASES"]: "contracts-v1.2.0",
      ["DEPLOY_KEY"]: KEY,
      ["REMOTE_ROOT"]: github.root,
      ["SHA"]: github.tip,
      ...bad,
    });
    expect(result.status).not.toBe(0);
    expect(result.ssh).toBe("");
    expect(result.held).toBe("");
    expect(result.calls).toBe("");
    expect(result.output).not.toContain(KEY);
    expect(github.tags()).toBe("");
  });
});
