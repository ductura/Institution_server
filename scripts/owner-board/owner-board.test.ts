// DAN-1569. Invented queue items, pull requests and issues only.
import assert from "node:assert/strict";

import { test } from "vitest";

import {
  buildBoard,
  ciOf,
  composeBoard,
  openByDeadline,
  parseArgs,
  parseOwnerQueue,
  pullRow,
  readPulls,
  readStale,
  verdictOn,
  type PullInput,
} from "./index.ts";

const STATE = `# Stanje rada

## Owner queue (samo Daniel)

Uvodni tekst. Rok: 1. 1. 2020.

- [x] Q-4: gotovo. Rok: 1. 1. 2026.
- [ ] Q-7, pentest. Rok: 30. 11. 2026. Radnja: vlasnik.
- [ ] Q-1, ugovor <b>. Rok: 22. 2. 2027. Rok: 13. 11. 2026. Radnja: vlasnik.
- [ ] FPZG AAI: ovlast za Lab. Blokira M1.

## Dalje

- [ ] Nije u redu čekanja. Rok: 1. 1. 2026.
`;

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const NO_RESULT_YET: unknown = JSON.parse('{"check_runs":[{"conclusion":null}]}');
const pull = (change: Partial<PullInput> = {}): PullInput => ({
  repo: "izmisljeni/repo",
  number: 7,
  title: "Izmišljeni PR",
  url: "https://github.com/izmisljeni/repo/pull/7",
  draft: false,
  headSha: HEAD,
  updatedAt: "2026-11-20T10:00:00Z",
  body: "Agent: x\nRisk: critical\nTask: DAN-1",
  comments: [`Review-Head: ${HEAD}\nReview-Verdict: PASS`, `QA-Head: ${HEAD}\nQA-Verdict: PASS`],
  checks: ["success", "skipped"],
  ...change,
});

test("the queue is read from its section only, open items by their earliest deadline", () => {
  const items = parseOwnerQueue(STATE);
  assert.deepEqual(
    items.map((item) => [item.done, item.label, item.deadlines]),
    [
      [true, "Q-4", ["2026-01-01"]],
      [false, "Q-7", ["2026-11-30"]],
      [false, "Q-1", ["2026-11-13", "2027-02-22"]],
      [false, "FPZG AAI", []],
    ],
  );
  assert.deepEqual(
    openByDeadline(items, "2026-11-25").map((item) => [item.label, item.deadline, item.overdue]),
    [
      ["Q-1", "2026-11-13", true],
      ["Q-7", "2026-11-30", false],
      ["FPZG AAI", null, false],
    ],
  );
  assert.equal(openByDeadline(items, "2026-11-13")[0]!.overdue, false);
  assert.deepEqual(parseOwnerQueue("# Bez reda čekanja\n- [ ] Q-1. Rok: 1. 1. 2026."), []);
});

test("a verdict counts only for the current head, and the newest one wins", () => {
  assert.equal(verdictOn(pull().comments, "Review", HEAD), "PASS");
  assert.equal(verdictOn([`Review-Head: ${OLD}\nReview-Verdict: PASS`], "Review", HEAD), null);
  assert.equal(
    verdictOn(
      [`QA-Head: ${HEAD}\nQA-Verdict: PASS`, `QA-Head: ${HEAD}\nQA-Verdict: FAIL`],
      "QA",
      HEAD,
    ),
    "FAIL",
  );
  assert.equal(verdictOn([`> Review-Head: ${HEAD}\n> Review-Verdict: PASS`], "Review", HEAD), null);
  assert.equal(verdictOn([`Review-Head: ${HEAD}\nReview-Verdict: MAYBE`], "Review", HEAD), null);
});

test("awaits the owner only when critical, ready, reviewed, tested and green on this head", () => {
  assert.equal(pullRow(pull()).awaitsOwner, true);
  for (const change of [
    { draft: true },
    { body: "Risk: standard" },
    { body: "nema retka" },
    { headSha: OLD },
    { comments: [`Review-Head: ${HEAD}\nReview-Verdict: PASS`] },
    { checks: ["success", "failure"] },
    { checks: ["success", null] },
    { checks: [] },
  ] satisfies Partial<PullInput>[]) {
    assert.equal(pullRow(pull(change)).awaitsOwner, false, JSON.stringify(change));
  }
  assert.equal(pullRow(pull({ body: "nema retka" })).risk, null);
  assert.deepEqual(
    [ciOf([]), ciOf(["success", null]), ciOf(["cancelled", null]), ciOf(["neutral"])],
    ["none", "running", "failed", "passed"],
  );
});

