// Risk floor of an open pull request for the engineering gate (S-0.10-b,
// DAN-723): reads the PR's head SHA and changed files over REST and prints
// `risk=<floor>` and `head-sha=<sha>` for $GITHUB_OUTPUT, from minimumRisk of
// risk-floor.ts. The workflow .github/workflows/engineering-gate.yml runs it
// from the default branch and passes both to the shared verdict check in
// ductura/.github, which gives only pending when the head has moved. It fails
// closed: any error, or a file list GitHub truncates, gives `critical`, and
// an unknown head gives an empty SHA (pending).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changedPaths, minimumRisk, type Risk } from "./risk-floor.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

// GitHub lists at most 3000 files of a pull request.
const FILE_LIST_CAP = 3000;
const PAGE_SIZE = 100;
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

function pullApi(env: Env, number: number): string {
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  const api = (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, "");
  return `${api}/repos/${repository}/pulls/${number}`;
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

async function headSha(env: Env, number: number, fetchImpl: Fetch): Promise<string> {
  const pull = (await getJson(env, pullApi(env, number), fetchImpl)) as {
    head?: { sha?: unknown };
  } | null;
  const sha = pull?.head?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error("A pull request without a full head SHA.");
  return sha;
}

async function listFiles(env: Env, number: number, fetchImpl: Fetch): Promise<string[]> {
  const files: { filename: string; previousFilename?: string }[] = [];
  for (let page = 1; page <= FILE_LIST_CAP / PAGE_SIZE; page += 1) {
    const batch = await getJson(
      env,
      `${pullApi(env, number)}/files?per_page=${PAGE_SIZE}&page=${page}`,
      fetchImpl,
    );
    if (!Array.isArray(batch)) throw new Error("Expected an array of files.");
    for (const item of batch as Record<string, unknown>[]) {
      const filename = item["filename"];
      const previous = item["previous_filename"];
      if (typeof filename !== "string" || filename === "")
        throw new Error("A file without a name.");
      files.push(
        typeof previous === "string" && previous
          ? { filename, previousFilename: previous }
          : { filename },
      );
    }
    if (batch.length < PAGE_SIZE) return changedPaths(files);
  }
  throw new Error(`More than ${FILE_LIST_CAP - 1} files; GitHub may have cut the list.`);
}

export type Floor = { risk: Risk; headSha: string };

/**
 * Floor of the event's PR and the head SHA it was computed for. The head is
 * read before and after the file list; a head that moved in between gives
 * `critical` for the first head, which the shared check then sees as stale.
 * Any error gives `critical` (fails closed), with the head if it is known.
 */
export async function pullRequestFloor(env: Env, fetchImpl: Fetch = fetch): Promise<Floor> {
  let sha = "";
  try {
    const event: unknown = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf8"));
    const number = pullNumber(event);
    if (!number) return { risk: "critical", headSha: "" };
    sha = await headSha(env, number, fetchImpl);
    const { risk } = minimumRisk(await listFiles(env, number, fetchImpl));
    if ((await headSha(env, number, fetchImpl)) !== sha)
      throw new Error("The head moved while the files were read.");
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
