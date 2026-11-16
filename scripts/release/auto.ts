import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { floorProblem, latestTag, nextVersion, releaseLevel, type Files } from "./level.ts";
import { ROOT } from "./stage.ts";

// `pnpm release:level` (DAN-804): the first job of release.yml, contents: read.
// Stages each package at its last tag (with the tag's own code, in a worktree)
// and at HEAD, and writes `releases` (tags to create) and `stopped` (packages
// that wait for the owner) to $GITHUB_OUTPUT. It creates no tag itself.

export type Short = "contracts" | "test-fakes";
const PACKAGES: readonly Short[] = ["contracts", "test-fakes"];

export type Plan = { level: string; reasons: string[]; release?: string };

/** What planRelease reads from git and the staged packages; injected in tests. */
export type ReleaseIo = {
  readonly tags: readonly string[];
  /** The commit of the tag, if it is an ancestor of HEAD; null otherwise. */
  readonly ancestorCommit: (tag: string) => string | null;
  /** The package staged by the code of `commit`. */
  readonly stagedAt: (commit: string, short: Short) => Files;
  readonly stagedHead: (short: Short) => Files;
  readonly generatorChanged: (commit: string) => boolean;
  /** `version` of packages/<short>/package.json at HEAD. */
  readonly floor: (short: Short) => string;
};

function plan(short: Short, io: ReleaseIo): Plan {
  const base = latestTag(io.tags, short);
  if (base === null) return { level: "blocked", reasons: ["no tag; the first release is manual"] };
  const tag = `${short}-v${base.join(".")}`;
  const commit = io.ancestorCommit(tag);
  if (commit === null) return { level: "blocked", reasons: [`${tag} is not an ancestor of HEAD`] };
  const result = releaseLevel({
    short,
    before: io.stagedAt(commit, short),
    after: io.stagedHead(short),
    generatorChanged: io.generatorChanged(commit),
  });
  // A version raised alone (no other byte changed) still says something: a
  // pending major or an unreadable version stops the package (QA #92).
  if (result.level === "none") {
    const problem = floorProblem(base, io.floor(short));
    return problem === null ? result : { level: "blocked", reasons: [problem] };
  }
  if (result.level !== "minor" && result.level !== "patch") return result;
  const next = nextVersion(base, result.level, io.floor(short));
  if (typeof next === "string") return { level: "blocked", reasons: [...result.reasons, next] };
  return { ...result, release: `${short}-v${next.join(".")}` };
}

/** The plan for `short`; any failure (git, install, staging) is blocked, never a release. */
export function planRelease(short: Short, io: ReleaseIo): Plan {
  try {
    return plan(short, io);
  } catch (error) {
    return { level: "blocked", reasons: [String(error)] };
  }
}

/** The step outputs: tags to create and packages that stopped. */
export function outputs(plans: ReadonlyMap<Short, Plan>): string {
  const releases = [...plans.values()].flatMap((p) => (p.release ? [p.release] : []));
  const stopped = [...plans].flatMap(([short, p]) =>
    p.level === "major" || p.level === "blocked" ? [`${short}:${p.level}`] : [],
  );
  return `releases=${releases.join(" ")}\nstopped=${stopped.join(" ")}\n`;
}

/** `git diff --quiet`: 0 the same, 1 changed; anything else (128, no git) throws, so blocked. */
export function diffStatus(status: number | null): boolean {
  if (status === 0) return false;
  if (status === 1) return true;
  throw new Error(`git diff failed (${String(status)})`);
}

function run(cmd: string, args: string[], cwd = ROOT): string {
  const out = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (${String(out.status)})`);
  return out.stdout;
}

/** Every regular file under `dir`, by its path inside it, as exact text. */
export function readTree(dir: string): Files {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      // Not UTF-8 throws (blocked): U+FFFD would hide a change of bytes. A BOM is
      // kept, so adding or removing one is a change too (review #92).
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        readFileSync(path),
      );
      files.set(relative(dir, path).replaceAll("\\", "/"), text);
    } else if (!entry.isDirectory()) throw new Error(`${entry.name} is not a regular file`);
  return files;
}

/** Stages both packages with the code of `cwd`; the folder of the staged packages. */
function stage(cwd: string): string {
  run("node", ["scripts/release/check.ts", "--stage-only"], cwd);
  return join(cwd, "dist", "release");
}

function gitIo(head: string): ReleaseIo {
  const work = join(ROOT, "dist", "auto-release");
  const staged = new Map<string, string>();
  const stageCommit = (commit: string) => {
    const done = staged.get(commit);
    if (done !== undefined) return done;
    const dir = join(work, commit);
    rmSync(dir, { recursive: true, force: true });
    run("git", ["worktree", "prune"]);
    run("git", ["worktree", "add", "--detach", dir, commit]);
    run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], dir);
    staged.set(commit, stage(dir));
    return staged.get(commit)!;
  };
  const headDir = stage(ROOT);
  return {
    tags: run("git", ["tag", "--list"]).split("\n"),
    ancestorCommit: (tag) => {
      const commit = run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim();
      const check = spawnSync("git", ["merge-base", "--is-ancestor", commit, head], { cwd: ROOT });
      if (check.status === 0) return commit;
      if (check.status === 1) return null;
      throw new Error(`git merge-base failed (${String(check.status)})`);
    },
    stagedAt: (commit, short) => readTree(join(stageCommit(commit), short)),
    stagedHead: (short) => readTree(join(headDir, short)),
    // Any answer but "no difference" counts as changed.
    generatorChanged: (commit) =>
      diffStatus(
        spawnSync("git", ["diff", "--quiet", commit, head, "--", "scripts/generate-contracts.ts"], {
          cwd: ROOT,
        }).status,
      ),
    floor: (short) =>
      String(
        (
          JSON.parse(readFileSync(join(ROOT, "packages", short, "package.json"), "utf8")) as {
            version?: unknown;
          }
        ).version,
      ),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Staging HEAD or reading the tags failing stops both packages, visibly.
  let plans: Map<Short, Plan>;
  try {
    const io = gitIo(run("git", ["rev-parse", "HEAD"]).trim());
    plans = new Map(PACKAGES.map((short) => [short, planRelease(short, io)] as const));
  } catch (error) {
    plans = new Map(
      PACKAGES.map((short) => [short, { level: "blocked", reasons: [String(error)] }]),
    );
  }
  // The worktrees of the tags are not left behind for lint or tests to find.
  rmSync(join(ROOT, "dist", "auto-release"), { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd: ROOT });
  // One line per reason, without control characters, at most 50.
  const report = [...plans].flatMap(([short, p]) => [
    `### ${short}: ${p.level} ${p.release ?? ""}`,
    ...p.reasons.slice(0, 50).map((r) => `- ${r.replace(/[\u0000-\u001f\u007f-\u009f`]/gu, "?")}`),
  ]);
  console.log(report.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join("\n")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs(plans));
}
