-- S-1N-a (DAN-847-1): the published versions of the legal texts (D-301). A row
-- is a published version and never changes: no role of the database may
-- UPDATE, DELETE or TRUNCATE it, and (kind, language, version) is published
-- once. Negative cases first: 1 change and removal, 2 the repeated version,
-- 3 every class of input, 4 the app's other ways round; then 5 the access
-- matrix and 6 the catalogue, each with negative controls. The guard against
-- planted functions is database-wide in 000-rls-everywhere.sql and
-- 000-roles.sql. The content hashes are of invented text; the file rolls back.
BEGIN;
SET LOCAL search_path TO pg_catalog, pg_temp, public;
CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA public;
SET LOCAL lc_messages TO 'C';

SELECT plan(102);

-- Runs `sql` as `who` (NULL: the session's superuser), with
-- session_replication_role = replica when asked; gives back the SQLSTATE it
-- fails with, or 'ok'. A failure undoes the statement; a success is kept.
CREATE FUNCTION pg_temp.try_as(who text, sql text, replica boolean DEFAULT false) RETURNS text
  LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF replica THEN SET LOCAL session_replication_role = replica; END IF;
    IF who IS NOT NULL THEN EXECUTE pg_catalog.format('SET LOCAL ROLE %I', who); END IF;
    EXECUTE sql;
    RESET ROLE;
    SET LOCAL session_replication_role = origin;
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
  END;
END
$$;

CREATE TABLE pg_temp.hash (name text PRIMARY KEY, value bytea NOT NULL);
INSERT INTO pg_temp.hash VALUES
  ('a', sha256(convert_to('Izmišljeni uvjeti korištenja, inačica 1.', 'UTF8'))),
  ('b', sha256(convert_to('Izmišljena obavijest o privatnosti.', 'UTF8')));
INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at)
  SELECT 'terms_of_use', 'hr', 999001, value, '2026-12-01 00:00+01' FROM pg_temp.hash WHERE name = 'a';
CREATE TABLE pg_temp.before AS
  SELECT v.* FROM public.legal_text_version v WHERE (kind, language, version) = ('terms_of_use', 'hr', 999001);

-- 1. Nobody changes or removes a published version: both roles of the
-- database (no right), the superuser and the superuser with
-- session_replication_role = replica (the triggers fire ALWAYS).
SELECT is(pg_temp.try_as(w.who, s.sql, w.replica), w.expected,
  coalesce(w.who, 'the superuser') || CASE WHEN w.replica THEN ' (replica)' ELSE '' END || ' is refused: ' || s.sql)
FROM (VALUES ('ductus_legal_app', false, '42501'), ('ductus_legal_migrator', false, '42501'),
             (NULL, false, '55000'), (NULL, true, '55000')) w (who, replica, expected)
CROSS JOIN unnest(ARRAY[
  'UPDATE public.legal_text_version SET version = 2',
  'UPDATE public.legal_text_version SET content_sha256 = ''\x00''::bytea || content_sha256',
  'UPDATE public.legal_text_version SET kind = ''privacy_notice''',
  'UPDATE public.legal_text_version SET language = ''en''',
  'UPDATE public.legal_text_version SET published_at = published_at - interval ''1 day''',
  'UPDATE public.legal_text_version SET effective_at = effective_at + interval ''1 day''',
  'DELETE FROM public.legal_text_version',
  'TRUNCATE public.legal_text_version'
]) s (sql);
SELECT set_eq('SELECT v.* FROM public.legal_text_version v WHERE (kind, language, version) = (''terms_of_use'', ''hr'', 999001)',
  'SELECT * FROM pg_temp.before', 'after every attempt the published version is there, every column unchanged');

-- 2. A version is published once per kind and language.
SELECT is(pg_temp.try_as(NULL, format(
  'INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at) VALUES (%L, %L, %s, %L, ''2026-12-01 00:00+01'')',
  r.kind, r.language, r.version, (SELECT value FROM pg_temp.hash WHERE name = r.hash))), r.expected, r.what)
