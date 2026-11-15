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

const BASE = "c".repeat(40);
const OTHER_BASE = "d".repeat(40);

type Comparison = { status?: unknown; commits?: unknown; files?: unknown };

/**
 * A fake GitHub API. `heads` and `bases` are the SHAs of successive PR reads.
 * `compares` maps `base...head` to the comparison GitHub would return for
 * those immutable SHAs; a plain file list becomes a comparison ending at its
 * head.
 */
function setup(
  event: unknown,
  compares: Record<string, unknown[] | Comparison>,
  status = 200,
  heads = [HEAD, HEAD],
  bases = [BASE, BASE],
  { baseRefs = ["main"], changed }: { baseRefs?: string[]; changed?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "floor-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  const urls: string[] = [];
  let pullReads = 0;
  const fetchImpl = (url: string) => {
    urls.push(url);
    if (status !== 200) return Promise.resolve(new Response("error", { status }));
    const compare = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-z]+)$/.exec(url);
    if (compare) {
      const value = compares[`${compare[1]}...${compare[2]}`];
      if (value === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
      const body = Array.isArray(value)
        ? { status: "ahead", commits: [{ sha: "e".repeat(40) }, { sha: compare[2] }], files: value }
        : value;
      return Promise.resolve(Response.json(body));
    }
    const sha = heads[Math.min(pullReads, heads.length - 1)];
    const base = bases[Math.min(pullReads, bases.length - 1)];
    pullReads += 1;
    const listed = compares[`${base}...${sha}`];
    const count = Array.isArray(listed)
      ? listed.length
      : Array.isArray(listed?.files)
        ? listed.files.length
        : 1;
    return Promise.resolve(
      Response.json({
        number: 7,
        head: { sha },
        base: { sha: base, ref: baseRefs[Math.min(pullReads - 1, baseRefs.length - 1)] },
        // GitHub never reports zero files for an open PR.
        ["changed_files"]: changed ?? Math.max(count, 1),
      }),
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

const at = (head: string, list: unknown[]) => ({ [`${BASE}...${head}`]: list });

const files = (...names: string[]) => names.map((filename) => ({ filename }));
// REST and event payloads in GitHub's snake_case wire names.
const wire = (json: string): unknown => JSON.parse(json);
const pr = wire('{"pull_request":{"number":7},"repository":{"default_branch":"main"}}');

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
    const low = setup(pr, at(HEAD, files("README.md")));
    expect(await pullRequestFloor(low.env, low.fetchImpl)).toEqual({ risk: "low", headSha: HEAD });
    expect(low.urls).toEqual([
      `https://api.example.test/repos/${repository}/pulls/7`,
      `https://api.example.test/repos/${repository}/compare/${BASE}...${HEAD}`,
      `https://api.example.test/repos/${repository}/pulls/7`,
    ]);
    const standard = setup(pr, at(HEAD, files("README.md", "server/logs/log.ts")));
    expect((await pullRequestFloor(standard.env, standard.fetchImpl)).risk).toBe("standard");
  });

  it("reads the whole list and counts a rename under both names", async () => {
    const filler = Array.from({ length: 298 }, (_, i) => ({ filename: `docs/n${i}.md` }));
    const long = setup(pr, at(HEAD, [...filler, ...files("server/database/actor.ts")]));
    expect(await pullRequestFloor(long.env, long.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
    const renamed = setup(
      pr,
      at(
        HEAD,
        wire(
          '[{"filename":"docs/old.md","previous_filename":".github/workflows/ci.yml"}]',
        ) as unknown[],
      ),
    );
    expect((await pullRequestFloor(renamed.env, renamed.fetchImpl)).risk).toBe("critical");
  });

  it("gives critical for the first head when the head moves during the read", async () => {
    const moved = setup(
      pr,
      { ...at(HEAD, files("README.md")), ...at(NEXT, files("README.md")) },
      200,
      [HEAD, NEXT],
    );
    expect(await pullRequestFloor(moved.env, moved.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
  });

  it("reads the files of the returned head when the head goes A to B and back", async () => {
    // A changes a critical path, B only the README. Both PR reads see A; the
    // list is that of A by its SHA, whatever the branch pointed at meanwhile.
    const aba = setup(pr, {
      ...at(HEAD, files("server/database/actor.ts")),
      ...at(NEXT, files("README.md")),
    });
    expect(await pullRequestFloor(aba.env, aba.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
    expect(aba.urls.filter((url) => url.includes("/compare/"))).toEqual([
      `https://api.example.test/repos/${repository}/compare/${BASE}...${HEAD}`,
    ]);
    expect(aba.urls.some((url) => url.includes("/files"))).toBe(false);
  });

  it("gives critical when the comparison is not that of the head", async () => {
    const wrongEnd = setup(pr, {
      [`${BASE}...${HEAD}`]: {
        status: "ahead",
        commits: [{ sha: NEXT }],
        files: files("README.md"),
      },
    });
    expect(await pullRequestFloor(wrongEnd.env, wrongEnd.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
    for (const bad of [
      { status: "identical", commits: [{ sha: HEAD }], files: files("README.md") },
      { status: "behind", commits: [{ sha: HEAD }], files: files("README.md") },
      { status: "ahead", commits: [], files: files("README.md") },
      { status: "ahead", files: files("README.md") },
      { status: "ahead", commits: [{ sha: HEAD }], files: [] },
      { status: "ahead", commits: [{ sha: HEAD }] },
      { status: "ahead", commits: [{ sha: HEAD }], files: [null] },
      { status: "ahead", commits: [null], files: files("README.md") },
      { status: "ahead", commits: [{ sha: HEAD }, null], files: files("README.md") },
      {
        status: "ahead",
        commits: [{ sha: HEAD }],
        files: wire('[{"filename":"README.md","previous_filename":7}]'),
      },
      {
        status: "ahead",
        commits: [{ sha: HEAD }],
        files: wire('[{"filename":"README.md","previous_filename":""}]'),
      },
    ]) {
      const run = setup(pr, { [`${BASE}...${HEAD}`]: bad });
      expect(await pullRequestFloor(run.env, run.fetchImpl)).toEqual({
        risk: "critical",
        headSha: HEAD,
      });
    }
  });

  it("gives critical when the base moves during the read", async () => {
    const based = setup(
      pr,
      { ...at(HEAD, files("README.md")), [`${OTHER_BASE}...${HEAD}`]: files("README.md") },
      200,
      [HEAD, HEAD],
      [BASE, OTHER_BASE],
    );
    expect(await pullRequestFloor(based.env, based.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
  });

  it("gives no head SHA when the head is unknown or not a full SHA", async () => {
    const short = setup(pr, at(HEAD, files("README.md")), 200, ["abc123"]);
    expect(await pullRequestFloor(short.env, short.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
    const noBase = setup(pr, at(HEAD, files("README.md")), 200, [HEAD], ["abc123"]);
    expect(await pullRequestFloor(noBase.env, noBase.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
  });

  it("fails closed to critical", async () => {
    const apiError = setup(pr, {}, 502);
    expect(await pullRequestFloor(apiError.env, apiError.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
    const noPr = setup({ issue: { number: 7 } }, at(HEAD, files("README.md")));
    expect(await pullRequestFloor(noPr.env, noPr.fetchImpl)).toEqual({
      risk: "critical",
      headSha: "",
    });
    const nameless = setup(pr, at(HEAD, [{ status: "added" }]));
    expect((await pullRequestFloor(nameless.env, nameless.fetchImpl)).risk).toBe("critical");
    const missing = setup(pr, {});
    expect((await pullRequestFloor(missing.env, missing.fetchImpl)).risk).toBe("critical");
    const badRepo = setup(pr, at(HEAD, files("README.md")));
    expect(
      await pullRequestFloor(
        Object.fromEntries([...Object.entries(badRepo.env), ["GITHUB_REPOSITORY", "x"]]),
        badRepo.fetchImpl,
      ),
    ).toEqual({ risk: "critical", headSha: "" });
  });

  it("gives critical when the counts of files differ", async () => {
    const fewer = setup(pr, at(HEAD, files("README.md")), 200, [HEAD, HEAD], [BASE, BASE], {
      changed: 2,
    });
    expect(await pullRequestFloor(fewer.env, fewer.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
  });

  it("gives critical unless the pull request is into the default branch", async () => {
    const side = setup(pr, at(HEAD, files("README.md")), 200, [HEAD, HEAD], [BASE, BASE], {
      baseRefs: ["release"],
    });
    expect(await pullRequestFloor(side.env, side.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
    const retargeted = setup(pr, at(HEAD, files("README.md")), 200, [HEAD, HEAD], [BASE, BASE], {
      baseRefs: ["main", "release"],
    });
    expect((await pullRequestFloor(retargeted.env, retargeted.fetchImpl)).risk).toBe("critical");
    const noDefault = setup(wire('{"pull_request":{"number":7}}'), at(HEAD, files("README.md")));
    expect((await pullRequestFloor(noDefault.env, noDefault.fetchImpl)).risk).toBe("critical");
  });

  it("accepts a diverged comparison that ends at the head", async () => {
    const diverged = setup(pr, {
      [`${BASE}...${HEAD}`]: {
        status: "diverged",
        commits: [{ sha: HEAD }],
        files: files("README.md"),
      },
    });
    expect(await pullRequestFloor(diverged.env, diverged.fetchImpl)).toEqual({
      risk: "low",
      headSha: HEAD,
    });
  });

  it("gives critical when the list may be cut", async () => {
    // GitHub lists at most 300 files of a comparison; 300 may be a cut list,
    // and a cut list of only low paths must never give a lower floor.
    const full = Array.from({ length: 300 }, (_, i) => ({ filename: `docs/n${i}.md` }));
    const cut = setup(pr, at(HEAD, full));
    expect(await pullRequestFloor(cut.env, cut.fetchImpl)).toEqual({
      risk: "critical",
      headSha: HEAD,
    });
    const over = setup(pr, at(HEAD, [...full, { filename: "docs/extra.md" }]));
    expect((await pullRequestFloor(over.env, over.fetchImpl)).risk).toBe("critical");
    const under = setup(pr, at(HEAD, full.slice(1)));
    expect((await pullRequestFloor(under.env, under.fetchImpl)).risk).toBe("low");
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
