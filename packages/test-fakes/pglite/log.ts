import type { PGlite, Transaction } from "@electric-sql/pglite";

import { databaseNamed } from "../../../scripts/db/index.ts";
import { migratedDump, openDump, sourceOf } from "./database.ts";

// U9-b (DAN-741), S-1K.2-a (DAN-813): the fake log database is the logs
// database itself, migrated in PGlite (db/logs/migrations), so it is
// append-only as public.log_entry is: the writer only appends kind and
// payload. The reader holds no right on the table (DAN-835-4: the payload
// holds the full IP; it reads through operator_log), so the fake reads as the
// owner, by its policy log_entry_owner_read.

export type LogEntry = {
  readonly id: number;
  readonly at: Date;
  readonly kind: string;
  readonly payload: unknown;
};

export type FakeLogDatabase = {
  /** Appends one entry as ductus_logs_writer; payload must be JSON. */
  append(kind: string, payload: unknown): Promise<LogEntry>;
  /** Every entry, in the order of appending, read as the owner, ductus_logs_migrator. */
  entries(): Promise<LogEntry[]>;
  /** The PGlite itself (connected as the superuser), for tests that try to break the log. */
  readonly db: PGlite;
  close(): Promise<void>;
};

type Row = { id: string | number; at: Date; kind: string; payload: unknown };
const toEntry = (row: Row): LogEntry => ({ ...row, id: Number(row.id) });
const COLUMNS = "id, at, kind, payload";

// The logs database is migrated once per process; every call opens its own
// copy of that dump, so each fake is still a database of its own.
const LOGS = databaseNamed("logs");
let dump: Promise<Blob> | undefined;
function logsDump(): Promise<Blob> {
  dump ??= migratedDump(sourceOf(LOGS), LOGS).catch((error: unknown) => {
    dump = undefined;
    throw error;
  });
  return dump;
}

export async function createFakeLogDatabase(): Promise<FakeLogDatabase> {
  const db = await openDump(await logsDump(), LOGS.database);
  const read = (tx: Transaction, sql: string): Promise<Row[]> =>
    tx
      .exec("SET LOCAL ROLE ductus_logs_migrator")
      .then(async () => (await tx.query<Row>(sql)).rows);
  return {
    db,
    append: (kind, payload) => {
      const json = JSON.stringify(payload) as string | undefined;
      if (json === undefined) return Promise.reject(new TypeError("payload is not JSON"));
      // The writer has no SELECT (no RETURNING); in the same transaction the
      // owner reads back the row this transaction appended (its xmin).
      return db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE ductus_logs_writer");
        await tx.query("INSERT INTO public.log_entry (kind, payload) VALUES ($1, $2::jsonb)", [
          kind,
          json,
        ]);
        const rows = await read(
          tx,
          `SELECT ${COLUMNS} FROM public.log_entry WHERE xmin::text = pg_current_xact_id()::text ORDER BY id DESC LIMIT 1`,
        );
        return toEntry(rows[0] as Row);
      });
    },
    entries: () =>
      db.transaction(async (tx) =>
        (await read(tx, `SELECT ${COLUMNS} FROM public.log_entry ORDER BY id`)).map(toEntry),
      ),
    close: () => db.close(),
  };
}
