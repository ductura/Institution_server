import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciProfile, classifyDiff, isOrdinaryDoc, jobsFor } from "./index.ts";

const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);

/** One `git diff --raw -z --abbrev=40` record. */
function record(path: string, status = "M", before = "100644", after = "100644"): string {
  const modes =
    status === "A" ? ["000000", after] : status === "D" ? [before, "000000"] : [before, after];
  const left = status === "A" ? ZERO : SHA;
  const right = status === "D" ? ZERO : SHA;
  return `:${modes[0]} ${modes[1]} ${left} ${right} ${status}\0${path}\0`;
}

describe("classifyDiff: path to jobs", () => {
  it.each([
    ["docs/PLAN.md"],
    ["docs/plan/val-1.md"],
    ["README.md"],
    ["server/contracts/README.md"],
    ["scripts/ci/README.md"],
  ])("%s alone needs no database job", (path) => {
    expect(classifyDiff(record(path))).toBe("docs");
    expect(jobsFor("docs")).toEqual(["checks"]);
  });

  it("an added and a deleted document are still docs", () => {
    expect(classifyDiff(record("docs/new.md", "A") + record("docs/old.md", "D"))).toBe("docs");
  });

  it.each([
    ["server/access.ts"],
    ["db/tests/00-environment.sql"],
    ["db/tests/README.md.sql"],
    ["package.json"],
    ["pnpm-lock.yaml"],
    [".github/workflows/ci.yml"],
    ["scripts/ci/scope.ts"],
    ["vitest.config.ts"],
    ["docs/diagram.svg"],
    ["docs"],
    ["CLAUDE.md"],
    ["AGENTS.md"],
    [".claude/rules/baza.md"],
    [".github/pull_request_template.md"],
  ])("%s needs the full profile", (path) => {
    expect(classifyDiff(record(path))).toBe("full");
    expect(jobsFor("full")).toEqual(["checks", "database"]);
  });

  it("one code file among documents needs the full profile", () => {
    expect(classifyDiff(record("docs/PLAN.md") + record("server/app.ts"))).toBe("full");
    expect(classifyDiff(record("server/app.ts") + record("README.md"))).toBe("full");
  });
});

describe("classifyDiff: anything unusual is never docs", () => {
  it("an empty diff is full", () => {
    expect(classifyDiff("")).toBe("full");
  });

  it.each([
    ["executable", record("docs/a.md", "M", "100644", "100755")],
    ["symlink", record("docs/a.md", "M", "120000", "120000")],
    ["submodule", record("docs/a.md", "A", "000000", "160000")],
    ["type change", record("docs/a.md", "T", "120000", "100644")],
    ["copy", record("docs/a.md", "C100")],
    ["rename", record("docs/a.md", "R100")],
    ["unknown status", record("docs/a.md", "X")],
    ["unmerged", record("docs/a.md", "U")],
    ["added with an old mode", `:100644 100644 ${ZERO} ${SHA} A\0docs/a.md\0`],
  ])("%s is full", (label, raw) => {
    expect(classifyDiff(raw)).toBe("full");
  });

  it.each([
    ["missing trailing NUL", record("docs/a.md").slice(0, -1)],
    ["header without path", `:100644 100644 ${SHA} ${SHA} M\0`],
    ["empty path", `:100644 100644 ${SHA} ${SHA} M\0\0`],
    ["short sha", `:100644 100644 abc ${SHA} M\0docs/a.md\0`],
    ["uppercase sha", `:100644 100644 ${"A".repeat(40)} ${SHA} M\0docs/a.md\0`],
    ["text instead of a record", "docs/a.md\0README.md\0"],
    ["CRLF header", `:100644 100644 ${SHA} ${SHA} M\r\0docs/a.md\0`],
  ])("%s throws", (label, raw) => {
    expect(() => classifyDiff(raw)).toThrow();
  });
});

describe("isOrdinaryDoc: path classes", () => {
  it.each([
    ["Docs/a.md"],
    ["docs/a.MD"],
    ["docs/a.Md"],
    ["readme.md"],
    ["README.MD"],
    ["docs\\a.md"],
    ["docs/sub\\README.md"],
    ["C:\\docs\\a.md"],
    ["/docs/a.md"],
    ["./docs/a.md"],
    ["docs/./a.md"],
    ["docs/../server/a.md"],
    ["docs//a.md"],
    ["docs/"],
    ["docs/.md"],
    ["docs/a.md/"],
    ["docs/a\r\n.md"],
    ["docs/a\t.md"],
    ["docs/a\u00a0.md"],
    ["docs/a\u007f.md"],
    ["docs/a\u0085.md"],
    ["docs/a\u0000.md"],
    ["docs/a\u2028.md"],
    ["docs/a\ufeff.md"],
    ["docs/a.md "],
    [" README.md"],
    ["README.md\n"],
    ["toString"],
    ["__proto__"],
    ["constructor"],
    ["db/README.md/x.sql"],
  ])("%j is not an ordinary document", (path) => {
    expect(isOrdinaryDoc(path)).toBe(false);
  });

  it.each([["docs/__proto__.md"], ["docs/toString.md"], ["constructor/README.md"]])(
    "%j is an ordinary document",
    (path) => {
      expect(isOrdinaryDoc(path)).toBe(true);
    },
  );

  it("non-strings are not documents", () => {
    for (const value of [undefined, null, 1, {}, ["docs/a.md"]]) {
      expect(isOrdinaryDoc(value)).toBe(false);
    }
  });
});

describe("ciProfile on real commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@primjer.invalid", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  const commit = (path: string, text: string): string => {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git("add", path);
    git("commit", "-q", "-m", path);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const base = commit("README.md", "a\n");
  const docs = commit("docs/PLAN.md", "b\n");
  const code = commit("server/app.ts", "c\n");
  const pr = (baseSha: string, headSha: string, baseRef = "main") =>
    ciProfile({ eventName: "pull_request", baseRef, baseSha, headSha, cwd: dir });

  it("a documents-only pull request into main is docs", () => {
    expect(pr(base, docs)).toBe("docs");
  });

  it("a pull request with code is full", () => {
    expect(pr(base, code)).toBe("full");
    expect(pr(docs, code)).toBe("full");
  });

  it("an identical head is full, never docs", () => {
    expect(pr(docs, docs)).toBe("full");
  });

  it("push, schedule and stacked pull requests are full without reading git", () => {
    for (const eventName of ["push", "schedule", "workflow_dispatch", undefined]) {
      expect(ciProfile({ eventName, baseRef: "main", baseSha: base, headSha: docs })).toBe("full");
    }
    expect(pr(base, docs, "feature")).toBe("full");
    expect(pr(base, docs, "Main")).toBe("full");
  });

  it.each([
    ["short", "abc123"],
    ["branch name", "main"],
    ["option", "--output=/tmp/x"],
    ["uppercase", "A".repeat(40)],
    ["empty", ""],
  ])("a %s head SHA throws", (label, headSha) => {
    expect(() => pr(base, headSha)).toThrow("CI scope needs full commit SHAs");
  });

  it("an unknown commit throws instead of passing as docs", () => {
    expect(() => pr(base, "b".repeat(40))).toThrow();
  });
});
