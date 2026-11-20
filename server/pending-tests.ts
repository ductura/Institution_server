// Tests copied from Ductus that cannot run until the task named on each group
// lands (ZEL-S4). Each task deletes its own rows. vitest.config.ts reads this list and
// tsconfig.json "exclude" repeats it; pending-tests.test.ts keeps the two equal.
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
  // do the SRV tasks that replace the Next route (app/api/** has no counterpart in SRV)
  "server/profile/interface-locale-route.test.ts",
  "server/config/env.test.ts",
  "tests/unit/instrumentation.test.ts",
  "tests/unit/health-route.test.ts",
  "tests/unit/ready-route.test.ts",
  "tests/unit/ready-route-alarms.test.ts",
  "tests/unit/auth/routes.test.ts",
  "tests/unit/auth/flow-logout.test.ts",
  "tests/unit/auth/flow-logout-all.test.ts",
  "tests/unit/auth/build-mode.test.ts",
  "tests/unit/interface-locale-routes.test.ts",
  // do DAN-839-3 (the copied probes and status still use the Ductus readiness names; server/http/ready.ts is the Ductura port)
  "server/http/public-status.test.ts",
  "tests/unit/ready.test.ts",
  // do U9 (@ductura/test-fakes, infra/fake-oidc has moved)
  "tests/unit/auth/fake-oidc-claims.test.ts",
  "tests/unit/infra/fake-oidc-accounts.test.ts",
];
