import { defineConfig } from "vitest/config";

// Three projects, told apart by file suffix. Tests live only in server/ and
// test-support/ (and lint rule tests in tests/) with a .test.ts suffix; other
// files belong to no project and do not run. There is no passWithNoTests, but
// vitest fails on an empty project only when that project runs alone, so
// `pnpm test` and CI run the three projects one by one.
const PROPERTY = "{server,test-support,tests}/**/*.property.test.ts";
const INTEGRATION = "{server,test-support,tests}/**/*.integration.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{server,test-support,tests}/**/*.test.ts"],
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
