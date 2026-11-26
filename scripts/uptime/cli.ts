// DAN-1567, part 3: `node scripts/uptime/cli.ts`, run by the workflow
// "Provjera dostupnosti" on a schedule. Reads READY_URL, GITHUB_TOKEN and
// GITHUB_REPOSITORY from the environment. Exit 0 whether the server is up or
// down (the issue is the signal); exit 1 only when the look itself could not
// be recorded; exit 2 for a missing or unusable setting.
import { pathToFileURL } from "node:url";

import {
  ISSUE_TITLE,
  isProbeUrl,
  nextAction,
  probeReady,
  type Fetcher,
  type OpenIssue,
  type ProbeAction,
} from "./probe.ts";

/** The author of issues a workflow opens with its own token. */
export const ISSUE_AUTHOR = "github-actions[bot]";

export type GitHub = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<unknown>;

type Json = Record<string, unknown>;

const PAGE = 100;

/**
 * The open issue of the probe: ours by author and exact title, never a pull
 * request. Every page is read, so a full first page never hides it.
 */
export async function findOpenIssue(github: GitHub, repo: string): Promise<OpenIssue | null> {
  const creator = encodeURIComponent(ISSUE_AUTHOR);
  let found: Json | undefined;
  for (let page = 1; found === undefined; page += 1) {
    const list = (await github(
      "GET",
      `/repos/${repo}/issues?state=open&creator=${creator}&per_page=${PAGE}&page=${page}`,
    )) as Json[];
    found = list.find(
      (issue) => issue["title"] === ISSUE_TITLE && issue["pull_request"] === undefined,
    );
    if (list.length < PAGE) break;
  }
  if (found === undefined) return null;
  const body = found["body"];
  return { number: Number(found["number"]), body: typeof body === "string" ? body : "" };
}

export async function apply(github: GitHub, repo: string, action: ProbeAction): Promise<void> {
  if (action.kind === "open") {
    await github("POST", `/repos/${repo}/issues`, { title: action.title, body: action.body });
  } else if (action.kind === "refresh") {
    await github("PATCH", `/repos/${repo}/issues/${action.number}`, { body: action.body });
  } else if (action.kind === "close") {
    await github("POST", `/repos/${repo}/issues/${action.number}/comments`, {
      body: action.comment,
    });
    await github("PATCH", `/repos/${repo}/issues/${action.number}`, { state: "closed" });
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type Env = Record<string, string | undefined>;

/** One look and its record. Returns the exit code and one line that names no address. */
export async function main(
  env: Env,
  fetcher: Fetcher,
  github: GitHub,
  now: () => Date = () => new Date(),
): Promise<{ code: number; line: string }> {
  const url = env["READY_URL"];
  const repo = env["GITHUB_REPOSITORY"] ?? "";
  if (!isProbeUrl(url))
    return { code: 2, line: "READY_URL is not an https address of /api/v1/ready" };
  if (!REPO.test(repo)) return { code: 2, line: "GITHUB_REPOSITORY is not owner/name" };
  const result = await probeReady(url, fetcher);
  try {
    const action = nextAction(result, await findOpenIssue(github, repo), now().toISOString());
    await apply(github, repo, action);
    return { code: 0, line: `ready: ${result.up ? "up" : "down"}; issue: ${action.kind}` };
  } catch {
    return { code: 1, line: `ready: ${result.up ? "up" : "down"}; issue: could not be recorded` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const token = process.env["GITHUB_TOKEN"] ?? "";
  const github: GitHub = async (method, path, body) => {
    const answer = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!answer.ok) throw new Error(`GitHub ${answer.status}`);
    return answer.json();
  };
  const { code, line } = await main(process.env, (url, init) => fetch(url, init), github);
  console.log(line);
  process.exitCode = code;
}
