import type { TestDatabase } from "./create-test-database.ts";
import type { ParityException } from "./exceptions.ts";

// S-1F-e (DAN-785): a fingerprint of what the migrations made, one line per
// object, read the same way in PGlite and in PostgreSQL. System schemas and
// the oids of objects are left out; owners, ACLs, roles and memberships,
// default privileges, RLS flags, policies, function security and triggers are
// in, since those are what a migration sets and what a fake could get wrong.
// Not covered: comments, publications, large objects, statistics objects.

const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

// Roles of this database: those its objects and grants depend on, and its
// owner. Superusers are left out: their name is the cluster's (postgres in
// PGlite, ductus locally and in CI), not a migration's.
const DB_ROLES = `(SELECT r.oid FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper AND (
    r.oid IN (SELECT s.refobjid FROM pg_catalog.pg_shdepend s
               WHERE s.refclassid = 'pg_catalog.pg_authid'::regclass
                 AND s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()))
    OR r.oid = (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())))`;

const FINGERPRINT = `
SELECT 'database owner=' || pg_catalog.pg_get_userbyid(d.datdba) || ' acl=' || COALESCE(d.datacl::text, '-')
  FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
UNION ALL
-- Whether text sorts bytewise; the exact non-C locale is the cluster's (initdb), not a migration's.
SELECT 'database collation-c=' || (d.datcollate IN ('C', 'POSIX')) || ' provider=' || d.datlocprovider::text
  FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
UNION ALL
SELECT 'role ' || r.rolname || ' inherit=' || r.rolinherit || ' createrole=' || r.rolcreaterole
       || ' createdb=' || r.rolcreatedb || ' login=' || r.rolcanlogin || ' replication=' || r.rolreplication
       || ' bypassrls=' || r.rolbypassrls || ' connlimit=' || r.rolconnlimit
  FROM pg_catalog.pg_roles r WHERE r.oid IN ${DB_ROLES}
UNION ALL
SELECT 'member ' || pg_catalog.pg_get_userbyid(m.member) || ' of ' || pg_catalog.pg_get_userbyid(m.roleid)
       || ' admin=' || m.admin_option || ' inherit=' || m.inherit_option || ' set=' || m.set_option
  FROM pg_catalog.pg_auth_members m WHERE m.member IN ${DB_ROLES} OR m.roleid IN ${DB_ROLES}
UNION ALL
SELECT 'setting role=' || COALESCE(pg_catalog.pg_get_userbyid(NULLIF(s.setrole, 0)), '*')
       || ' database=' || CASE WHEN s.setdatabase = 0 THEN '*' ELSE 'this' END || ' ' || s.setconfig::text
  FROM pg_catalog.pg_db_role_setting s
 WHERE s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()))
   AND (s.setrole = 0 OR s.setrole IN ${DB_ROLES})
UNION ALL
SELECT 'default-acl ' || pg_catalog.pg_get_userbyid(a.defaclrole) || ' schema=' || COALESCE(a.defaclnamespace::regnamespace::text, '*')
       || ' type=' || a.defaclobjtype::text || ' acl=' || COALESCE(a.defaclacl::text, '-')
  FROM pg_catalog.pg_default_acl a
UNION ALL
SELECT 'schema ' || n.nspname || ' owner=' || pg_catalog.pg_get_userbyid(n.nspowner) || ' acl=' || COALESCE(n.nspacl::text, '-')
  FROM pg_catalog.pg_namespace n WHERE ${USER_SCHEMA}
UNION ALL
SELECT 'extension ' || e.extname || ' ' || e.extversion FROM pg_catalog.pg_extension e
UNION ALL
SELECT 'event-trigger ' || e.evtname || ' ' || e.evtevent || ' enabled=' || e.evtenabled::text
  FROM pg_catalog.pg_event_trigger e
UNION ALL
SELECT 'relation ' || n.nspname || '.' || c.relname || ' kind=' || c.relkind::text
       || ' owner=' || pg_catalog.pg_get_userbyid(c.relowner)
       || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
       || ' acl=' || COALESCE(c.relacl::text, '-')
       || ' persistence=' || c.relpersistence::text || ' replica=' || c.relreplident::text
       || ' options=' || COALESCE(c.reloptions::text, '-')
       || ' parent=' || COALESCE((SELECT pg_catalog.string_agg(i.inhparent::regclass::text, ',' ORDER BY i.inhseqno)
                                    FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid), '-')
       || ' partkey=' || COALESCE(pg_catalog.pg_get_partkeydef(c.oid), '-')
       || ' bound=' || COALESCE(pg_catalog.pg_get_expr(c.relpartbound, c.oid), '-')
       || ' view=' || CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.md5(pg_catalog.pg_get_viewdef(c.oid)) ELSE '-' END
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
UNION ALL
SELECT 'sequence ' || s.schemaname || '.' || s.sequencename || ' ' || s.data_type::text || ' start=' || s.start_value
       || ' min=' || s.min_value || ' max=' || s.max_value || ' by=' || s.increment_by
       || ' cycle=' || s.cycle || ' cache=' || s.cache_size
       || ' owned=' || COALESCE((SELECT d.refobjid::regclass::text || '.' || a.attname
                                   FROM pg_catalog.pg_depend d
                                   JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                                  WHERE d.classid = 'pg_catalog.pg_class'::regclass
                                    AND d.objid = (pg_catalog.quote_ident(s.schemaname) || '.' || pg_catalog.quote_ident(s.sequencename))::regclass
                                    AND d.deptype IN ('a', 'i')), '-')
  FROM pg_catalog.pg_sequences s
UNION ALL
SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname
       || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
       || ' notnull=' || a.attnotnull
       || ' default=' || COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '-')
       || ' acl=' || COALESCE(a.attacl::text, '-')
       || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
       || ' collation=' || COALESCE((SELECT co.collname FROM pg_catalog.pg_collation co WHERE co.oid = a.attcollation), '-')
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
 WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint ' || COALESCE(o.conrelid::regclass::text, o.contypid::regtype::text) || ' ' || o.conname
       || ' validated=' || o.convalidated || ' ' || pg_catalog.pg_get_constraintdef(o.oid)
  FROM pg_catalog.pg_constraint o
  JOIN pg_catalog.pg_namespace n ON n.oid = o.connamespace
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
SELECT 'rule ' || r.schemaname || '.' || r.tablename || ' ' || r.rulename || ' ' || pg_catalog.md5(r.definition)
  FROM pg_catalog.pg_rules r
UNION ALL
SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_arguments(p.oid) || ')'
       || ' kind=' || p.prokind::text || ' returns=' || COALESCE(pg_catalog.pg_get_function_result(p.oid), '-')
       || ' language=' || l.lanname
       || ' secdef=' || p.prosecdef || ' volatile=' || p.provolatile::text
       || ' strict=' || p.proisstrict || ' leakproof=' || p.proleakproof || ' parallel=' || p.proparallel::text
       || ' cost=' || p.procost || ' rows=' || p.prorows
       || ' config=' || COALESCE(p.proconfig::text, '-')
       || ' owner=' || pg_catalog.pg_get_userbyid(p.proowner)
       || ' acl=' || COALESCE(p.proacl::text, '-')
       || ' body=' || pg_catalog.md5(p.prosrc)
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
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
       || ' base=' || COALESCE(pg_catalog.format_type(NULLIF(t.typbasetype, 0), t.typtypmod), '-')
       || ' notnull=' || t.typnotnull || ' default=' || COALESCE(t.typdefault, '-')
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
