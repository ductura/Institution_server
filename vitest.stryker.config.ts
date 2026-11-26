// ISTR-5: the vitest config Stryker runs (stryker.config.ts, CI only). It is
// vitest.config.ts with a longer test timeout for every project: the mutated
// code counts every statement it runs, so a test over a full evidence segment
// (MAX_EVIDENCE_SEGMENT_BYTES) takes seconds instead of milliseconds.
import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.ts";

export const STRYKER_TEST_TIMEOUT_MS = 60_000;

const projects = (base.test?.projects ?? []).map((project) =>
  typeof project === "object" && project !== null && "test" in project
    ? mergeConfig(project, { test: { testTimeout: STRYKER_TEST_TIMEOUT_MS } })
    : project,
);

// Not mergeConfig on the root: it would append the projects, not replace them.
export default defineConfig({
  ...base,
  test: { ...base.test, testTimeout: STRYKER_TEST_TIMEOUT_MS, projects },
});
