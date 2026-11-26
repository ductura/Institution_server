// DAN-1567, part 3. Invented addresses (.invalid) and an invented repository.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { test } from "vitest";
import { parse } from "yaml";

import {
  findOpenIssue,
  ISSUE_AUTHOR,
  ISSUE_TITLE,
  isProbeUrl,
  issueBody,
  main,
  nextAction,
  probeReady,
  type Fetcher,
  type GitHub,
} from "./index.ts";

const URL_OK = "https://ustanova.example.invalid/api/v1/ready";
const REPO = "izmisljeni/repo";
const NOW = "2026-11-26T10:00:00.000Z";
const answers =
  (status: number): Fetcher =>
  () =>
    Promise.resolve({ status });

test("the address is https, the contract's path, and nothing else", () => {
  assert.equal(isProbeUrl(URL_OK), true);
  for (const bad of [
    undefined,
    "",
    "ustanova.example.invalid/api/v1/ready",
    "http://ustanova.example.invalid/api/v1/ready",
    "https://korisnik:tajna@ustanova.example.invalid/api/v1/ready",
    "https://ustanova.example.invalid/api/v1/ready?x=1",
    "https://ustanova.example.invalid/api/v1/ready#x",
    "https://ustanova.example.invalid/api/v1/health",
    "https://ustanova.example.invalid/",
  ]) {
    assert.equal(isProbeUrl(bad), false, String(bad));
  }
});

test("up is exactly 200; a redirect, an error status, a refused connection and a timeout are down", async () => {
  assert.deepEqual(await probeReady(URL_OK, answers(200)), { up: true });
  for (const status of [204, 301, 401, 503]) {
    assert.deepEqual(await probeReady(URL_OK, answers(status)), {
      up: false,
      reason: "status",
      status,
    });
  }
  const refused: Fetcher = () => Promise.reject(new Error("ECONNREFUSED tajna"));
  assert.deepEqual(await probeReady(URL_OK, refused), { up: false, reason: "unreachable" });
  const hangs: Fetcher = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  assert.deepEqual(await probeReady(URL_OK, hangs, 20), { up: false, reason: "timeout" });
  let seen: Parameters<Fetcher>[1] | undefined;
  await probeReady(URL_OK, (_url, init) => {
    seen = init;
    return Promise.resolve({ status: 200 });
  });
  assert.equal(seen?.redirect, "manual");
  assert.equal(seen?.cache, "no-store");
});

test("a failure opens one issue, the next failures rewrite it, a success closes it", () => {
  const down = { up: false, reason: "status", status: 503 } as const;
  assert.deepEqual(nextAction({ up: true }, null, NOW), { kind: "none" });
  const opened = nextAction(down, null, NOW);
  assert.deepEqual(opened, {
    kind: "open",
    title: ISSUE_TITLE,
    body: issueBody(NOW, NOW, 1, "HTTP 503"),
  });

  const later = "2026-11-26T10:15:00.000Z";
  const body = opened.kind === "open" ? opened.body : "";
  const second = nextAction({ up: false, reason: "timeout" }, { number: 9, body }, later);
  assert.deepEqual(second, {
    kind: "refresh",
    number: 9,
    body: issueBody(NOW, later, 2, "nema odgovora u roku"),
  });
  const third = nextAction(
    down,
    { number: 9, body: second.kind === "refresh" ? second.body : "" },
    later,
  );
  assert.match(third.kind === "refresh" ? third.body : "", /^Uzastopnih padova: 3$/m);

  assert.deepEqual(nextAction({ up: true }, { number: 9, body }, later), {
    kind: "close",
    number: 9,
    comment: `Provjera spremnosti opet dobiva 200 (${later}).`,
  });
});

test("a body that is not ours starts the count again instead of trusting it", () => {
  const down = { up: false, reason: "unreachable" } as const;
  for (const body of [
    "",
    "Prvi pad: jučer\nUzastopnih padova: 4",
    "Prvi pad: 2026-11-26T10:00:00.000Z\nUzastopnih padova: -1",
  ]) {
    assert.deepEqual(nextAction(down, { number: 3, body }, NOW), {
      kind: "refresh",
      number: 3,
      body: issueBody(NOW, NOW, 1, "veza nije uspostavljena"),
    });
  }
});

const PULL = JSON.parse('{"pull_request":{}}') as Record<string, unknown>;

function fakeGitHub(issues: Record<string, unknown>[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const github: GitHub = (method, path, body) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return Promise.resolve(method === "GET" ? issues : {});
  };
  return { calls, github };
}
const env = (url: string | undefined, repo: string): Record<string, string | undefined> =>
  Object.fromEntries([
    ["READY_URL", url],
    ["GITHUB_REPOSITORY", repo],
  ]);
