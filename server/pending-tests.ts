// Tests copied from Ductus that cannot run until the task named on each group
// lands (ZEL-S4). The list includes copied sources as well. Each task removes
// its own rows. Vitest reads this list and pending-tests.test.ts checks that
// both TypeScript projects exclude these paths.
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
];
