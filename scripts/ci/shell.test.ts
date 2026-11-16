import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

/**
 * The files to check among tracked repository paths: every workflow GitHub
 * reads (directly in .github/workflows) and every action.yml or action.yaml,
 * wherever it is. Git names paths with `/` on every platform (review cxcrs153).
 */
function checkedFiles(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path) || /(?:^|\/)action\.ya?ml$/i.test(path),
  );
}

describe("checkedFiles", () => {
  // QA cxcqs153: no folder is skipped, a tracked dist/ or node_modules/ included.
  it("keeps every tracked action and top-level workflow, and nothing else", () => {
    const actions = [
      ".github/actions/dist/action.yml",
      "dist/action.yml",
      "node_modules/x/action.yaml",
      ".git-x/action.yml",
      "action.yml",
      "a/b/Action.YAML",
    ];
    const workflows = [".github/workflows/ci.yml", ".github/workflows/x.YAML"];
    const other = [".github/workflows/sub/x.yml", "a/action.yml.bak", "a/my-action.yml", "ci.yml"];
    expect(checkedFiles([...other, ...actions, ...workflows])).toEqual([...actions, ...workflows]);
  });
});

describe("the workflows and composite actions of this repository", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  const files = checkedFiles(tracked.split("\0"));

  it("names files with / on every platform", () => {
    for (const file of files) expect(file).not.toContain("\\");
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
  it.each(files.filter((file) => !EXEMPT.has(file) && file.startsWith(".github/workflows/")))(
    "%s without its defaults is a violation",
    (file) => {
      const doc = read(readFileSync(resolve(ROOT, file), "utf8")) as Record<string, unknown>;
      delete doc["defaults"];
      expect(shellViolations(doc)).not.toEqual([]);
    },
  );
});
