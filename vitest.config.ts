import { defineConfig } from "vitest/config";

// Three projects, told apart by file suffix. Tests live only in server/,
// test-support/, scripts/ (and lint rule tests in tests/) with a .test.ts suffix; other
// files belong to no project and do not run. There is no passWithNoTests, but
// vitest fails on an empty project only when that project runs alone, so
// `pnpm test` and CI run the three projects one by one.
const PROPERTY = "{server,test-support,tests,scripts}/**/*.property.test.ts";
const INTEGRATION = "{server,test-support,tests,scripts}/**/*.integration.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{server,test-support,tests,scripts}/**/*.test.ts"],
          exclude: [PROPERTY, INTEGRATION],
          environment: "node",
        },
      },
      {
        test: { name: "property", include: [PROPERTY], environment: "node" },
      },
      {
        test: { name: "integration", include: [INTEGRATION], environment: "node" },
      },
    ],
  },
});
