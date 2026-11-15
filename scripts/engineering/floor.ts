// Risk floor of an open pull request for the engineering gate (S-0.10-b,
// DAN-723): reads the PR's head SHA and, from the compare of its base and
// head SHAs, the changed files over REST and prints
// `risk=<floor>` and `head-sha=<sha>` for $GITHUB_OUTPUT, from minimumRisk of
// risk-floor.ts. The workflow .github/workflows/engineering-gate.yml runs it
// from the default branch and passes both to the shared verdict check in
// ductura/.github, which gives only pending when the head has moved. It fails
// closed: any error, or a file list GitHub may have cut, gives `critical`, and
// an unknown head gives an empty SHA (pending).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changedPaths, minimumRisk, type Risk } from "./risk-floor.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

// A comparison lists at most 300 files; a list that long may be cut.
const FILE_LIST_CAP = 300;
const TIMEOUT_MS = 20_000;

/** The PR number of a pull_request_target or issue_comment event, else null. */
export function pullNumber(event: unknown): number | null {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const pull = record(record(event)["pull_request"]);
  const issue = record(record(event)["issue"]);
  const number = pull["number"] ?? (issue["pull_request"] ? issue["number"] : undefined);
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** The repository's default branch from the event, else an error. */
function defaultBranch(event: unknown): string {
  const repository =
    typeof event === "object" && event !== null
      ? (event as Record<string, unknown>)["repository"]
      : undefined;
  const branch =
    typeof repository === "object" && repository !== null
      ? (repository as Record<string, unknown>)["default_branch"]
      : undefined;
  if (typeof branch !== "string" || branch === "")
    throw new Error("An event without the default branch.");
  return branch;
}

function repoApi(env: Env): string {
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  const api = (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, "");
  return `${api}/repos/${repository}`;
}

function pullApi(env: Env, number: number): string {
  return `${repoApi(env)}/pulls/${number}`;
}

async function getJson(env: Env, url: string, fetchImpl: Fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env["GITHUB_TOKEN"] ?? ""}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API ${url}: ${response.status}`);
  return response.json();
}

const SHA_RE = /^[0-9a-f]{40}$/;

type Refs = { base: string; baseRef: string; head: string; changedFiles: number };

/**
 * The PR's base and head SHAs, base branch and changed file count from one
 * read; full SHAs, a branch name and a count, else an error.
 */
async function pullRefs(env: Env, number: number, fetchImpl: Fetch): Promise<Refs> {
  const pull = (await getJson(env, pullApi(env, number), fetchImpl)) as {
    head?: { sha?: unknown };
    base?: { sha?: unknown; ref?: unknown };
    ["changed_files"]?: unknown;
  } | null;
  const head = pull?.head?.sha;
  if (typeof head !== "string" || !SHA_RE.test(head))
    throw new Error("A pull request without a full head SHA.");
  const base = pull?.base?.sha;
  if (typeof base !== "string" || !SHA_RE.test(base))
    throw new Error("A pull request without a full base SHA.");
  const baseRef = pull?.base?.ref;
  if (typeof baseRef !== "string" || baseRef === "")
    throw new Error("A pull request without a base branch.");
  const changedFiles = pull?.["changed_files"];
  if (typeof changedFiles !== "number" || !Number.isSafeInteger(changedFiles) || changedFiles < 1)
    throw new Error("A pull request without a changed file count.");
  return { base, baseRef, head, changedFiles };
}

/**
 * Changed paths between the merge base of `base` and `head`, the same diff as
 * the PR's file list, but read from the compare of two immutable SHAs, so a
 * head that moves and comes back cannot swap the list. Without paging
 * parameters GitHub returns at most 300 files and puts the newest commit of
 * the whole comparison last; a list that may be cut, or whose newest commit
 * is not `head`, is an error.
 */
async function listFiles(env: Env, refs: Refs, fetchImpl: Fetch): Promise<string[]> {
  const url = `${repoApi(env)}/compare/${refs.base}...${refs.head}`;
  const compare = (await getJson(env, url, fetchImpl)) as Record<string, unknown> | null;
  if (typeof compare !== "object" || compare === null) throw new Error("Expected a comparison.");
  const status = compare["status"];
  if (status !== "ahead" && status !== "diverged")
    throw new Error(`The head is not ahead of the base (${String(status)}).`);
  const commits = compare["commits"];
  if (!Array.isArray(commits) || commits.length === 0)
    throw new Error("A comparison without commits.");
  const newest: unknown = commits[commits.length - 1];
  const newestSha =
    typeof newest === "object" && newest !== null
      ? (newest as Record<string, unknown>)["sha"]
      : null;
  if (newestSha !== refs.head) throw new Error("The comparison does not end at the head.");
  const list = compare["files"];
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("Expected a non-empty array of files.");
  if (list.length >= FILE_LIST_CAP)
    throw new Error(`${FILE_LIST_CAP} or more files; GitHub may have cut the list.`);
  if (list.length !== refs.changedFiles)
    throw new Error("The comparison and the pull request count different files.");
  const files: { filename: string; previousFilename?: string }[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) throw new Error("A file that is not an object.");
    const record = item as Record<string, unknown>;
    const filename = record["filename"];
    const previous = record["previous_filename"];
    if (typeof filename !== "string" || filename === "") throw new Error("A file without a name.");
    if (previous !== undefined && (typeof previous !== "string" || previous === ""))
      throw new Error("A file with an invalid previous name.");
    files.push(previous ? { filename, previousFilename: previous } : { filename });
  }
  return changedPaths(files);
}

export type Floor = { risk: Risk; headSha: string };

/**
 * Floor of the event's PR and the head SHA it was computed for. The files come
 * from the compare of the base and head SHAs of one read, so they belong to
 * the returned head by construction; the PR must be into the default branch
 * and the count of files must match the PR's own. The PR is read again
 * afterwards; a base or head that moved in between gives `critical` for the first head, which
 * the shared check then sees as stale. Any error gives `critical` (fails
 * closed), with the head if it is known.
 */
export async function pullRequestFloor(env: Env, fetchImpl: Fetch = fetch): Promise<Floor> {
  let sha = "";
  try {
    const event: unknown = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf8"));
    const number = pullNumber(event);
    if (!number) return { risk: "critical", headSha: "" };
    const refs = await pullRefs(env, number, fetchImpl);
    sha = refs.head;
    // A floor is for a diff against the default branch; a PR into any other
    // branch, or one retargeted mid-run, gets critical.
    if (refs.baseRef !== defaultBranch(event))
      throw new Error("The pull request is not into the default branch.");
    const { risk } = minimumRisk(await listFiles(env, refs, fetchImpl));
    const again = await pullRefs(env, number, fetchImpl);
    if (again.head !== refs.head || again.base !== refs.base || again.baseRef !== refs.baseRef)
      throw new Error("The base or head moved while the files were read.");
    return { risk, headSha: sha };
  } catch (error) {
    console.error(
      `Risk floor unknown, using critical: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { risk: "critical", headSha: sha };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const floor = await pullRequestFloor(process.env);
  console.log(`risk=${floor.risk}\nhead-sha=${floor.headSha}`);
}
