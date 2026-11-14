// Risk floor of an open pull request for the engineering gate (S-0.10-b,
// DAN-723): reads the PR's changed files over REST and prints `risk=<floor>`
// for $GITHUB_OUTPUT, from minimumRisk of risk-floor.ts. The workflow
// .github/workflows/engineering-gate.yml runs it from the default branch and
// passes the floor to the shared verdict check in ductura/.github. It fails
// closed: any error, or a file list GitHub truncates, gives `critical`.
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

async function listFiles(env: Env, number: number, fetchImpl: Fetch): Promise<string[]> {
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  const api = (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, "");
  const files: { filename: string; previousFilename?: string }[] = [];
  for (let page = 1; page <= FILE_LIST_CAP / PAGE_SIZE; page += 1) {
    const response = await fetchImpl(
      `${api}/repos/${repository}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env["GITHUB_TOKEN"] ?? ""}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`GitHub API files of #${number}: ${response.status}`);
    const batch: unknown = await response.json();
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

/** Floor of the event's PR; `critical` on any error (fails closed). */
export async function pullRequestFloor(env: Env, fetchImpl: Fetch = fetch): Promise<Risk> {
  try {
    const event: unknown = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf8"));
    const number = pullNumber(event);
    if (!number) return "critical";
    return minimumRisk(await listFiles(env, number, fetchImpl)).risk;
  } catch (error) {
    console.error(
      `Risk floor unknown, using critical: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "critical";
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(`risk=${await pullRequestFloor(process.env)}`);
}
