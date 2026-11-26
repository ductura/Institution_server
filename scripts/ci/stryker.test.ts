// ISTR-5: the Stryker workflow of the trust modules runs only in CI, weekly
// and by hand, with pinned actions and read-only permissions, and stays out
// of ci-ok; the config mutates only the trust modules and never breaks on the
// score (the threshold is only measured).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { jobsFor } from "./index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");
const WORKFLOW = read(".github/workflows/stryker.yml");

type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    { steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }
  >;
};
const workflow = parse(WORKFLOW) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe("stryker.yml", () => {
  it("runs only on a weekly schedule and by hand, never on a push or pull request", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on["schedule"]).toEqual([{ cron: "41 2 * * 0" }]);
    expect(WORKFLOW).not.toMatch(/pull_request|push:|workflow_run|repository_dispatch/);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = steps.map((step) => step.uses).filter((use) => use !== undefined);
    expect(uses.length).toBe(4);
    for (const action of uses) expect(action).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
  });

  it("reads only, with no credentials left in the checkout", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect([...WORKFLOW.matchAll(/permissions:/g)]).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/: write\b|write-all|secrets\./);
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({ "persist-credentials": false });
    // No expression is expanded inside a shell script (template injection).
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
  });

  it("runs the config of this repository and keeps the report as an artifact", () => {
    expect(steps.map((step) => step.run)).toContain("pnpm exec stryker run stryker.config.ts");
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with?.["path"]).toBe("reports/mutation/");
    const summary = steps.find((step) => step.run?.includes("kandidati.md"));
    expect(summary?.run).toContain('select(.status == "Survived" or .status == "NoCoverage")');
  });

  it("is not part of ci.yml nor of ci-ok", () => {
    expect(read(".github/workflows/ci.yml")).not.toMatch(/stryker/i);
    expect(jobsFor("full").join(" ")).not.toMatch(/stryker/i);
  });
});

/** Imports `file` as Stryker and vitest do (a dynamic import in Node) and prints `expression` of it as JSON. */
function load(file: string, expression: string, ci = "true") {
  const env = { ...process.env, ["CI"]: ci };
  const script = `const { default: c } = await import("./${file}"); process.stdout.write(JSON.stringify(${expression}));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
}
const loadConfig = (ci: string) => load("stryker.config.ts", "c", ci);

describe("stryker.config.ts", () => {
  it("refuses to run outside CI", () => {
    for (const ci of ["", "false", "1"]) {
      const run = loadConfig(ci);
      expect(run.status, ci).not.toBe(0);
      expect(run.stderr, ci).toContain("Stryker radi samo u CI-ju");
    }
  });

  it("mutates only the trust modules, runs only their unit and property tests, and never breaks", () => {
    const run = loadConfig("true");
    expect(run.status, run.stderr).toBe(0);
    const options = JSON.parse(run.stdout) as {
      testRunner: string;
      vitest: unknown;
      mutate: string[];
      testFiles: string[];
      thresholds: { break: number | null };
      plugins: string[];
    };
    expect(options.testRunner).toBe("vitest");
    expect(options.vitest).toEqual({ configFile: "vitest.stryker.config.ts", related: false });
    expect(options.mutate).toEqual([
      "server/domain/forensics/**/*.ts",
      "!server/domain/forensics/**/*.test.ts",
      "scripts/evidence-verify/**/*.ts",
      "!scripts/evidence-verify/**/*.test.ts",
      "scripts/engineering/risk-floor.ts",
    ]);
    expect(options.testFiles.length).toBeGreaterThan(0);
    for (const pattern of options.testFiles) {
      expect(pattern).toMatch(/\.test\.ts$/);
      expect(pattern).not.toMatch(/integration|^tests\/db/);
    }
    expect(options.thresholds.break).toBeNull();
    expect(options.plugins).toEqual([import.meta.resolve("@stryker-mutator/vitest-runner")]);
  });
});

describe("vitest.stryker.config.ts", () => {
  it("is vitest.config.ts with the same projects, only with a longer test timeout", () => {
    const projects = "c.test.projects.map((p) => ({ ...p.test, testTimeout: undefined }))";
    const base = load("vitest.config.ts", projects);
    const stryker = load("vitest.stryker.config.ts", projects);
    expect(stryker.status, stryker.stderr).toBe(0);
    expect(JSON.parse(stryker.stdout)).toEqual(JSON.parse(base.stdout));
    const timeouts = load(
      "vitest.stryker.config.ts",
      "[c.test.testTimeout, ...c.test.projects.map((p) => p.test.testTimeout)]",
    );
    expect(JSON.parse(timeouts.stdout)).toEqual(Array(6).fill(60_000));
  });
});
