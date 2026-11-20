import { configDefaults, defineConfig } from "vitest/config";

import { PENDING_TESTS } from "./server/pending-tests.ts";

// Five projects: unit, property and integration told apart by file suffix,
// database by its folder (tests/db), integration-pg by *.pg.integration.test.ts. Tests live only in server/,
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
// Ductus-only suites and originals of ported suites. Keep in sync with tsconfig.ductus-tests.json.
export const DUCTUS_LEGACY_DATABASE = [
  "tests/db/ductus/aai-login.integration.test.ts",
  "tests/db/ductus/app-database.integration.test.ts",
  "tests/db/ductus/assignment-submissions-route.integration.test.ts",
  "tests/db/ductus/assignment-version-route.integration.test.ts",
  "tests/db/ductus/data-flow-inventory-catalog.integration.test.ts",
  "tests/db/ductus/enrollment-code-revocation-route.integration.test.ts",
  "tests/db/ductus/enrollment-code-route.integration.test.ts",
  "tests/db/ductus/enrollment-route.integration.test.ts",
  "tests/db/ductus/environment.integration.test.ts",
  "tests/db/ductus/evidence-commit.integration.test.ts",
  "tests/db/ductus/institution.integration.test.ts",
  "tests/db/ductus/live-submitted-read.integration.test.ts",
  "tests/db/ductus/mentored-works-route.integration.test.ts",
  "tests/db/ductus/ready-queue.integration.test.ts",
  "tests/db/ductus/student-removal-route.integration.test.ts",
  "tests/db/ductus/student-return-route.integration.test.ts",
  "tests/db/ductus/teacher-role-confirmation-route.integration.test.ts",
  "tests/db/ductus/teacher-role-revocation-route.integration.test.ts",
  "tests/db/ductus/with-actor.integration.test.ts",
  "tests/db/ductus/work-language-route.integration.test.ts",
];
// S-1F-e (DAN-785): tests of authority, on real PostgreSQL only
// (test-support/database). The PGlite projects never include them;
// `pnpm test:integration:pg`, run in CI by `pnpm test:database`.
const PG = `${DIRS}/**/*.pg.integration.test.ts`;

export default defineConfig({
  test: {
    // Inline projects inherit these exact legacy file exclusions.
    exclude: [...configDefaults.exclude, ...DUCTUS_LEGACY_DATABASE],
    projects: [
      {
        test: {
          name: "unit",
          include: [`${DIRS}/**/*.test.ts`],
          exclude: [PROPERTY, INTEGRATION, ...PENDING_TESTS],
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
          exclude: [DATABASE, PG],
          environment: "node",
          // createTestDatabase (test-support/database) runs on PGlite here.
          env: { DUCTURA_TEST_DATABASE: "pglite" },
        },
      },
      {
        test: {
          name: "database",
          include: [DATABASE],
          exclude: [PG],
          environment: "node",
          // F-019: refuses a database URL that is not this machine's.
          setupFiles: ["tests/db/setup.ts"],
          testTimeout: 30_000,
          // S-1F-c (DAN-779): the files share one cluster, some make
          // deliberately wrong throwaway roles (with-actor, open-session), and
          // the logs and legal tests read the whole role catalogue; run in
          // parallel, one file would see another's roles. One file at a time.
          fileParallelism: false,
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
      {
        test: {
          name: "integration-pg",
          include: [PG],
          environment: "node",
          // F-019: only this machine's database, as the project above.
          setupFiles: ["tests/db/setup.ts"],
          testTimeout: 60_000,
          // One database per name in one cluster: one file at a time.
          fileParallelism: false,
          env: { DUCTURA_TEST_DATABASE: "postgres" },
        },
      },
    ],
  },
});