test("pull requests are read with GET requests of the named repository only", async () => {
  const asked: string[] = [];
  const get = (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes("/pulls?")) {
      return Promise.resolve(
        JSON.parse(
          `[{"number":7,"title":"Izmišljeni PR","html_url":"https://github.com/izmisljeni/repo/pull/7",` +
            `"draft":false,"updated_at":"2026-11-20T10:00:00Z","body":null,"head":{"sha":"${HEAD}"}}]`,
        ),
      );
    }
    if (url.includes("/check-runs")) return Promise.resolve(NO_RESULT_YET);
    if (url.includes("/reviews")) {
      return Promise.resolve([{ body: `QA-Head: ${HEAD}\nQA-Verdict: PASS` }, { body: null }]);
    }
    return Promise.resolve([{ body: `Review-Head: ${HEAD}\nReview-Verdict: PASS` }]);
  };
  const [read] = await readPulls("izmisljeni/repo", get);
  assert.deepEqual(read, pull({ body: "", checks: [null] }));
  assert.ok(asked.every((url) => url.startsWith("https://api.github.com/repos/izmisljeni/repo/")));
  assert.equal(asked.length, 4);
});

test("stale issues are those started at least the given days ago, oldest first", async () => {
  const nodes = [
    {
      identifier: "DAN-1",
      title: "Novo",
      url: "https://linear.app/x/DAN-1",
      startedAt: "2026-11-24T00:00:00Z",
    },
    {
      identifier: "DAN-2",
      title: "Staro",
      url: "https://linear.app/x/DAN-2",
      startedAt: "2026-11-10T00:00:00Z",
    },
    {
      identifier: "DAN-3",
      title: "Starije",
      url: "https://linear.app/x/DAN-3",
      startedAt: "2026-11-01T00:00:00Z",
    },
    {
      identifier: "DAN-4",
      title: "Bez početka",
      url: "https://linear.app/x/DAN-4",
      startedAt: null,
    },
  ];
  const stale = await readStale(
    () => Promise.resolve({ data: { issues: { nodes } } }),
    new Date("2026-11-25T12:00:00Z"),
    3,
  );
  assert.deepEqual(
    stale.map((issue) => [issue.id, issue.days]),
    [
      ["DAN-3", 24],
      ["DAN-2", 15],
    ],
  );
});

test("a verdict in a review written before an issue comment does not outrank it", async () => {
  const get = (url: string): Promise<unknown> => {
    if (url.includes("/pulls?")) {
      return Promise.resolve(
        JSON.parse(
          `[{"number":7,"title":"Izmišljeni PR","html_url":"https://github.com/izmisljeni/repo/pull/7",` +
            `"draft":false,"updated_at":"2026-11-20T10:00:00Z","body":null,"head":{"sha":"${HEAD}"}}]`,
        ),
      );
    }
    if (url.includes("/check-runs")) return Promise.resolve(NO_RESULT_YET);
    if (url.includes("/reviews")) {
      return Promise.resolve(
        JSON.parse('[{"body":"starija recenzija","submitted_at":"2026-11-20T09:00:00Z"}]'),
      );
    }
    return Promise.resolve(
      JSON.parse('[{"body":"noviji komentar","created_at":"2026-11-20T11:00:00Z"}]'),
    );
  };
  const [read] = await readPulls("izmisljeni/repo", get);
  assert.deepEqual(read?.comments, ["starija recenzija", "noviji komentar"]);
});

