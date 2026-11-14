import { defineConfig } from "vitest/config";

// Four projects: unit, property and integration told apart by file suffix,
// database by its folder (tests/db). Tests live only in server/,
// test-support/, scripts/, infra/, db/ (and lint rule tests in tests/) with a .test.ts suffix; other
// files belong to no project and do not run. There is no passWithNoTests, but
// vitest fails on an empty project only when that project runs alone, so
// `pnpm test` and CI run the projects one by one.
const DIRS = "{server,test-support,tests,scripts,infra,db}";
const PROPERTY = `${DIRS}/**/*.property.test.ts`;
const INTEGRATION = `${DIRS}/**/*.integration.test.ts`;
// Integration tests that need the migrated PostgreSQL of the CI job `database`
// (127.0.0.1:54329, roles from db/main/local/migrator.sql, all migrations
// applied through scripts/db/migrate-locked.ts). Ported from Ductus
// tests/integration at d52a92c3 (S-0.13, DAN-726); `pnpm test:database`.
const DATABASE = "tests/db/**/*.integration.test.ts";

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
        test: {
          name: "integration",
          include: [INTEGRATION],
          exclude: [DATABASE],
          environment: "node",
        },
      },
      {
        test: {
          name: "database",
          include: [DATABASE],
          environment: "node",
          // F-019: refuses a database URL that is not this machine's.
          setupFiles: ["tests/db/setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
