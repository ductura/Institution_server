// Tests copied from Ductus that cannot run until the task named on each group
// lands (ZEL-S4). The list includes copied sources as well. Each task removes
// its own rows. Vitest and ESLint leave these paths out, and
// pending-tests.test.ts checks that both TypeScript projects exclude them too
// and that no file outside the list imports one.
export const PENDING_TESTS: readonly string[] = [
  // do SRV-10 / SRV-12 (the routes these test are written there; Ductus mutation-route, enrollment-*, create-course are not ported)
  "server/institution/create-assignment.test.ts",
  "server/institution/assignment-version-route.test.ts",
  "server/institution/enrollment-code-revocation-route.test.ts",
  "server/institution/enrollment-code-route.test.ts",
  "server/institution/mutation-route.test.ts",
  "server/institution/student-removal-route.test.ts",
  "server/institution/student-return-route.test.ts",
  "server/institution/teacher-role-confirmation-route.test.ts",
  "server/institution/teacher-role-revocation-route.test.ts",
  "server/institution/work-language-route.test.ts",
  "server/institution/create-course.test.ts",
  "server/institution/acknowledgment-route.test.ts",
  // sources of the same routes: they import the unported ./mutation-route or next/server and nothing mounts them yet
  "server/institution/acknowledgment-route.ts",
  "server/institution/assignment-route.ts",
  "server/institution/assignment-version-route.ts",
  "server/institution/student-removal-route.ts",
  "server/institution/student-return-route.ts",
  "server/institution/teacher-role-confirmation-route.ts",
  "server/institution/teacher-role-revocation-route.ts",
  "server/institution/work-language-route.ts",
  // do the SRV tasks that replace the Next route (app/api/** has no counterpart in SRV)
  "server/profile/interface-locale-route.test.ts",
  "server/collaboration/revision-requests.test.ts",
  "server/config/env.test.ts",
  "tests/unit/instrumentation.test.ts",
  "tests/unit/health-route.test.ts",
  "tests/unit/ready-route.test.ts",
  "tests/unit/ready-route-alarms.test.ts",
  "tests/unit/interface-locale-routes.test.ts",
  // do DAN-839-3 (the copied probes and status still use the Ductus readiness names; server/http/ready.ts is the Ductura port)
  "server/http/public-status.test.ts",
  "server/http/public-status.ts",
  "server/http/ready-capabilities.ts",
  "tests/unit/ready.test.ts",
  // Ductus layout (src/, app/, docs/backend, db/migrations, tests/integration do not exist here); replacement with SRV-10/12 and the database lane
  "tests/unit/shutdown-process.test.ts",
  "tests/unit/db-boundary-forms.test.ts",
  "tests/unit/rpc-http-inventory.test.ts",
  "tests/unit/server-route-inventory.test.ts",
  "tests/unit/auth/session-activity-routes.test.ts",
  // do U9 (@ductura/test-fakes, infra/fake-oidc has moved)
  "tests/unit/auth/fake-oidc-claims.test.ts",
  "tests/unit/infra/fake-oidc-accounts.test.ts",
  // do VS-1b part 2/3 (the process fence of Ductus src/server/attempt-fence.ts comes with the worker
  // process, job-queue.ts; its deadlines are tested in server/database/queue/attempt-fence-core.test.ts and -watch.test.ts)
  "server/attempt-fence.test.ts",
];

// Ductus-only suites and originals of ported suites. Vitest leaves them out of every project;
// pending-tests.test.ts checks that tsconfig.ductus-tests.json excludes them too.
export const DUCTUS_LEGACY_DATABASE: readonly string[] = [
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