test("stale issues are filtered by Linear and read across every page", async () => {
  const asked: string[] = [];
  const node = (id: string) => ({
    identifier: id,
    title: "Izmišljeno",
    url: `https://linear.app/x/${id}`,
    startedAt: "2026-11-01T00:00:00Z",
  });
  const pages = [
    { nodes: [node("DAN-1")], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [node("DAN-2")], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const stale = await readStale(
    (query) => {
      asked.push(query);
      return Promise.resolve({ data: { issues: pages[asked.length - 1] } });
    },
    new Date("2026-11-25T12:00:00Z"),
    3,
  );
  assert.deepEqual(
    stale.map((issue) => issue.id),
    ["DAN-1", "DAN-2"],
  );
  assert.equal(asked.length, 2);
  assert.ok(asked[0]!.includes('startedAt: { lte: "2026-11-22T12:00:00.000Z" }'));
  assert.ok(asked[1]!.includes('after: "c1"'));
});

const NO_CHECKS: unknown = JSON.parse('{"check_runs":[]}');
const NOW = new Date("2026-11-25T12:00:00Z");
const ARGS = { state: "STATE.md", repos: ["izmisljeni/repo"], out: "x.html", staleDays: 3 };

test("the board names the source and time of every section and marks what is overdue", async () => {
  const board = await composeBoard(
    ARGS,
    {
      readFile: () => STATE,
      get: (url) =>
        Promise.resolve(url.includes("/pulls?") ? [] : url.includes("check-runs") ? NO_CHECKS : []),
      linear: () => Promise.resolve({ data: { issues: { nodes: [] } } }),
    },
    NOW,
  );
  const html = buildBoard(board);
  assert.equal(html.match(/Izvor: /g)?.length, 3);
  assert.equal(html.match(/pročitano 2026-11-25T12:00:00.000Z/g)?.length, 3);
  assert.match(html, /<tr class="overdue"><td>13\. 11\. 2026\. \(prekoračen\)<\/td><td>Q-1<\/td>/);
  assert.match(html, /<td>bez roka<\/td><td>FPZG AAI<\/td>/);
  assert.ok(html.includes("ugovor &lt;b&gt;") && !html.includes("<b>"));
  assert.ok(html.includes("Nema otvorenih PR-ova.") && html.includes("dulje od 3 dana"));
  assert.ok(!/<script|<link|src=/.test(html));
});

test("a source that cannot be read is shown as unread, never as empty, and no secret or message leaks", async () => {
  const SECRET = "ghp_izmisljenaTajna123";
  const failing = await composeBoard(
    ARGS,
    {
      readFile: () => {
        throw new Error(`ENOENT ${SECRET}`);
      },
      get: () => Promise.reject(new Error(`401 ${SECRET}`)),
      linear: () => Promise.reject(new Error(SECRET)),
    },
    NOW,
  );
  const html = buildBoard(failing);
  assert.equal(html.match(/Nije učitano: /g)?.length, 3);
  assert.ok(!html.includes(SECRET) && !html.includes("Nema otvorenih"));
  const without = buildBoard(
    await composeBoard(ARGS, { readFile: () => STATE, get: null, linear: null }, NOW),
  );
  assert.ok(
    without.includes("GITHUB_TOKEN nije zadan") && without.includes("LINEAR_API_KEY nije zadan"),
  );
});

test("a pull request that awaits the owner is marked and listed first", async () => {
  const rows = [pullRow(pull({ number: 1, draft: true })), pullRow(pull({ number: 2 }))];
  const board = await composeBoard(ARGS, { readFile: () => STATE, get: null, linear: null }, NOW);
  const html = buildBoard({ ...board, pulls: { source: "test", rows } });
  assert.match(
    html,
    /<tr class="owner"><td><a href="https:\/\/github.com\/izmisljeni\/repo\/pull\/7">izmisljeni\/repo#2<\/a>/,
  );
  assert.ok(html.includes("(nacrt)"));
  const unsafe = buildBoard({
    ...board,
    pulls: { source: "test", rows: [{ ...rows[0]!, url: "javascript:alert(1)", title: "<img>" }] },
  });
  assert.ok(!unsafe.includes("javascript:") && !unsafe.includes("<img>"));
});

test("arguments: a state file is required, a repository is owner/name, days are a small number", () => {
  assert.deepEqual(
    parseArgs(["--state", "S.md", "--repo", "a/b", "--repo", "c/d", "--stale-days", "5"]),
    {
      state: "S.md",
      repos: ["a/b", "c/d"],
      out: "owner-board.html",
      staleDays: 5,
    },
  );
  for (const bad of [
    [],
    ["--repo", "a/b"],
    ["--state"],
    ["--state", "S.md", "--repo", "a"],
    ["--state", "S.md", "--repo", "a/b/c"],
    ["--state", "S.md", "--stale-days", "0"],
    ["--state", "S.md", "--x", "1"],
  ]) {
    assert.equal(parseArgs(bad), null, JSON.stringify(bad));
  }
});
