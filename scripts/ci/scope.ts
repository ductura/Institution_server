import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Profile = "docs" | "full";
export type Job = "checks" | "database";

const JOBS: Readonly<Record<Profile, readonly Job[]>> = Object.freeze({
  docs: Object.freeze(["checks"] as const),
  full: Object.freeze(["checks", "database"] as const),
});

/** The CI jobs a profile needs; `checks` always runs. */
export function jobsFor(profile: Profile): Job[] {
  return [...JOBS[profile]];
}

// Only a plain Markdown document is ordinary: docs/**/*.md or README.md at any
// depth. Segments are ASCII letters, digits, `_`, `-` and inner dots, and the
// names are exact, so case variants, backslashes, `.`/`..`, whitespace and controls
// (CRLF, tab, NBSP, DEL, C1, U+2028, BOM) never qualify.
const SEGMENT = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*";
const DOC_PATH = new RegExp(
  `^(?:docs/(?:${SEGMENT}/)*${SEGMENT}\\.md|(?:${SEGMENT}/)*README\\.md)$`,
);

/** True when a changed path is an ordinary document that cannot affect the database job. */
export function isOrdinaryDoc(path: unknown): boolean {
  return typeof path === "string" && DOC_PATH.test(path);
}

// A regular file added, modified or deleted; anything else (mode change,
// symlink, submodule, type change, copy, rename, unmerged) needs the full profile.
const HEADER = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([A-Z])(\d*)$/;
const REGULAR = new Map([
  ["A", "000000 100644"],
  ["D", "100644 000000"],
  ["M", "100644 100644"],
]);

/**
 * Classifies `git diff --raw -z --abbrev=40 --no-renames` output. The database
 * job is skipped only when every record is an ordinary document; an empty diff
 * is full. A malformed record throws, so it can never produce `docs`.
 */
export function classifyDiff(raw: string): Profile {
  if (raw === "") return "full";
  const fields = raw.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("Incomplete git diff");
  let docs = true;
  for (let i = 0; i < fields.length; i += 2) {
    const header = HEADER.exec(fields[i] ?? "");
    const path = fields[i + 1];
    if (!header || !path) throw new Error("Invalid git diff record");
    const [, before, after, status, score] = header;
    const regular = score === "" && REGULAR.get(status ?? "") === `${before} ${after}`;
    if (!regular || !isOrdinaryDoc(path)) docs = false;
  }
  return docs ? "docs" : "full";
}

export type ScopeInput = {
  eventName: string | undefined;
  baseRef: string | undefined;
  baseSha: string | undefined;
  headSha: string | undefined;
  cwd?: string;
};

const FULL_SHA = /^[a-f0-9]{40}$/;

// CI-BRZINA: the protected branches a pull request may target and still be
// docs: main and the migration base the work currently merges into.
export const DOCS_BASES: ReadonlySet<string> = new Set(["main", "migracija/kopija-ductus-backend"]);

/**
 * The profile of one CI run. Only a pull request into a DOCS_BASES branch can be docs; pushes
 * and stacked pull requests run everything. Immutable commits are compared,
 * never the live file list of a moving pull request.
 */
export function ciProfile(input: ScopeInput): Profile {
  if (input.eventName !== "pull_request" || !DOCS_BASES.has(input.baseRef ?? "")) return "full";
  const { baseSha, headSha } = input;
  if (!baseSha || !headSha || !FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha)) {
    throw new Error("CI scope needs full commit SHAs");
  }
  const raw = execFileSync(
    "git",
    [
      "--no-replace-objects",
      "diff",
      "--raw",
      "-z",
      "--abbrev=40",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      baseSha,
      headSha,
      "--",
    ],
    {
      cwd: input.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return classifyDiff(raw);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = ciProfile({
    eventName: process.env["EVENT_NAME"],
    baseRef: process.env["PR_BASE_REF"],
    baseSha: process.env["PR_BASE"],
    headSha: process.env["PR_HEAD"],
  });
  process.stdout.write(`profile=${profile}\n`);
}
