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

function setup(event: unknown, pages: unknown[], status = 200) {
  const dir = mkdtempSync(join(tmpdir(), "floor-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  const urls: string[] = [];
  const fetchImpl = (url: string) => {
    urls.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "0");
    return Promise.resolve(
      status === 200 ? Response.json(pages[page - 1] ?? []) : new Response("error", { status }),
    );
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
    expect(await pullRequestFloor(low.env, low.fetchImpl)).toBe("low");
    expect(low.urls[0]).toBe(
      `https://api.example.test/repos/${repository}/pulls/7/files?per_page=100&page=1`,
    );
    const standard = setup(pr, [files("README.md", "server/logs/log.ts")]);
    expect(await pullRequestFloor(standard.env, standard.fetchImpl)).toBe("standard");
  });

  it("reads every page and counts a rename under both names", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/n${i}.md` }));
    const paged = setup(pr, [filler, files("server/database/actor.ts")]);
    expect(await pullRequestFloor(paged.env, paged.fetchImpl)).toBe("critical");
    expect(paged.urls).toHaveLength(2);
    const renamed = setup(pr, [
      wire('[{"filename":"docs/old.md","previous_filename":".github/workflows/ci.yml"}]'),
    ]);
    expect(await pullRequestFloor(renamed.env, renamed.fetchImpl)).toBe("critical");
  });

  it("fails closed to critical", async () => {
    const apiError = setup(pr, [], 502);
    expect(await pullRequestFloor(apiError.env, apiError.fetchImpl)).toBe("critical");
    const noPr = setup({ issue: { number: 7 } }, [files("README.md")]);
    expect(await pullRequestFloor(noPr.env, noPr.fetchImpl)).toBe("critical");
    const nameless = setup(pr, [[{ status: "added" }]]);
    expect(await pullRequestFloor(nameless.env, nameless.fetchImpl)).toBe("critical");
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/n${i}.md` }));
    const cut = setup(
      pr,
      Array.from({ length: 30 }, () => full),
    );
    expect(await pullRequestFloor(cut.env, cut.fetchImpl)).toBe("critical");
    const badRepo = setup(pr, [files("README.md")]);
    expect(
      await pullRequestFloor(
        Object.fromEntries([...Object.entries(badRepo.env), ["GITHUB_REPOSITORY", "x"]]),
        badRepo.fetchImpl,
      ),
    ).toBe("critical");
  });
});

describe("engineering-gate.yml", () => {
  it("pins the shared check and its gate-sha to the same full SHA", () => {
    const pinned =
      /uses: ductura\/\.github\/\.github\/workflows\/engineering-gate\.yml@([0-9a-f]{40}) #/.exec(
        GATE,
      )?.[1];
    expect(pinned).toBeDefined();
    expect(GATE).toContain(`gate-sha: ${pinned}\n`);
    for (const [, action] of GATE.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      expect(action).toMatch(/^[a-z0-9.-]+\/[a-z0-9./-]+@[0-9a-f]{40}$/);
    }
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