const ENV = env(URL_OK, REPO);
const clock = () => new Date(NOW);

test("the issue is ours by author and exact title, and never a pull request", async () => {
  const { calls, github } = fakeGitHub([
    { number: 1, title: `${ISSUE_TITLE} (stari)`, body: "x" },
    { number: 2, title: ISSUE_TITLE, body: "x", ...PULL },
    { number: 3, title: ISSUE_TITLE, body: null },
  ]);
  assert.deepEqual(await findOpenIssue(github, REPO), { number: 3, body: "" });
  assert.equal(
    calls[0]!.path,
    `/repos/${REPO}/issues?state=open&creator=${encodeURIComponent(ISSUE_AUTHOR)}&per_page=100&page=1`,
  );
  assert.equal(await findOpenIssue(fakeGitHub([]).github, REPO), null);
});

test("the issue is found past a full first page", async () => {
  const other = Array.from({ length: 100 }, (_, i) => ({
    number: 100 + i,
    title: "Drugo",
    body: "",
  }));
  const paths: string[] = [];
  const github: GitHub = (_method, path) => {
    paths.push(path);
    return Promise.resolve(
      path.endsWith("&page=1") ? other : [{ number: 7, title: ISSUE_TITLE, body: "b" }],
    );
  };
  assert.deepEqual(await findOpenIssue(github, REPO), { number: 7, body: "b" });
  assert.equal(paths.length, 2);
  assert.ok(paths[1]!.endsWith("&page=2"));
});

test("a run records the look: opens, rewrites, closes with a comment, or does nothing", async () => {
  const opens = fakeGitHub([]);
  assert.deepEqual(await main(ENV, answers(503), opens.github, clock), {
    code: 0,
    line: "ready: down; issue: open",
  });
  assert.deepEqual(opens.calls[1], {
    method: "POST",
    path: `/repos/${REPO}/issues`,
    body: { title: ISSUE_TITLE, body: issueBody(NOW, NOW, 1, "HTTP 503") },
  });

  const open = [{ number: 7, title: ISSUE_TITLE, body: issueBody(NOW, NOW, 1, "HTTP 503") }];
  const rewrites = fakeGitHub(open);
  await main(ENV, answers(503), rewrites.github, clock);
  assert.deepEqual(
    rewrites.calls.slice(1).map((call) => `${call.method} ${call.path}`),
    [`PATCH /repos/${REPO}/issues/7`],
  );

  const closes = fakeGitHub(open);
  assert.equal(
    (await main(ENV, answers(200), closes.github, clock)).line,
    "ready: up; issue: close",
  );
  assert.deepEqual(closes.calls.slice(1), [
    {
      method: "POST",
      path: `/repos/${REPO}/issues/7/comments`,
      body: { body: `Provjera spremnosti opet dobiva 200 (${NOW}).` },
    },
    { method: "PATCH", path: `/repos/${REPO}/issues/7`, body: { state: "closed" } },
  ]);

  const quiet = fakeGitHub([]);
  assert.equal((await main(ENV, answers(200), quiet.github, clock)).line, "ready: up; issue: none");
  assert.equal(quiet.calls.length, 1);
});

test("a bad setting stops before any request, and a failed record is exit 1 without the address", async () => {
  const none = fakeGitHub([]);
  let fetched = 0;
  const counting: Fetcher = () => {
    fetched += 1;
    return Promise.resolve({ status: 200 });
  };
  assert.equal((await main(env(undefined, REPO), counting, none.github)).code, 2);
  assert.equal((await main(env(URL_OK, "repo"), counting, none.github)).code, 2);
  assert.equal(fetched + none.calls.length, 0);

  const failing: GitHub = () => Promise.reject(new Error(`403 ${URL_OK}`));
  const result = await main(ENV, answers(503), failing, clock);
  assert.deepEqual(result, { code: 1, line: "ready: down; issue: could not be recorded" });
  assert.ok(!result.line.includes("example.invalid"));
});

test("the workflow runs only with the variable set, on a schedule, and may write issues only", () => {
  const text = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/uptime.yml"),
    "utf8",
  );
  const workflow = parse(text, { uniqueKeys: true, merge: false }) as {
    on: { schedule: { cron: string }[] };
    permissions: unknown;
    jobs: { probe: { if: string; permissions: unknown; steps: { uses?: string; run?: string }[] } };
  };
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.probe.permissions, { contents: "read", issues: "write" });
  assert.equal(workflow.jobs.probe.if, "vars.READY_URL != ''");
  assert.equal(workflow.on.schedule.length, 1);
  assert.ok(!text.includes("secrets."));
  for (const step of workflow.jobs.probe.steps) {
    if (step.uses !== undefined) assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  }
  assert.equal(workflow.jobs.probe.steps.at(-1)?.run, "node scripts/uptime/cli.ts");
});
