// ISTR-5 (plan ISTRAZIVANJE-2511): Stryker mutation testing of the trust
// modules. CI only (.github/workflows/stryker.yml), weekly and by hand; it is
// not part of ci-ok and blocks nothing. The threshold is only measured for now:
// break stays null until two runs give a basis for a proposal.
//
// A .ts file and not stryker.config.mjs: the lint rule local/only-ts refuses
// every .mjs file. Stryker imports any config file that is not JSON, and
// Node 24 strips the types; the workflow names this file on the command line.

// Never locally (RAM): Stryker copies the repository and runs the tests of
// every mutant. GitHub Actions sets CI=true.
if (process.env["CI"] !== "true") {
  throw new Error("Stryker radi samo u CI-ju (.github/workflows/stryker.yml), nikad lokalno.");
}

/** The trust modules of ISTR-5; tests and fixtures are never mutated. */
export const MUTATE: readonly string[] = [
  "server/domain/forensics/**/*.ts",
  "!server/domain/forensics/**/*.test.ts",
  "scripts/evidence-verify/**/*.ts",
  "!scripts/evidence-verify/**/*.test.ts",
  "scripts/engineering/risk-floor.ts",
];

/**
 * Only the dedicated tests of those modules run, unit and property, never a
 * test that needs a database: a surviving mutant is a candidate for a test of
 * that module. The tests of risk-floor.ts are in server/risk-floor.test.ts.
 */
export const TEST_FILES: readonly string[] = [
  "server/domain/forensics/**/*.test.ts",
  "scripts/evidence-verify/**/*.test.ts",
  "scripts/engineering/**/*.test.ts",
  "server/risk-floor.test.ts",
];

export const REPORT_DIR = "reports/mutation";

export default {
  // pnpm keeps the runner out of core's node_modules, where the default
  // "@stryker-mutator/*" looks; the runner is named by its resolved URL.
  plugins: [import.meta.resolve("@stryker-mutator/vitest-runner")],
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  mutate: [...MUTATE],
  testFiles: [...TEST_FILES],
  coverageAnalysis: "perTest",
  // A static mutant (module-level code) reloads every test file: on
  // risk-floor.ts alone 28 % of the mutants took the whole run. They are
  // reported as Ignored, so the weekly run stays within the job timeout.
  ignoreStatic: true,
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: `${REPORT_DIR}/mutation.html` },
  jsonReporter: { fileName: `${REPORT_DIR}/mutation.json` },
  // Measured only (ISTR-5): no break threshold, the run never fails on the score.
  thresholds: { high: 80, low: 60, break: null },
  concurrency: 2,
  timeoutMS: 30_000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
