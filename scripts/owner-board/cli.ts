// DAN-1569: the owner's board as one HTML file. Reads only: STATE.md from
// disk, GitHub with GET requests, Linear with one query. Changes nothing.
//   node scripts/owner-board/cli.ts --state <STATE.md> --repo <owner/name> [--repo ...]
//        [--out <file.html>] [--stale-days <n>]
// GITHUB_TOKEN and LINEAR_API_KEY come from the environment and are never
// written to the output. Without one, its section says it was not read.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { pullRow, readPulls, type GetJson } from "./pulls.ts";
import { openByDeadline, parseOwnerQueue } from "./queue.ts";
import { buildBoard, type Board, type StaleIssue } from "./render.ts";

export type Args = { state: string; repos: string[]; out: string; staleDays: number };

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The arguments, or null when they are not usable. */
export function parseArgs(argv: readonly string[]): Args | null {
  const args: Args = { state: "", repos: [], out: "owner-board.html", staleDays: 3 };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) return null;
    if (argv[i] === "--state") args.state = value;
    else if (argv[i] === "--repo" && REPO.test(value)) args.repos.push(value);
    else if (argv[i] === "--out") args.out = value;
    else if (argv[i] === "--stale-days" && /^[1-9]\d{0,2}$/.test(value))
      args.staleDays = Number(value);
    else return null;
  }
  return args.state === "" ? null : args;
}

const DAY = 86_400_000;

/** Issues of Linear's "started" state type whose start is at least `staleDays` old. */
export async function readStale(
  post: (query: string) => Promise<unknown>,
  now: Date,
  staleDays: number,
): Promise<StaleIssue[]> {
  type Node = { identifier: string; title: string; url: string; startedAt: string | null };
  type Page = {
    data: {
      issues: {
        nodes: Node[];
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };
  // The age is filtered by Linear too, and every page is read, so no stale
  // issue is left out when more than one page of issues is in progress.
  const cutoff = new Date(now.getTime() - staleDays * DAY).toISOString();
  const nodes: Node[] = [];
  let after: string | null = null;
  do {
    const cursor: string = after === null ? "" : `, after: ${JSON.stringify(after)}`;
    const answer = (await post(
      `{ issues(first: 100${cursor}, filter: { state: { type: { eq: "started" } }, startedAt: { lte: ${JSON.stringify(cutoff)} } }) { nodes { identifier title url startedAt } pageInfo { hasNextPage endCursor } } }`,
    )) as Page;
    nodes.push(...answer.data.issues.nodes);
    const info = answer.data.issues.pageInfo;
    after = info?.hasNextPage === true ? info.endCursor : null;
  } while (after !== null);
  return nodes
    .filter((issue) => issue.startedAt !== null)
    .map((issue) => ({
      id: issue.identifier,
      title: issue.title,
      url: issue.url,
      startedAt: issue.startedAt!,
      days: Math.floor((now.getTime() - Date.parse(issue.startedAt!)) / DAY),
    }))
    .filter((issue) => issue.days >= staleDays)
    .sort((a, b) => b.days - a.days);
}

export type Sources = {
  readFile: (path: string) => string;
  get: GetJson | null;
  linear: ((query: string) => Promise<unknown>) | null;
};

/** A failed read becomes an unread section with a fixed reason; an error's message never reaches the page. */
export async function composeBoard(args: Args, sources: Sources, now: Date): Promise<Board> {
  const today = now.toISOString().slice(0, 10);
  const read = now.toISOString();
  let queue: Board["queue"];
  try {
    queue = {
      source: `${args.state}, pročitano ${read}`,
      rows: openByDeadline(parseOwnerQueue(sources.readFile(args.state)), today),
    };
  } catch {
    queue = { source: args.state, unread: "datoteka se ne može pročitati" };
  }
  const pullSource = `GitHub (${args.repos.join(", ") || "nijedan repozitorij"}), pročitano ${read}`;
  let pulls: Board["pulls"];
  if (sources.get === null) pulls = { source: pullSource, unread: "GITHUB_TOKEN nije zadan" };
  else {
    try {
      const all = await Promise.all(args.repos.map((repo) => readPulls(repo, sources.get!)));
      pulls = {
        source: pullSource,
        rows: all
          .flat()
          .map(pullRow)
          .sort((a, b) => Number(b.awaitsOwner) - Number(a.awaitsOwner)),
      };
    } catch {
      pulls = { source: pullSource, unread: "GitHub nije odgovorio kako se očekuje" };
    }
  }
  const staleSource = `Linear, pročitano ${read}`;
  let stale: Board["stale"];
  if (sources.linear === null)
    stale = { source: staleSource, unread: "LINEAR_API_KEY nije zadan", staleDays: args.staleDays };
  else {
    try {
      stale = {
        source: staleSource,
        rows: await readStale(sources.linear, now, args.staleDays),
        staleDays: args.staleDays,
      };
    } catch {
      stale = {
        source: staleSource,
        unread: "Linear nije odgovorio kako se očekuje",
        staleDays: args.staleDays,
      };
    }
  }
  return { generatedAt: read, today, queue, pulls, stale };
}

async function json(url: string, init: RequestInit): Promise<unknown> {
  const answer = await fetch(url, init);
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  return answer.json();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(
      "Upotreba: node scripts/owner-board/cli.ts --state <STATE.md> --repo <vlasnik/ime> [--repo ...] [--out <datoteka>] [--stale-days <n>]",
    );
    process.exitCode = 2;
  } else {
    const github = process.env.GITHUB_TOKEN;
    const linear = process.env.LINEAR_API_KEY;
    const board = await composeBoard(
      args,
      {
        readFile: (path) => readFileSync(path, "utf8"),
        get: github
          ? (url) =>
              json(url, {
                headers: {
                  authorization: `Bearer ${github}`,
                  accept: "application/vnd.github+json",
                },
              })
          : null,
        linear: linear
          ? (query) =>
              json("https://api.linear.app/graphql", {
                method: "POST",
                headers: { authorization: linear, "content-type": "application/json" },
                body: JSON.stringify({ query }),
              })
          : null,
      },
      new Date(),
    );
    writeFileSync(args.out, buildBoard(board));
    console.log(`Vlasnička ploča: ${args.out}`);
  }
}
