import { defineConfig } from "vitest/config";

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
// S-1F-e (DAN-785): tests of authority, on real PostgreSQL only
// (test-support/database). The PGlite projects never include them;
// `pnpm test:integration:pg`, run in CI by `pnpm test:database`.
const PG = `${DIRS}/**/*.pg.integration.test.ts`;

// Not ported yet (ZEL-S7, Ductus#2028 c.7027096433): tests of Ductus-only code
// (Next.js app/api/**, next/server) or of modules that wait for SRV-10/SRV-12.
// The same list is the `exclude` of tsconfig.json, with the reasons.
const NOT_PORTED = [
  "tests/unit/db-boundary-forms.test.ts",
  "tests/unit/evidence-acceptance-signature-migration.test.ts",
  "tests/unit/evidence-open-work-migration.test.ts",
  "tests/unit/evidence-segment-v3-migration.test.ts",
  "tests/unit/integration-database-target.test.ts",
  "tests/unit/pg-import-boundary.hardening.test.ts",
  "tests/unit/pg-import-boundary.test.ts",
  "tests/unit/plain-label-check.test.ts",
  "tests/unit/problem-report-routes.test.ts",
  "tests/unit/rpc-http-inventory.test.ts",
  "tests/unit/server-route-inventory.test.ts",
  "tests/unit/shutdown-process.test.ts",
  "tests/unit/session-guc-scope.test.ts",
  "tests/unit/auth/session-activity-routes.test.ts",
  "tests/unit/auth/open-session-boundary.test.ts",
  "tests/unit/infra/group-roles-lists.test.ts",
  "server/institution/acknowledgment-route.test.ts",
  "server/institution/assignment-version-route.test.ts",
  "server/institution/create-assignment.test.ts",
  "server/institution/create-course.test.ts",
  "server/institution/enrollment-code-revocation-route.test.ts",
  "server/institution/enrollment-code-route.test.ts",
  "server/institution/mutation-route.test.ts",
  "server/institution/student-removal-route.test.ts",
  "server/institution/student-return-route.test.ts",
  "server/institution/teacher-role-confirmation-route.test.ts",
  "server/institution/teacher-role-revocation-route.test.ts",
  "server/institution/work-language-route.test.ts",
  "server/collaboration/revision-requests.test.ts",
  "server/profile/interface-locale-route.test.ts",
  "server/config/env.test.ts",
  "server/http/public-status.test.ts",
  "server/privacy/my-access-log-pages.test.ts",
  "server/teacher/fast-path.test.ts",
  "tests/unit/auth/build-mode.test.ts",
  "tests/unit/auth/fake-oidc-claims.test.ts",
  "tests/unit/infra/fake-oidc-accounts.test.ts",
  "tests/unit/auth/flow-logout-all.test.ts",
  "tests/unit/auth/flow-logout.test.ts",
  "tests/unit/auth/routes.test.ts",
  "tests/unit/health-route.test.ts",
  "tests/unit/instrumentation.test.ts",
  "tests/unit/interface-locale-routes.test.ts",
  "tests/unit/ready-route-alarms.test.ts",
  "tests/unit/ready-route.test.ts",
  "tests/unit/ready.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [`${DIRS}/**/*.test.ts`],
          exclude: [PROPERTY, INTEGRATION, ...NOT_PORTED],
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
