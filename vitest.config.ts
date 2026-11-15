import { defineConfig } from "vitest/config";

// Four projects: unit, property and integration told apart by file suffix,
// database by its folder (tests/db). Tests live only in server/,
// packages/, test-support/, scripts/, infra/, db/, locales/ (and lint rule tests in tests/) with a .test.ts suffix; other
// files belong to no project and do not run. There is no passWithNoTests, but
// vitest fails on an empty project only when that project runs alone, so
// `pnpm test` and CI run the projects one by one.
const DIRS = "{server,packages,test-support,tests,scripts,infra,db,locales}";
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
          // As Ductus vitest.config.ts (d52a92c3): withActor of server/database
          // over the local login of db/main/local/app-login.sql (S-0.17).
          // The URL is the public local-only value of that file, no secret.
          env: {
            APP_DATABASE_URL:
              process.env.APP_DATABASE_URL ??
              "postgres://ductus_app_local:ductus-app-local-only@127.0.0.1:54329/ductus",
          },
        },
      },
    ],
  },
});
