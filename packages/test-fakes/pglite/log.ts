import { readFileSync } from "node:fs";

import { PGlite, type Transaction } from "@electric-sql/pglite";

// U9-b (DAN-741): the fake log database, append-only (log-schema.sql). The
// schema is temporary until S-1F brings the migrations of the log database.

const SCHEMA = readFileSync(new URL("./log-schema.sql", import.meta.url), "utf8");

export type LogEntry = {
  readonly id: number;
  readonly at: Date;
  readonly kind: string;
  readonly payload: unknown;
};

export type FakeLogDatabase = {
  /** Appends one entry as the writer role; payload must be JSON. */
  append(kind: string, payload: unknown): Promise<LogEntry>;
  /** Every entry, in the order of appending. */
  entries(): Promise<LogEntry[]>;
  /** The PGlite itself, for tests that try to break the log. */
  readonly db: PGlite;
  close(): Promise<void>;
};

type Row = { id: string | number; at: Date; kind: string; payload: unknown };
const toEntry = (row: Row): LogEntry => ({ ...row, id: Number(row.id) });

const asWriter = <T>(db: PGlite, run: (tx: Transaction) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE fake_logs_writer");
    return run(tx);
  });

export async function createFakeLogDatabase(): Promise<FakeLogDatabase> {
  const db = new PGlite();
  try {
    await db.waitReady;
    await db.exec(SCHEMA);
  } catch (error) {
    await db.close();
    throw error;
  }
  return {
    db,
    append: (kind, payload) => {
      const json = JSON.stringify(payload) as string | undefined;
      if (json === undefined) return Promise.reject(new TypeError("payload is not JSON"));
      return asWriter(db, async (tx) => {
        const result = await tx.query<Row>(
          "INSERT INTO logs.entry (kind, payload) VALUES ($1, $2::jsonb) RETURNING id, at, kind, payload",
          [kind, json],
        );
        return toEntry(result.rows[0] as Row);
      });
    },
    entries: () =>
      asWriter(db, async (tx) =>
        (await tx.query<Row>("SELECT id, at, kind, payload FROM logs.entry ORDER BY id")).rows.map(
          toEntry,
        ),
      ),
    close: () => db.close(),
  };
}