FROM (VALUES
  ('terms_of_use', 'hr', 999001, 'a', '23505', 'the same kind, language and version again is refused'),
  ('terms_of_use', 'hr', 999001, 'b', '23505', 'the same kind, language and version with another text is refused'),
  ('terms_of_use', 'en', 999001, 'a', 'ok', 'the same version in another language is accepted'),
  ('privacy_notice', 'hr', 999001, 'b', 'ok', 'the same version of another kind is accepted'),
  ('terms_of_use', 'hr', 999002, 'b', 'ok', 'the next version of the same text is accepted')
) r (kind, language, version, hash, expected, what);
SELECT is(pg_temp.try_as(NULL, format(
  'INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at) VALUES (''cookie_policy'', ''hr'', 999007, %L, ''2026-12-01''), (''cookie_policy'', ''hr'', 999007, %L, ''2026-12-01'')',
  (SELECT value FROM pg_temp.hash WHERE name = 'a'), (SELECT value FROM pg_temp.hash WHERE name = 'b'))),
  '23505', 'two rows of the same version in one INSERT are refused');
SELECT is((SELECT count(*)::int FROM public.legal_text_version WHERE kind = 'cookie_policy' AND version = 999007), 0,
  'and neither of them is kept');

-- 3. The shape of a row: each class of input, at both edges where there is one.
SELECT is(pg_temp.try_as(NULL, format(
  'INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at) VALUES (%L, %L, %s, %L::bytea, %L)',
  b.kind, b.language, coalesce(b.version::text, 'NULL'), b.hash, b.effective)), b.expected, b.what)
