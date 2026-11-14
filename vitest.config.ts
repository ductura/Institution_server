import { defineConfig } from "vitest/config";

// Three projects, told apart by file suffix. Tests live only in server/,
// test-support/, scripts/, infra/, db/ (and lint rule tests in tests/) with a .test.ts suffix; other
// files belong to no project and do not run. There is no passWithNoTests, but
// vitest fails on an empty project only when that project runs alone, so
// `pnpm test` and CI run the three projects one by one.
const DIRS = "{server,test-support,tests,scripts,infra,db}";
const PROPERTY = `${DIRS}/**/*.property.test.ts`;
const INTEGRATION = `${DIRS}/**/*.integration.test.ts`;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [`${DIRS}/**/*.test.ts`],
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
