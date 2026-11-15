// S-1F-c (DAN-779): the databases of the server, in the order `pnpm db:migrate`
// migrates them. Each has its own migrations, its own ledger (D-91 (1)) and its
// own migrator role; dbmate keeps a schema_migrations table in each database.
// migrations-ledger.ts checks every entry, migrate-locked.ts takes one by name,
// and scripts/db/databases.test.ts holds package.json and CI to this list.

export type Database = {
  /** Name for --database and for the db:migrate:<name> script. */
  name: string;
  /** The PostgreSQL database the migrations belong to. */
  database: string;
  /** dbmate's migrations directory, relative to the repository root. */
  migrationsDir: string;
  /** The ledger of that directory (`<sha256>  <file>` per migration). */
  ledger: string;
  /** The role dbmate runs as (`role=` in the URL): NOLOGIN, owner of the database. */
  migrator: string;
  /** The compose service that holds the database. */
  service: string;
};

export const DATABASES: readonly Database[] = Object.freeze([
  Object.freeze({
    name: "main",
    database: "ductus",
    migrationsDir: "db/main/migrations",
    ledger: "db/main/migrations.sum",
    migrator: "ductus_migrator",
    service: "postgres-main",
  }),
  Object.freeze({
    name: "logs",
    database: "ductus_logs",
    migrationsDir: "db/logs/migrations",
    ledger: "db/logs/migrations.sum",
    migrator: "ductus_logs_migrator",
    service: "postgres-logs",
  }),
  // S-1F-c a2: the legal texts live next to the main database, in the same
  // cluster, so the cluster-wide roles of the main database exist there and
  // only the database's own grants keep them out.
  Object.freeze({
    name: "legal",
    database: "ductus_legal",
    migrationsDir: "db/legal/migrations",
    ledger: "db/legal/migrations.sum",
    migrator: "ductus_legal_migrator",
    service: "postgres-main",
  }),
]);

/** The database called `name`; anything else is an error, never a default. */
export function databaseNamed(name: string): Database {
  const found = DATABASES.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(
      `unknown database "${name}"; one of: ${DATABASES.map((entry) => entry.name).join(", ")}`,
    );
  }
  return found;
}