FROM (VALUES
  ('', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'an empty kind is refused'),
  (NULL, 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23502', 'a NULL kind is refused'),
  ('terms', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind outside the list is refused'),
  ('institution_addendum', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'the institution addendum is not a kind of this table'),
  ('Terms_of_use', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind in capitals is refused'),
  (' terms_of_use', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind with a leading space is refused'),
  ('terms_of_use ', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind with a trailing space is refused'),
  ('terms_of_use' || E'\t', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind with a tab is refused'),
  ('terms_of_use' || E'\r\n', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind with CRLF is refused'),
  ('terms_of_use' || E'\u00A0', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind with NBSP is refused'),
  ('terms_of_use' || E'\u007F', 'hr', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a kind with DEL is refused'),
  ('terms_of_use', '', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'an empty language is refused'),
  ('terms_of_use', NULL, 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23502', 'a NULL language is refused'),
  ('terms_of_use', 'HR', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a language in capitals is refused'),
  ('terms_of_use', 'hr-HR', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a language with a region is refused'),
  ('terms_of_use', 'de', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a language outside the list is refused'),
  ('terms_of_use', 'hr' || E'\u00A0', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a language with NBSP is refused'),
  ('terms_of_use', 'en' || E'\n', 999010, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a language with a newline is refused'),
  ('terms_of_use', 'hr', 0, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'version 0 is refused'),
  ('terms_of_use', 'hr', -1, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'a negative version is refused'),
  ('terms_of_use', 'hr', 1000001, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23514', 'version 1 000 001 is refused'),
  ('terms_of_use', 'hr', NULL, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', '23502', 'a NULL version is refused'),
  ('terms_of_use', 'hr', 1000000, '\x' || repeat('ab', 32), '2026-12-01 00:00+01', 'ok', 'version 1 000 000 is accepted'),
  ('terms_of_use', 'hr', 999011, '\x', '2026-12-01 00:00+01', '23514', 'an empty hash is refused'),
  ('terms_of_use', 'hr', 999011, '\x' || repeat('ab', 31), '2026-12-01 00:00+01', '23514', 'a hash of 31 bytes is refused'),
  ('terms_of_use', 'hr', 999011, '\x' || repeat('ab', 33), '2026-12-01 00:00+01', '23514', 'a hash of 33 bytes is refused'),
  ('terms_of_use', 'hr', 999011, NULL, '2026-12-01 00:00+01', '23502', 'a NULL hash is refused'),
  ('terms_of_use', 'hr', 999012, '\x' || repeat('ab', 32), NULL, '23502', 'a NULL date of entry into force is refused'),
  ('terms_of_use', 'hr', 999012, '\x' || repeat('ab', 32), 'not a date', '22007', 'a date of entry into force that is not a time is refused'),
  ('terms_of_use', 'hr', 999012, '\x' || repeat('ab', 32), 'infinity', '23514', 'an infinite date of entry into force is refused'),
  ('terms_of_use', 'hr', 999012, '\x' || repeat('ab', 32), '-infinity', '23514', 'a date of entry into force at minus infinity is refused')
) b (kind, language, version, hash, effective, expected, what);
SELECT is(pg_temp.try_as(NULL,
  'INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at, published_at) VALUES (''terms_of_use'', ''hr'', 999013, ''\x' || repeat('ab', 32) || ''', ''2026-12-01'', ''infinity'')'),
  '23514', 'an infinite time of publication is refused');
-- Version 1 of every kind in every language is accepted. The rows are made in
-- a block that then raises its own code, so nothing stays and nothing can meet
-- a row a later seed commits; a pair that already has version 1 shows it too.
SELECT is(pg_temp.try_as(NULL, $$ DO $d$ BEGIN
    INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at)
      SELECT k, l, 1, sha256(convert_to('Izmišljeni tekst.', 'UTF8')), '2026-12-01'
      FROM unnest(ARRAY['terms_of_use', 'privacy_notice', 'cookie_policy']) k
      CROSS JOIN unnest(ARRAY['hr', 'en']) l
      WHERE NOT EXISTS (SELECT 1 FROM public.legal_text_version v WHERE (v.kind, v.language, v.version) = (k, l, 1));
    IF (SELECT count(*) FROM public.legal_text_version WHERE version = 1) <> 6 THEN
      RAISE EXCEPTION 'version 1 is missing for a kind or a language' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'undo the six rows' USING ERRCODE = 'P0002';
  END $d$ $$), 'P0002', 'version 1 of each kind in each language is accepted');
SELECT ok((SELECT published_at IS NOT NULL AND published_at <= clock_timestamp() FROM public.legal_text_version
           WHERE (kind, language, version) = ('terms_of_use', 'hr', 1000000)),
  'the database gives each version its time of publication');

-- 4. The app reads every version and does nothing else.
SELECT is(pg_temp.try_as('ductus_legal_app', format(
  $$ DO $d$ BEGIN
       IF (SELECT count(*) FROM public.legal_text_version) <> %s THEN
         RAISE EXCEPTION 'the app does not see every version' USING ERRCODE = 'P0001';
       END IF;
     END $d$ $$, (SELECT count(*) FROM public.legal_text_version))), 'ok', 'the app reads every published version');
SELECT is(pg_temp.try_as('ductus_legal_app', w.sql), '42501', 'the app is refused: ' || w.sql)
FROM unnest(ARRAY[
  'INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at) VALUES (''terms_of_use'', ''hr'', 999020, ''\xabababababababababababababababababababababababababababababababab''::bytea, ''2026-12-01'')',
  'INSERT INTO public.legal_text_version (id, kind, language, version, content_sha256, effective_at) OVERRIDING SYSTEM VALUE VALUES (-5, ''terms_of_use'', ''hr'', 999021, ''\xabababababababababababababababababababababababababababababababab''::bytea, ''2026-12-01'')',
  'SELECT id FROM public.legal_text_version FOR SHARE',
  'LOCK TABLE public.legal_text_version IN ACCESS EXCLUSIVE MODE',
  'MERGE INTO public.legal_text_version v USING (SELECT 1 AS version) s ON v.version = s.version WHEN MATCHED THEN DELETE',
  'SELECT setval(pg_get_serial_sequence(''public.legal_text_version'', ''id''), 1)',
  'ALTER TABLE public.legal_text_version DISABLE TRIGGER legal_text_version_no_change',
  'ALTER TABLE public.legal_text_version NO FORCE ROW LEVEL SECURITY',
  'DROP POLICY legal_text_version_read ON public.legal_text_version',
  'DROP TABLE public.legal_text_version'
]) w (sql);
SELECT is(pg_temp.try_as('ductus_legal_migrator',
  'INSERT INTO public.legal_text_version (kind, language, version, content_sha256, effective_at) VALUES (''terms_of_use'', ''hr'', 999022, ''\xabababababababababababababababababababababababababababababababab''::bytea, ''2026-12-01'')'),
  '42501', 'the owner cannot publish either: RLS is forced and there is no INSERT policy until DAN-848');
DO $$ BEGIN PERFORM pg_temp.try_as('ductus_legal_app', 'GRANT UPDATE, DELETE, TRUNCATE, INSERT ON public.legal_text_version TO ductus_legal_app'); END $$;

-- 5. The access matrix, read from the catalogue: every right on the table of
-- a role that is not a superuser, or of PUBLIC, inherited or by SET ROLE, as
-- db/logs/tests/010-log-entry.sql reads it. The main roles share this cluster.
CREATE VIEW pg_temp.version_right AS
  SELECT DISTINCT r.rolname || ': ' || p.privilege
         || CASE WHEN g.rolname = r.rolname THEN '' ELSE ' via ' || g.rolname END AS found
  FROM (SELECT x.oid, x.rolname::text FROM pg_roles x WHERE NOT x.rolsuper AND x.rolname NOT LIKE 'pg\_%'
        UNION ALL SELECT 0, 'public') AS r (oid, rolname)
  JOIN LATERAL (SELECT y.rolname::text FROM pg_roles y
                WHERE r.oid = 0 AND y.oid = 0 OR r.oid <> 0 AND pg_has_role(r.oid, y.oid, 'MEMBER')
                UNION ALL SELECT 'public' WHERE r.oid = 0) AS g (rolname) ON true
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
              || CASE WHEN current_setting('server_version_num')::int >= 170000
                      THEN ARRAY['MAINTAIN'] ELSE '{}'::text[] END) AS p (privilege)
  WHERE has_table_privilege(g.rolname, 'public.legal_text_version'::regclass, p.privilege)
     OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
         AND has_any_column_privilege(g.rolname, 'public.legal_text_version'::regclass, p.privilege));
-- The owner keeps what publishing needs (INSERT for the RPC of DAN-848,
-- REFERENCES for the acceptances of 847-2); the app only reads.
CREATE TABLE pg_temp.expected_right (found text PRIMARY KEY);
INSERT INTO pg_temp.expected_right VALUES
  ('ductus_legal_migrator: SELECT'), ('ductus_legal_migrator: INSERT'),
  ('ductus_legal_migrator: REFERENCES'), ('ductus_legal_migrator: TRIGGER'), ('ductus_legal_app: SELECT');
INSERT INTO pg_temp.expected_right
  SELECT 'ductus_legal_migrator: MAINTAIN' WHERE current_setting('server_version_num')::int >= 170000;
CREATE VIEW pg_temp.drift AS
  (SELECT '+' || x.found AS found FROM (SELECT found FROM pg_temp.version_right EXCEPT SELECT found FROM pg_temp.expected_right) x)
  UNION ALL
  (SELECT '-' || x.found FROM (SELECT found FROM pg_temp.expected_right EXCEPT SELECT found FROM pg_temp.version_right) x);

SELECT is_empty('SELECT found FROM pg_temp.drift',
  'the access matrix: the app only SELECTs, the owner has no UPDATE, DELETE or TRUNCATE, nobody else (PUBLIC, a main role) holds a right, even after the app granted itself more');
SELECT is_empty($$ SELECT r.rolname FROM pg_roles r, pg_class c
                   WHERE c.oid = pg_get_serial_sequence('public.legal_text_version', 'id')::regclass
                     AND r.oid <> c.relowner AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'
                     AND (has_sequence_privilege(r.oid, c.oid, 'USAGE') OR has_sequence_privilege(r.oid, c.oid, 'UPDATE')) $$,
  'nobody but the owner may use or set the id sequence');
GRANT SELECT ON public.legal_text_version TO ductus_app;
SELECT isnt_empty($$ SELECT found FROM pg_temp.drift WHERE found = '+ductus_app: SELECT' $$, 'control: SELECT for a main role is caught');
REVOKE SELECT ON public.legal_text_version FROM ductus_app;
GRANT UPDATE (content_sha256), DELETE ON public.legal_text_version TO ductus_legal_app;
SELECT set_eq('SELECT found FROM pg_temp.drift', ARRAY['+ductus_legal_app: UPDATE', '+ductus_legal_app: DELETE'],
  'control: a column UPDATE and DELETE for the app are caught');
REVOKE UPDATE (content_sha256), DELETE ON public.legal_text_version FROM ductus_legal_app;
GRANT INSERT ON public.legal_text_version TO PUBLIC;
SELECT isnt_empty($$ SELECT found FROM pg_temp.drift WHERE found = '+public: INSERT' $$, 'control: INSERT for PUBLIC is caught');
REVOKE INSERT ON public.legal_text_version FROM PUBLIC;
GRANT UPDATE ON public.legal_text_version TO ductus_legal_migrator;
SELECT set_eq('SELECT found FROM pg_temp.drift', ARRAY['+ductus_legal_migrator: UPDATE'], 'control: UPDATE given back to the owner is caught');
REVOKE UPDATE ON public.legal_text_version FROM ductus_legal_migrator;

-- 6. The catalogue.
SELECT ok(EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '20261118160000'),
  'the legal text version migration is in the ledger');
SELECT is((SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.legal_text_version'::regclass),
  'ductus_legal_migrator', 'the migrator owns the table');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.legal_text_version'::regclass),
  'RLS is enabled and forced');
SELECT set_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polpermissive::text || ' '
            || array_to_string(ARRAY(SELECT r::regrole::text FROM unnest(polroles) r ORDER BY 1), ',')
            || ' using ' || coalesce(pg_get_expr(polqual, polrelid), '-')
            || ' check ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-')
     FROM pg_policy WHERE polrelid = 'public.legal_text_version'::regclass $$,
  ARRAY['legal_text_version_read r true ductus_legal_app using true check -'],
  'one policy: SELECT for the app, every version is public (D-301)');
SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                     || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
                     || CASE WHEN a.attidentity = 'a' THEN ' identity always' ELSE '' END
                     || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.legal_text_version'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'id bigint not null identity always, kind text not null, language text not null, version integer not null, '
  || 'content_sha256 bytea not null, published_at timestamp with time zone not null default clock_timestamp(), '
  || 'effective_at timestamp with time zone not null',
  'the columns, their types, NOT NULL, the identity and the one default, as the contract has them');
SELECT set_eq($$ SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
                 WHERE conrelid = 'public.legal_text_version'::regclass AND contype = 'c' $$,
  ARRAY[
    'legal_text_version_content_sha256 CHECK ((octet_length(content_sha256) = 32))',
    'legal_text_version_finite CHECK ((isfinite(published_at) AND isfinite(effective_at)))',
    'legal_text_version_kind CHECK ((kind = ANY (ARRAY[''terms_of_use''::text, ''privacy_notice''::text, ''cookie_policy''::text])))',
    'legal_text_version_language CHECK ((language = ANY (ARRAY[''hr''::text, ''en''::text])))',
    'legal_text_version_version CHECK (((version >= 1) AND (version <= 1000000)))'],
  'exactly these CHECK constraints, versions from 1 to 1 000 000 among them, and no other');
SELECT set_eq(
  $$ SELECT c.contype::text || ' ' || c.condeferrable::text || ' '
            || array_to_string(ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k (n, i)
                                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i), ',')
     FROM pg_constraint c WHERE c.conrelid = 'public.legal_text_version'::regclass AND c.contype IN ('u', 'p') $$,
  ARRAY['p false id', 'u false kind,language,version'],
  'the version is unique over exactly kind, language and version, checked at once (a unique index holds across concurrent transactions)');
SELECT set_eq(
  $$ SELECT t.tgname || ' ' || t.tgenabled::text || ' ' || t.tgtype::text || ' columns ' || t.tgattr::text
            || ' when ' || coalesce(pg_get_expr(t.tgqual, t.tgrelid), '-') FROM pg_trigger t
     WHERE t.tgrelid = 'public.legal_text_version'::regclass AND NOT t.tgisinternal $$,
  -- tgtype: 27 = ROW | BEFORE | DELETE | UPDATE, 34 = BEFORE | TRUNCATE (per statement).
  ARRAY['legal_text_version_no_change A 27 columns  when -', 'legal_text_version_no_truncate A 34 columns  when -'],
  'the refusing triggers fire ALWAYS, before UPDATE (of any column, with no WHEN) or DELETE of each row and before TRUNCATE');
SELECT is(
  (SELECT array_to_string(p.proconfig, ',') || ' ' || p.prosecdef::text || ' '
          || (NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          WHERE a.grantee <> p.proowner))::text
   FROM pg_proc p WHERE p.oid = 'public.legal_text_version_refuse_change()'::regprocedure),
  'search_path=pg_catalog false true',
  'the trigger function has a fixed search path, is not SECURITY DEFINER and only its owner may execute it');
ALTER TABLE public.legal_text_version ENABLE TRIGGER legal_text_version_no_change;
SELECT is(pg_temp.try_as(NULL, 'DELETE FROM public.legal_text_version', true), 'ok',
  'control: a trigger enabled only for origin lets a replica session delete, so ALWAYS is what holds');

SELECT * FROM finish();
ROLLBACK;
