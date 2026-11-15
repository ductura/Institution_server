// Risk floor of a pull request for the engineering gate, and the workflow
// that calls the shared verdict check. Invented repository and files only.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pullNumber, pullRequestFloor } from "./floor.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const GATE = readFileSync(resolve(ROOT, ".github/workflows/engineering-gate.yml"), "utf8");
const repository = "example-org/example";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

function setup(event: unknown, pages: unknown[], status = 200, heads = [HEAD, HEAD]) {
  const dir = mkdtempSync(join(tmpdir(), "floor-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  const urls: string[] = [];
  let headReads = 0;
  const fetchImpl = (url: string) => {
    urls.push(url);
    if (status !== 200) return Promise.resolve(new Response("error", { status }));
    if (!url.includes("/files?")) {
      const sha = heads[Math.min(headReads, heads.length - 1)];
      headReads += 1;
      return Promise.resolve(Response.json({ number: 7, head: { sha } }));
    }
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "0");
    return Promise.resolve(Response.json(pages[page - 1] ?? []));
  };
  // GitHub's own environment names, which the naming rule would reject as keys.
  const env: Record<string, string> = Object.fromEntries([
    ["GITHUB_REPOSITORY", repository],
    ["GITHUB_EVENT_PATH", eventPath],
    ["GITHUB_API_URL", "https://api.example.test"],
    ["GITHUB_TOKEN", "test-token"],
  ]);
  return { env, fetchImpl, urls };
}

const files = (...names: string[]) => names.map((filename) => ({ filename }));
// REST and event payloads in GitHub's snake_case wire names.
const wire = (json: string): unknown => JSON.parse(json);
const pr = wire('{"pull_request":{"number":7}}');

describe("pullNumber", () => {
  it("reads a pull request or a comment on one, nothing else", () => {
    expect(pullNumber(pr)).toBe(7);
    expect(pullNumber(wire('{"issue":{"number":7,"pull_request":{}}}'))).toBe(7);
    expect(pullNumber({ issue: { number: 7 } })).toBeNull();
    expect(pullNumber(wire('{"pull_request":{"number":"7"}}'))).toBeNull();
  });
});

describe("pullRequestFloor", () => {
  it("gives the floor of the changed paths", async () => {
    const low = setup(pr, [files("README.md")]);
    expect(await pullRequestFloor(low.env, low.fetchImpl)).toEqual({ risk: "low", headSha: HEAD });
    expect(low.urls).toEqual([
      `https://api.example.test/repos/${repository}/pulls/7`,
      `https://api.example.test/repos/${repository}/pulls/7/files?per_page=100&page=1`,
      `https://api.example.test/repos/${repository}/pulls/7`,
    ]);
    const standard = setup(pr, [files("README.md", "server/logs/log.ts")]);
    expect((await pullRequestFloor(standard.env, standard.fetchImpl)).risk).toBe("standard");
  });

  it("reads every page and counts a rename under both names", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/n${i}.md` }));
    const paged = setup(pr, [filler, files("server/database/actor.ts")]);
    expect((await pullRequestFloor(paged.env, paged.fetchImpl)).risk).toBe("critical");
    expect(paged.urls.filter((url) => url.includes("/files?"))).toHaveLength(2);
    const renamed = setup(pr, [
      wire('[{"filename":"docs/old.md","previous_filename":".github/workflows/ci.yml"}]'),
    ]);
    expect((await pullRequestFloor(renamed.env, renamed.fetchImpl)).risk).toBe("critical");
  });

  it("gives critical for the first head when the head moves during the read", async () => {
    const moved = setup(pr, [files("README.md")], 200, [HEAD, NEXT]);
    expect(await pullRequestFloor(moved.env, moved.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
  });

  it("gives no head SHA when the head is unknown or not a full SHA", async () => {
    const short = setup(pr, [files("README.md")], 200, ["abc123"]);
    expect(await pullRequestFloor(short.env, short.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
  });

  it("fails closed to critical", async () => {
    const apiError = setup(pr, [], 502);
    expect(await pullRequestFloor(apiError.env, apiError.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
    const noPr = setup({ issue: { number: 7 } }, [files("README.md")]);
    expect(await pullRequestFloor(noPr.env, noPr.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
    const nameless = setup(pr, [[{ status: "added" }]]);
    expect((await pullRequestFloor(nameless.env, nameless.fetchImpl)).risk).toBe("critical");
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/n${i}.md` }));
    const cut = setup(
      pr,
      Array.from({ length: 30 }, () => full),
    );
    expect((await pullRequestFloor(cut.env, cut.fetchImpl)).risk).toBe("critical");
    const badRepo = setup(pr, [files("README.md")]);
    expect(
      await pullRequestFloor(
        Object.fromEntries([...Object.entries(badRepo.env), ["GITHUB_REPOSITORY", "x"]]),
        badRepo.fetchImpl,
      ),
    ).toEqual({ risk: "critical", headSha: "" });
  });
});

