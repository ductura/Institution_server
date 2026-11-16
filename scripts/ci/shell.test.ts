import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve, sep, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { shellViolations } from "./index.ts";

// DAN-867: every `run:` runs as `bash` (`-eo pipefail`); a step without
// `shell:` is `bash -e {0}` and a failed pipe passes green.
const ROOT = resolve(import.meta.dirname, "../..");
// Left to ductura/server#148, which changes both; nothing else may be exempt.
const EXEMPT = new Set([".github/workflows/release.yml", ".github/workflows/publish.yml"]);
// As the publish.yml test reads it: GitHub applies no `<<` merge key.
const read = (text: string): unknown => parse(text, { uniqueKeys: true, merge: false });

const TOP = (shell: string) => `defaults:\n  run:\n    shell: ${shell}\n`;
const JOB = (shell: string) => `    defaults:\n      run:\n        shell: ${shell}\n`;
const STEP = (shell: string) => `        shell: ${shell}\n`;
const workflow = (top: string, job: string, step: string) =>
  `${top}jobs:\n  a:\n${job}    steps:\n      - uses: actions/checkout@v1\n      - run: false | true\n${step}`;
const NOT_BASH = [
  "sh",
  "pwsh",
  "python",
  "Bash",
  "bash {0}",
  "bash -e {0}",
  "bash --noprofile --norc -e {0}",
  "bash -eo pipefail {0}",
  "bash --noprofile --norc -eo pipefail {0}",
  "${{ matrix.shell }}",
  '""',
  "",
  "1",
  "[bash]",
];

describe("shellViolations", () => {
  it.each([
    ["no shell anywhere", workflow("", "", "")],
    ...NOT_BASH.flatMap((shell) => [
      [`workflow default ${shell}`, workflow(TOP(shell), "", "")],
      [`job default ${shell}`, workflow("", JOB(shell), "")],
      [`step shell ${shell}`, workflow("", "", STEP(shell))],
    ]),
    ["step sh over a bash default", workflow(TOP("bash"), JOB("bash"), STEP("sh"))],
    ["job sh over a bash workflow", workflow(TOP("bash"), JOB("sh"), "")],
    ["bash on another job only", `${workflow("", "", "")}  b:\n${JOB("bash")}    steps: []\n`],
    ["an alias to sh", `x: &s sh\n${workflow(TOP("bash"), "", STEP("*s"))}`],
    ["a merge key", `x: &s\n  shell: bash\n${workflow(TOP("bash"), "", "        <<: *s\n")}`],
    ["steps not a list", "jobs:\n  a:\n    steps: {}\n"],
    ["a step not a mapping", "jobs:\n  a:\n    steps: [run]\n"],
    ["a job not a mapping", "jobs:\n  a: run\n"],
    ["jobs not a mapping", "jobs: [a]\n"],
    ["a document not a mapping", "- run: x\n"],
    [
      "composite step without shell",
      "runs:\n  using: composite\n  steps:\n    - run: false | true\n",
    ],
    ["composite step sh", "runs:\n  using: composite\n  steps:\n    - run: x\n      shell: sh\n"],
  ])("%s is a violation", (_name, text) => {
    expect(shellViolations(read(text))).toEqual([expect.stringMatching(/^[\w.[\]<-]+: shell /)]);
  });

  it.each([
    ["workflow default", workflow(TOP("bash"), "", "")],
    ["job default", workflow("", JOB("bash"), "")],
    ["step shell", workflow("", "", STEP("bash"))],
    ["job bash over a sh workflow", workflow(TOP("sh"), JOB("bash"), "")],
    [
      "job working-directory only",
      workflow(TOP("bash"), "    defaults:\n      run:\n        working-directory: x\n", ""),
    ],
    ["an alias to bash", `x: &s bash\n${workflow("", "", STEP("*s"))}`],
    ["step bash over a sh job", workflow("", JOB("sh"), STEP("bash"))],
    ["a reusable workflow job", "jobs:\n  a:\n    uses: o/r/.github/workflows/x.yml@v1\n"],
    [
      "composite step bash",
      "runs:\n  using: composite\n  steps:\n    - run: x\n      shell: bash\n",
    ],
  ])("%s runs as bash", (_name, text) => {
    expect(shellViolations(read(text))).toEqual([]);
  });
});

/** `path` relative to `root` with `/`, the form EXEMPT and the filters use. */
function repoPath(root: string, path: string, paths: typeof posix = posix): string {
  return paths.relative(root, path).split(paths.sep).join("/");
}

/** Every action.yml or action.yaml in the repository, outside dependencies. */
function actions(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return ["node_modules", ".git", "dist"].includes(entry.name) ? [] : actions(path);
    return /^action\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

describe("the workflows and composite actions of this repository", () => {
  const dir = resolve(ROOT, ".github/workflows");
  const workflows = readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => join(dir, name));
  const files = [...workflows, ...actions(ROOT)].map((path) =>
    repoPath(ROOT, path, sep === "/" ? posix : win32),
  );

  // Review cxcrs153: on Windows `relative` gives `\\`, and EXEMPT would not match.
  it("names files with / on every platform", () => {
    expect(repoPath("D:\\r", "D:\\r\\.github\\workflows\\release.yml", win32)).toBe(
      ".github/workflows/release.yml",
    );
    expect(repoPath("/r", "/r/.github/workflows/release.yml")).toBe(
      ".github/workflows/release.yml",
    );
  });

  it("finds every workflow", () => {
    for (const name of ["ci", "engineering-gate", "publish", "release"])
      expect(files).toContain(`.github/workflows/${name}.yml`);
  });

  it.each(files.filter((file) => !EXEMPT.has(file)))("%s runs every step as bash", (file) => {
    expect(shellViolations(read(readFileSync(resolve(ROOT, file), "utf8")))).toEqual([]);
  });

  // A stale exemption fails: once a file passes, it leaves EXEMPT.
  it.each([...EXEMPT])("%s is exempt only while it still fails", (file) => {
    expect(files).toContain(file);
    expect(shellViolations(read(readFileSync(resolve(ROOT, file), "utf8")))).not.toEqual([]);
  });

  // The defaults are what makes them pass: without them each one fails.
  it.each(files.filter((file) => !EXEMPT.has(file) && file.includes("workflows/")))(
    "%s without its defaults is a violation",
    (file) => {
      const doc = read(readFileSync(resolve(ROOT, file), "utf8")) as Record<string, unknown>;
      delete doc["defaults"];
      expect(shellViolations(doc)).not.toEqual([]);
    },
  );
});
