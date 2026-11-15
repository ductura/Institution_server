// PGlite for unit and fast integration tests only (S-0.3); never proof of
// privileges, RLS, pgTAP or races. Refuses to load outside local and CI (D-09).
import "../guard/index.ts";

export { createPgliteDatabase, migratedDump, openDump, sourceOf } from "./database.ts";
export type { PgliteDatabase, PgliteDatabaseOptions, PgliteTarget } from "./database.ts";
export { createFakeLogDatabase } from "./log.ts";
export type { FakeLogDatabase, LogEntry } from "./log.ts";
