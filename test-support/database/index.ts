// S-1F-e (DAN-785): test databases per name of scripts/db/databases.ts
// (README.md). Test code only: production code never loads test-support/.
export {
  AUTHORITY_REFUSED,
  createTestDatabase,
  engineFrom,
  openTestDatabase,
  PG_FILE_REFUSED,
  pgliteAllowedIn,
  testDatabaseNamed,
} from "./create-test-database.ts";
export { exclusive, settled } from "./postgres.ts";
export type {
  TestDatabase,
  TestDatabaseEngine,
  TestDatabaseOptions,
} from "./create-test-database.ts";
