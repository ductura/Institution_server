// Whether the main database is migrated, for GET /api/v1/ready (SRV-1812,
// plan M11.3, D-277 NQ03). The dbmate ledger public.schema_migrations
// belongs to the migrator alone (D-91 measure 6, db/main/tests/011): no
// application role may read it, and this adapter does not either. It reads
// only the catalogue, which every role may read:
//
// - the ledger table exists, so the migrator has run at least once;
// - no session holds the advisory lock of scripts/db/migrate-locked.ts, so
//   no migration run is in progress (dbmate runs inside that lock).
//
// Both true is "migrated"; anything else is "pending" with its reason. One
// statement in one withActor transaction without a session, cancelled by
// the database at `timeoutMs`; a failure of the database is thrown on, and
// the readiness probe turns it into "nedostupno" by its code.
import type { WithActor } from "./with-actor.ts";

/**
 * The lock key of scripts/db/migrate-locked.ts (LOCK_KEY there);
 * schema-readiness.test.ts keeps the two equal.
 */
export const MIGRATION_LOCK_KEY = "4207120261031";

export type SchemaReadiness =
  | { readonly migrated: true }
  | { readonly migrated: false; readonly reason: "not_migrated" | "migrating" };

export type SchemaReadinessReader = () => Promise<SchemaReadiness>;

const STATEMENT_LIMIT_SQL = "SELECT pg_catalog.set_config('statement_timeout', $1, true)";

// pg_class and pg_locks without any privilege on the objects they name. A
// bigint advisory lock shows its high half in classid and its low half in
// objid, with objsubid 1; the database column keeps a lock of another
// database on the same server out.
export const SCHEMA_READINESS_SQL = `SELECT
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND c.relkind = 'r'
  ) AS ledger,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks l
    WHERE l.locktype = 'advisory' AND l.objsubid = 1
      AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d
                        WHERE d.datname = pg_catalog.current_database())
      AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
  ) AS migrating`;

const MIGRATED: SchemaReadiness = Object.freeze({ migrated: true });
const NOT_MIGRATED: SchemaReadiness = Object.freeze({ migrated: false, reason: "not_migrated" });
const MIGRATING: SchemaReadiness = Object.freeze({ migrated: false, reason: "migrating" });

/** Raised for a row that is not two booleans; the message names no value. */
export class SchemaReadinessShapeError extends Error {
  readonly code = "SCHEMA_READINESS_SHAPE";
  constructor() {
    super("schema readiness row has another shape");
  }
}

/** The reader over `withActor`; `timeoutMs` is the database's own limit of the statement. */
export function createSchemaReadinessReader(
  withActor: WithActor,
  timeoutMs: number,
): SchemaReadinessReader {
  return () =>
    withActor(null, async (tx) => {
      await tx.query(STATEMENT_LIMIT_SQL, [`${timeoutMs}ms`]);
      const { rows } = await tx.query<{ ledger: unknown; migrating: unknown }>(
        SCHEMA_READINESS_SQL,
        [MIGRATION_LOCK_KEY],
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      if (typeof row?.ledger !== "boolean" || typeof row.migrating !== "boolean")
        throw new SchemaReadinessShapeError();
      if (row.migrating) return MIGRATING;
      return row.ledger ? MIGRATED : NOT_MIGRATED;
    });
}
