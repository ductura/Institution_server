// The PostgreSQL major version of production and of Ductus (postgres:17.11,
// D-08 point 3). CI installs exactly this major; scripts/ci/workflow.test.ts
// checks that the workflow and the pgTAP smoke test use the same number.
export const POSTGRES_MAJOR = 17;
