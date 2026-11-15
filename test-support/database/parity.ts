import type { TestDatabase } from "./create-test-database.ts";
import type { ParityException } from "./exceptions.ts";

// S-1F-e (DAN-785): a fingerprint of what the migrations made, one line per
// object, read the same way in PGlite and in PostgreSQL. System schemas and
// the oids of objects are left out; owners, ACLs, RLS flags, policies,
// function security and triggers are in, since those are what a migration
// sets and what a fake could get wrong.

const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

const FINGERPRINT = `
SELECT 'database owner=' || pg_catalog.pg_get_userbyid(d.datdba) || ' acl=' || COALESCE(d.datacl::text, '-')
  FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
UNION ALL
SELECT 'schema ' || n.nspname || ' owner=' || pg_catalog.pg_get_userbyid(n.nspowner) || ' acl=' || COALESCE(n.nspacl::text, '-')
  FROM pg_catalog.pg_namespace n WHERE ${USER_SCHEMA}
UNION ALL
SELECT 'extension ' || e.extname || ' ' || e.extversion FROM pg_catalog.pg_extension e
UNION ALL
SELECT 'relation ' || n.nspname || '.' || c.relname || ' kind=' || c.relkind::text
       || ' owner=' || pg_catalog.pg_get_userbyid(c.relowner)
       || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
       || ' acl=' || COALESCE(c.relacl::text, '-')
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
UNION ALL
SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname
       || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
       || ' notnull=' || a.attnotnull
       || ' default=' || COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '-')
       || ' acl=' || COALESCE(a.attacl::text, '-')
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
 WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint ' || n.nspname || '.' || c.relname || ' ' || o.conname || ' ' || pg_catalog.pg_get_constraintdef(o.oid)
  FROM pg_catalog.pg_constraint o
  JOIN pg_catalog.pg_class c ON c.oid = o.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${USER_SCHEMA}
UNION ALL
SELECT 'index ' || pg_catalog.pg_get_indexdef(i.indexrelid)
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${USER_SCHEMA}
UNION ALL
SELECT 'policy ' || p.schemaname || '.' || p.tablename || ' ' || p.policyname
       || ' ' || p.permissive || ' ' || p.cmd || ' roles=' || p.roles::text
       || ' using=' || COALESCE(p.qual, '-') || ' check=' || COALESCE(p.with_check, '-')
  FROM pg_catalog.pg_policies p
UNION ALL
SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
       || ' kind=' || p.prokind::text || ' returns=' || pg_catalog.pg_get_function_result(p.oid)
       || ' secdef=' || p.prosecdef || ' volatile=' || p.provolatile::text
       || ' config=' || COALESCE(p.proconfig::text, '-')
       || ' owner=' || pg_catalog.pg_get_userbyid(p.proowner)
       || ' acl=' || COALESCE(p.proacl::text, '-')
       || ' body=' || pg_catalog.md5(p.prosrc)
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE ${USER_SCHEMA}
UNION ALL
SELECT 'trigger ' || n.nspname || '.' || c.relname || ' enabled=' || t.tgenabled::text || ' ' || pg_catalog.pg_get_triggerdef(t.oid)
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${USER_SCHEMA} AND NOT t.tgisinternal
UNION ALL
SELECT 'type ' || n.nspname || '.' || t.typname || ' kind=' || t.typtype::text
       || ' owner=' || pg_catalog.pg_get_userbyid(t.typowner) || ' acl=' || COALESCE(t.typacl::text, '-')
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
 WHERE ${USER_SCHEMA} AND t.typtype IN ('e', 'd', 'r', 'm')
UNION ALL
SELECT 'enum ' || n.nspname || '.' || t.typname || ' ' || pg_catalog.string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_catalog.pg_enum e
  JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
 WHERE ${USER_SCHEMA} GROUP BY n.nspname, t.typname
UNION ALL
SELECT 'migration ' || version FROM public.schema_migrations`;

/** The sorted catalogue fingerprint of `db`. */
export async function catalogFingerprint(db: TestDatabase): Promise<string[]> {
  const { rows } = await db.query<{ line: string }>(
    `SELECT line FROM (${FINGERPRINT}) AS f(line) ORDER BY line COLLATE "C"`,
  );
  return rows.map((row) => row.line);
}

export type ParityReport = {
  /** Lines one engine has and the other has not, not listed as exceptions. */
  readonly unexplained: readonly string[];
  /** Exceptions of this database whose line no longer differs. */
  readonly stale: readonly ParityException[];
};

/** Compares two fingerprints of `database` against `exceptions`. */
export function compareFingerprints(
  database: string,
  pglite: readonly string[],
  postgres: readonly string[],
  exceptions: readonly ParityException[],
): ParityReport {
  const inPglite = new Set(pglite);
  const inPostgres = new Set(postgres);
  const only = [
    ...pglite.filter((line) => !inPostgres.has(line)).map((line) => ["pglite", line] as const),
    ...postgres.filter((line) => !inPglite.has(line)).map((line) => ["postgres", line] as const),
  ];
  const mine = exceptions.filter((entry) => entry.database === database);
  const listed = (side: string, line: string): boolean =>
    mine.some((entry) => entry.only === side && entry.line === line);
  return {
    unexplained: only
      .filter(([side, line]) => !listed(side, line))
      .map(([side, line]) => `${side} only: ${line}`),
    stale: mine.filter(
      (entry) => !only.some(([side, line]) => entry.only === side && entry.line === line),
    ),
  };
}
