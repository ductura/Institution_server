import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  diffStatus,
  outputs,
  planRelease,
  readTree,
  type Plan,
  type ReleaseIo,
  type Short,
} from "./auto.ts";

// DAN-804: the plan of release.yml from tags and staged packages. Invented data.
const SHA = "c".repeat(40);
const staged = (js: string) =>
  new Map([
    ["package.json", "{}"],
    ["index.d.ts", "export declare const A: 1;\n"],
    ["index.js", js],
  ]);
const io = (change: Partial<ReleaseIo> = {}): ReleaseIo => ({
  tags: ["test-fakes-v0.2.0", "test-fakes-v0.1.9", "contracts-v1.1.0"],
  ancestorCommit: () => SHA,
  stagedAt: () => staged("1"),
  stagedHead: () => staged("2"),
  generatorChanged: () => false,
  floor: () => "0.2.0",
  ...change,
});

describe("planRelease", () => {
  it("plans the next patch from the last tag", () => {
    expect(planRelease("test-fakes", io())).toMatchObject({
      level: "patch",
      release: "test-fakes-v0.2.1",
    });
  });

  it("plans nothing when the staged package did not change", () => {
    const plan = planRelease("test-fakes", io({ stagedHead: () => staged("1") }));
    expect(plan).toEqual({ level: "none", reasons: [] });
  });

  // POTVRDA UGOVORA w804a t. 4: a failure is blocked, never patch.
  it("is blocked when staging the old package fails", () => {
    const failing = () => {
      throw new Error("pnpm install failed (1)");
    };
    const plan = planRelease("test-fakes", io({ stagedAt: failing }));
    expect(plan.level).toBe("blocked");
    expect(plan.release).toBeUndefined();
    expect(plan.reasons.join()).toMatch(/pnpm install failed/);
  });

  it.each([
    ["no tag of the package", { tags: ["contracts-v1.1.0", "test-fakes-v0.2.0-rc.1"] }],
    ["a last tag that is not an ancestor", { ancestorCommit: () => null }],
    [
      "git failing",
      {
        ancestorCommit: () => {
          throw new Error("git merge-base failed (128)");
        },
      },
    ],
    ["a pending major in package.json", { floor: () => "1.0.0" }],
    ["an unreadable package.json version", { floor: () => "undefined" }],
  ])("is blocked for %s", (_, change) => {
    const plan = planRelease("test-fakes", io(change as Partial<ReleaseIo>));
    expect(plan.level).toBe("blocked");
    expect(plan.release).toBeUndefined();
  });

  it("stops at a major and tags nothing", () => {
    const removed = new Map([...staged("2")].filter(([path]) => path !== "index.d.ts"));
    const plan = planRelease("test-fakes", io({ stagedHead: () => removed }));
    expect(plan.level).toBe("major");
    expect(plan.release).toBeUndefined();
  });
});

describe("outputs", () => {
  it("lists the tags to create and the packages that stopped", () => {
    const plans = new Map<Short, Plan>([
      ["contracts", { level: "major", reasons: [] }],
      ["test-fakes", { level: "minor", reasons: [], release: "test-fakes-v0.3.0" }],
    ]);
    expect(outputs(plans)).toBe("releases=test-fakes-v0.3.0\nstopped=contracts:major\n");
    expect(outputs(new Map())).toBe("releases=\nstopped=\n");
  });
});

describe("planRelease with a staged file that is not UTF-8", () => {
  it("is blocked when reading the staged package throws", () => {
    const notUtf8 = () => {
      throw new TypeError("The encoded data was not valid for encoding utf-8");
    };
    expect(
      planRelease("contracts", io({ tags: ["contracts-v1.1.0"], stagedHead: notUtf8 })).level,
    ).toBe("blocked");
  });
});

// QA #92 (c.6906080709): a failing git diff and a version raised alone.
describe("QA findings on #92", () => {
  it("reads git diff --quiet strictly: 0 same, 1 changed, anything else throws", () => {
    expect(diffStatus(0)).toBe(false);
    expect(diffStatus(1)).toBe(true);
    for (const status of [128, 2, null])
      expect(() => diffStatus(status)).toThrow(/git diff failed/);
  });

  it("is blocked, not patch, when the generator check fails", () => {
    const failing = () => diffStatus(128);
    const plan = planRelease("test-fakes", io({ generatorChanged: failing }));
    expect(plan.level).toBe("blocked");
    expect(plan.release).toBeUndefined();
  });

  it.each([
    ["a major raised alone", "1.0.0", /major awaits/],
    ["a pre-release version", "0.3.0-rc.1", /not X\.Y\.Z/],
    ["an unreadable version", "undefined", /not X\.Y\.Z/],
  ])("is blocked for %s with no other change", (_, floor, reason) => {
    const plan = planRelease(
      "test-fakes",
      io({ stagedHead: () => staged("1"), floor: () => floor }),
    );
    expect(plan.level).toBe("blocked");
    expect(plan.reasons.join()).toMatch(reason);
    expect(outputs(new Map([["test-fakes", plan]]))).toBe(
      "releases=\nstopped=test-fakes:blocked\n",
    );
  });

  it("stays none when only the version rose on the same major", () => {
    const plan = planRelease(
      "test-fakes",
      io({ stagedHead: () => staged("1"), floor: () => "0.3.0" }),
    );
    expect(plan).toEqual({ level: "none", reasons: [] });
  });
});

// Second review on #92 (c.6906342227): a BOM is part of the bytes.
describe("readTree", () => {
  it("keeps a UTF-8 BOM, so adding one is a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-tree-"));
    try {
      writeFileSync(join(dir, "README.md"), "Lažne zamjene\n");
      const plain = readTree(dir).get("README.md");
      writeFileSync(
        join(dir, "README.md"),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Lažne zamjene\n")]),
      );
      const withBom = readTree(dir).get("README.md");
      expect(withBom).not.toBe(plain);
      expect(withBom?.charCodeAt(0)).toBe(0xfeff);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for bytes that are not UTF-8", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-tree-"));
    try {
      writeFileSync(join(dir, "data.bin"), Buffer.from([0xff, 0xfe]));
      expect(() => readTree(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