describe("engineering-gate.yml", () => {
  it("pins the shared check and its gate-sha to the same full SHA", () => {
    const pinned =
      /uses: ductura\/\.github\/\.github\/workflows\/engineering-gate\.yml@([0-9a-f]{40}) #/.exec(
        GATE,
      )?.[1];
    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    expect(GATE).toContain(`gate-sha: ${pinned}\n`);
    // Every reusable workflow and action, with or without a leading dash.
    const refs = [...GATE.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    expect(refs).toHaveLength(3);
    for (const [, action] of GATE.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      expect(action).toMatch(/^[a-z0-9.-]+\/[a-z0-9./-]+@[0-9a-f]{40}$/);
    }
  });

  it("passes every required input of the shared check and nothing unknown", () => {
    const withBlock = /^ {4}with:\n((?: {6}\S.*\n)+)/m.exec(GATE.slice(GATE.indexOf("  gate:")));
    const keys = [...(withBlock?.[1] ?? "").matchAll(/^ {6}([\w-]+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(["gate-sha", "owner-login", "minimum-risk", "floor-sha"]);
    expect(GATE).toContain("floor-sha: ${{ needs.floor.outputs.head-sha }}\n");
    expect(GATE).toContain("head-sha: ${{ steps.floor.outputs.head-sha }}\n");
  });

  it("triggers only on default-branch events and never checks out PR code", () => {
    const triggers = /^on:.*\n((?: {2}.*\n)+)/m.exec(GATE)?.[1] ?? "";
    expect([...triggers.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])).toEqual([
      "pull_request_target",
      "issue_comment",
    ]);
    // One checkout, of the default branch; no other ref, repository or fetch.
    expect([...GATE.matchAll(/uses: actions\/checkout@/g)]).toHaveLength(1);
    expect([...GATE.matchAll(/^\s*ref:\s*(.+)$/gm)].map((match) => match[1])).toEqual([
      "${{ github.event.repository.default_branch }}",
    ]);
    expect(GATE).not.toMatch(
      /^\s*repository:|git (?:fetch|checkout|clone)|refs\/pull|merge_commit/m,
    );
    expect(GATE).not.toMatch(/github\.event\.(?:pull_request|issue)\.(?:head|title|body)/);
    expect(GATE).toContain('run: node scripts/engineering/floor.ts >> "$GITHUB_OUTPUT"');
  });

  it("runs only default-branch code and writes nothing but statuses", () => {
    expect(GATE).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(GATE).toMatch(/^permissions: \{\}$/m);
    expect([...GATE.matchAll(/: write$/gm)].map((match) => match.index)).toHaveLength(1);
    expect(GATE).toContain("      statuses: write\n");
    expect(GATE).not.toMatch(/github\.event\.pull_request\.head|head\.sha|head_ref|secrets\./);
    expect(GATE).toContain("persist-credentials: false");
    expect(GATE).toContain("minimum-risk: ${{ needs.floor.outputs.risk }}");
  });
});
