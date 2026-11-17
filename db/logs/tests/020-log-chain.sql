-- S-1K.2-b (DAN-816): the chain over public.log_entry. Appends chain on the
-- head with no gap and no fork, whoever appends and however; the head of the
-- chain (public.log_chain_head) moves only with an append; its row of the
-- access matrix and that of the chain's functions; and public.log_chain_verify()
-- finds every change, deletion and insertion made behind the triggers' back.
-- S-1K.8 (DAN-868-1): the base of the chain (public.log_chain_base) does not
-- change, only its owner reads it, and the verification starts from it.
-- Plan of attack: ductura/server#125 (A, C, D; B, concurrent appends, is in
-- tests/db/log-chain.integration.test.ts).
--
-- Rows other tests left (the concurrent appends of pnpm test:database commit)
-- may be there: every place below is counted from the head as found. The
-- search path and the guard against planted functions are those of
-- 000-rls-everywhere.sql. The file rolls back, so nothing stays.
BEGIN;
-- Nothing below resolves through the caller's search path: "$user" or any
-- schema before pgTAP's could hold a planted is_empty, ok or operator. The
-- path is pg_catalog, pg_temp (so the helper views below, which are also
-- named with pg_temp., come before anything in pgTAP's schema), then the
-- schema pgTAP lives in, and nothing else. pg_temp is never searched for
-- functions or operators.
SET LOCAL search_path TO pg_catalog, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA public;
SET LOCAL lc_messages TO 'C';
-- pgTAP's schema can also hold objects that are not pgTAP's (the migrator
-- owns each database and may create in public): a function there that is not
-- part of an extension and carries the name of a pgTAP or pg_catalog
-- function, or any such operator, could change what the assertions compute.
-- This raises rather than asserts, as a planted object could bend the
-- assertion itself.
DO $$
DECLARE
  tap_schema name;
  planted text;
BEGIN
  SELECT n.nspname INTO STRICT tap_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) e.extnamespace
  WHERE e.extname OPERATOR(pg_catalog.=) 'pgtap';
  PERFORM pg_catalog.set_config('search_path', pg_catalog.format('pg_catalog, pg_temp, %I', tap_schema), true);

  SELECT pg_catalog.string_agg(x.found, ', ') INTO planted FROM (
    SELECT p.oid::pg_catalog.regprocedure::text AS found FROM pg_catalog.pg_proc p
    WHERE p.pronamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND p.pronamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) p.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                  WHERE q.proname OPERATOR(pg_catalog.=) p.proname
                    AND (q.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace
                         OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                                    WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                                      AND d.objid OPERATOR(pg_catalog.=) q.oid
                                      AND d.deptype OPERATOR(pg_catalog.=) 'e')))
    UNION ALL
    SELECT o.oid::pg_catalog.regoperator::text FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND o.oprnamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_operator'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) o.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
  ) x;
  IF planted IS NOT NULL THEN
    RAISE EXCEPTION 'a function or operator beside pgTAP shadows pgTAP or pg_catalog: %', planted;
  END IF;
END
$$;


SELECT plan(146);

-- As 010-log-entry.sql: runs `sql` as `who` (NULL: the superuser), with
-- session_replication_role = replica when asked; the SQLSTATE or 'ok'.
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

-- The head as found; places below are counted from it.
CREATE TABLE pg_temp.base AS SELECT seq AS n FROM public.log_chain_head;
CREATE FUNCTION pg_temp.at(k int) RETURNS bigint LANGUAGE sql AS $$ SELECT n + k FROM pg_temp.base $$;

-- What the reader's verification reports, places counted from the base:
-- '<k> <problem>' in order, '- head' for a head that is not one row.
CREATE FUNCTION pg_temp.verified() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  result text[];
  b bigint := (SELECT n FROM pg_temp.base);
BEGIN
  SET LOCAL ROLE ductus_logs_reader;
  SELECT coalesce(array_agg(coalesce((v.seq - b)::text, '-') || ' ' || v.problem
                            ORDER BY v.seq NULLS FIRST, v.problem), '{}')
    INTO result FROM public.log_chain_verify() v;
  RESET ROLE;
  RETURN result;
END
$$;

-- Runs `sql` as the superuser with every trigger of the three tables off, so it
-- can change what the triggers otherwise refuse, gives back what the
-- verification then reports, and undoes it all.
CREATE FUNCTION pg_temp.tampered(sql text) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  result text[];
BEGIN
  BEGIN
    ALTER TABLE public.log_entry DISABLE TRIGGER USER;
    ALTER TABLE public.log_chain_head DISABLE TRIGGER USER;
    ALTER TABLE public.log_chain_base DISABLE TRIGGER USER;
    EXECUTE replace(regexp_replace(sql, ':cut(\d)',
      'UPDATE public.log_chain_base SET (seq, hash) = (SELECT seq, hash FROM public.log_entry WHERE seq = :base + \1);
       DELETE FROM public.log_entry WHERE seq <= :base + \1', 'g'), ':base', (SELECT n FROM pg_temp.base)::text);
    result := pg_temp.verified();
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN result;
  END;
END
$$;

-- Every right on the head or the base, or EXECUTE on a function of the chain, held by a
-- role that is not a superuser, or by PUBLIC, directly or by membership.
CREATE VIEW pg_temp.chain_right AS
  WITH holder AS (
    SELECT r.rolname::text AS who, g.rolname::text AS via, g.oid AS via_oid
    FROM pg_roles r JOIN pg_roles g ON pg_has_role(r.oid, g.oid, 'MEMBER')
    WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'
    UNION ALL SELECT 'public', 'public', 0
  )
  SELECT DISTINCT h.who || ': ' || p.privilege || ' ' || t.name
         || CASE WHEN h.via = h.who THEN '' ELSE ' via ' || h.via END AS found
  FROM holder h
  CROSS JOIN unnest(ARRAY['log_chain_head', 'log_chain_base']) t (name)
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
              || CASE WHEN current_setting('server_version_num')::int >= 170000
                      THEN ARRAY['MAINTAIN'] ELSE '{}'::text[] END) AS p (privilege)
  WHERE has_table_privilege(h.via, ('public.' || t.name)::regclass, p.privilege)
     OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
         AND has_any_column_privilege(h.via, ('public.' || t.name)::regclass, p.privilege))
  UNION
  SELECT h.who || ': EXECUTE ' || f.name || CASE WHEN h.via = h.who THEN '' ELSE ' via ' || h.via END
  FROM holder h
  CROSS JOIN (VALUES ('log_chain_verify', 'public.log_chain_verify()'),
                     ('log_entry_digest', 'public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb)'),
                     ('log_entry_chain', 'public.log_entry_chain()'),
                     ('log_chain_head_guard', 'public.log_chain_head_guard()'),
                     ('log_chain_base_refuse_change', 'public.log_chain_base_refuse_change()')) f (name, signature)
  WHERE has_function_privilege(h.via, f.signature, 'EXECUTE');

CREATE TABLE pg_temp.expected_chain_right (found text PRIMARY KEY);
INSERT INTO pg_temp.expected_chain_right VALUES
  ('ductus_logs_migrator: SELECT log_chain_head'), ('ductus_logs_migrator: UPDATE log_chain_head'),
  ('ductus_logs_migrator: REFERENCES log_chain_head'), ('ductus_logs_migrator: TRIGGER log_chain_head'),
  ('ductus_logs_migrator: EXECUTE log_chain_verify'), ('ductus_logs_migrator: EXECUTE log_entry_digest'),
  ('ductus_logs_migrator: EXECUTE log_entry_chain'), ('ductus_logs_migrator: EXECUTE log_chain_head_guard'),
  ('ductus_logs_reader: EXECUTE log_chain_verify'),
  ('ductus_logs_migrator: SELECT log_chain_base'), ('ductus_logs_migrator: REFERENCES log_chain_base'),
  ('ductus_logs_migrator: TRIGGER log_chain_base'), ('ductus_logs_migrator: EXECUTE log_chain_base_refuse_change');
INSERT INTO pg_temp.expected_chain_right
  SELECT 'ductus_logs_migrator: MAINTAIN ' || t FROM unnest(ARRAY['log_chain_head', 'log_chain_base']) t WHERE current_setting('server_version_num')::int >= 170000;
CREATE VIEW pg_temp.chain_drift AS
  (SELECT '+' || x.found AS found FROM (
     SELECT found FROM pg_temp.chain_right EXCEPT SELECT found FROM pg_temp.expected_chain_right) x)
  UNION ALL
  (SELECT '-' || x.found FROM (
     SELECT found FROM pg_temp.expected_chain_right EXCEPT SELECT found FROM pg_temp.chain_right) x);

-- 1. As migrated (A5, D1, D2, D4).
SELECT ok(EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '20261116170000'),
  'the chain migration is in the ledger');
SELECT set_eq(
  $$ SELECT conname::text FROM pg_constraint
     WHERE conrelid = 'public.log_entry'::regclass AND contype = 'u' $$,
  ARRAY['log_entry_seq_unique', 'log_entry_prev_hash_unique'],
  'seq and prev_hash are each unique, so the chain cannot fork');
SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                     || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END, ', ' ORDER BY a.attnum)
   FROM pg_attribute a WHERE a.attrelid = 'public.log_chain_head'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'only_row boolean not null, seq bigint not null, hash bytea not null',
  'log_chain_head holds the last seq and hash');
SELECT is((SELECT count(*)::int FROM public.log_chain_head), 1, 'the head is one row');
SELECT is((SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.log_chain_head'::regclass),
  'ductus_logs_migrator', 'the migrator owns the head');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.log_chain_head'::regclass),
  'RLS on the head is enabled and forced');
SELECT set_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' '
            || array_to_string(ARRAY(SELECT r::regrole::text FROM unnest(polroles) r ORDER BY 1), ',')
            || ' using ' || coalesce(pg_get_expr(polqual, polrelid), '-')
            || ' check ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-')
     FROM pg_policy WHERE polrelid = 'public.log_chain_head'::regclass $$,
  ARRAY['log_chain_head_chain_read r ductus_logs_migrator using true check -',
        'log_chain_head_chain_move w ductus_logs_migrator using true check true'],
  'the head: the owner reads and moves it (for the insert trigger); no policy for the reader');
SELECT ok(EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '20261117120000'),
  'the base migration is in the ledger');
SELECT is((SELECT array_agg(seq::text || ' ' || encode(hash, 'hex')) FROM public.log_chain_base), ARRAY['0 ' || repeat('00', 32)],
  'the base is one row, seq 0 and 32 zero bytes: nothing is cut');
SELECT is((SELECT relowner::regrole::text || ' ' || (relrowsecurity AND relforcerowsecurity)::text
           FROM pg_class WHERE oid = 'public.log_chain_base'::regclass),
  'ductus_logs_migrator true', 'the migrator owns the base; RLS on it is enabled and forced');
SELECT set_eq(
  $$ SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.log_chain_base'::regclass $$,
  ARRAY['log_chain_base_pkey PRIMARY KEY (only_row)', 'log_chain_base_one_row CHECK (only_row)',
        'log_chain_base_seq CHECK ((seq >= 0))', 'log_chain_base_hash_size CHECK ((octet_length(hash) = 32))'],
  'the base is one row, its seq at least 0 and its hash 32 bytes');
SELECT set_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || array_to_string(polroles::regrole[], ',')
            || ' using ' || coalesce(pg_get_expr(polqual, polrelid), '-') || ' check ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-')
     FROM pg_policy WHERE polrelid = 'public.log_chain_base'::regclass $$,
  ARRAY['log_chain_base_owner_read r ductus_logs_migrator using true check -'],
  'the base: only the owner reads it (for the verification), by a policy of its own');
SELECT is_empty('SELECT found FROM pg_temp.chain_drift',
  'the access matrix of the head, the base and the functions: the reader only verifies, the owner keeps what the trigger and the verification need and nothing to write the base, nobody else (writer, retention, PUBLIC, any other role) holds a right');
SELECT set_eq(
  $$ SELECT t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || t.tgtype::text
     FROM pg_trigger t
     WHERE t.tgrelid IN ('public.log_entry'::regclass, 'public.log_chain_head'::regclass, 'public.log_chain_base'::regclass)
       AND NOT t.tgisinternal $$,
  -- tgtype: 7 = ROW | BEFORE | INSERT, 27 = ROW | BEFORE | DELETE | UPDATE,
  -- 31 = ROW | BEFORE | INSERT | DELETE | UPDATE, 34 = BEFORE | TRUNCATE.
  ARRAY['log_entry log_entry_chain A 7', 'log_entry log_entry_no_change A 27', 'log_entry log_entry_no_truncate A 34',
        'log_chain_head log_chain_head_guard A 31', 'log_chain_head log_chain_head_no_truncate A 34',
        'log_chain_base log_chain_base_guard A 31', 'log_chain_base log_chain_base_no_truncate A 34'],
  'every trigger of the chain fires ALWAYS');
-- DAN-835-4: the head hash and the digest cover the full payload; with the
-- rest of a row from operator_log they would let the reader guess an IPv4
-- inside its /24. The reader holds neither.
SELECT is(pg_temp.try_as('ductus_logs_reader', r.sql), '42501', 'the reader is refused: ' || r.sql)
FROM unnest(ARRAY[
  'SELECT hash FROM public.log_chain_head',
  'SELECT public.log_entry_digest(''\x00'', 1, 1, now(), ''authn.x'', ''{}'')'
]) r (sql);
SELECT set_eq(
  $$ SELECT p.proname || ' ' || array_to_string(p.proconfig, ',') || ' ' || p.prosecdef::text
     FROM pg_proc p
     WHERE p.oid IN ('public.log_entry_chain()'::regprocedure, 'public.log_chain_head_guard()'::regprocedure,
                     'public.log_chain_verify()'::regprocedure, 'public.log_chain_base_refuse_change()'::regprocedure,
                     'public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb)'::regprocedure) $$,
  ARRAY['log_entry_chain search_path=pg_catalog true', 'log_chain_head_guard search_path=pg_catalog false',
        'log_chain_verify search_path=pg_catalog, pg_temp true', 'log_entry_digest search_path=pg_catalog false',
        'log_chain_base_refuse_change search_path=pg_catalog false'],
  'every function has a fixed search path; the insert trigger and the verification (the reader has no right on log_entry, DAN-835-4) run as their owner');
SELECT is(pg_temp.verified(), '{}', 'the chain as found is intact');

-- 2. Appending (A1, A4).
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES ('authn.login_started', '{"n": 1}'),
                                                        ('authn.login_succeeded', '{"n": 2}') $$),
  'ok', 'the writer appends two rows in one INSERT');
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES ('authn.logout', '{"n": 3}') $$),
  'ok', 'and one more');
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES ('Authn.bad', '{"n": 0}') $$),
  '23514', 'an append the table refuses');
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES (NULL, '{"n": 0}') $$),
  '23502', 'an append without a kind is refused');
SELECT is((SELECT seq FROM public.log_chain_head), pg_temp.at(3), 'a refused append does not move the head');
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES ('authn.login_started', '{"n": 4}') $$),
  'ok', 'the writer appends after the refusals');
SELECT is(pg_temp.try_as(NULL,
  $$ DO $d$ BEGIN
       SET LOCAL ROLE ductus_logs_writer;
       INSERT INTO public.log_entry (kind, payload) VALUES ('authn.login_started', '{"n": 0}');
       RAISE EXCEPTION 'undo' USING ERRCODE = 'P0001';
     END $d$ $$),
  'P0001', 'an append that is rolled back');
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES ('authn.login_started', '{"n": 5}') $$),
  'ok', 'the writer appends after the rollback');
SELECT is(
  (SELECT array_agg((seq - pg_temp.at(0))::text || ' ' || (payload->>'n') ORDER BY seq)
   FROM public.log_entry WHERE seq > pg_temp.at(0)),
  ARRAY['1 1', '2 2', '3 3', '4 4', '5 5'],
  'the five rows take the next five places in order, with no gap left by the refused or rolled back appends');
SELECT ok(
  (SELECT bool_and(e.prev_hash = p.hash) FROM public.log_entry e JOIN public.log_entry p ON p.seq = e.seq - 1
   WHERE e.seq > pg_temp.at(0)),
  'each row carries the digest of the row before it');
SELECT is((SELECT encode(prev_hash, 'hex') FROM public.log_entry WHERE seq = 1), repeat('00', 32),
  'the first row of the chain follows 32 zero bytes');
SELECT ok(
  (SELECT bool_and(e.hash = public.log_entry_digest(e.prev_hash, e.seq, e.id, e.at, e.kind, e.payload))
   FROM public.log_entry e WHERE e.seq > pg_temp.at(0)),
  'each row carries the digest of its content');
SELECT ok(
  (SELECT bool_and(e.at >= p.at) FROM public.log_entry e JOIN public.log_entry p ON p.seq = e.seq - 1
   WHERE e.seq > pg_temp.at(0)),
  'the time of a row never goes back along the chain');
SELECT is((SELECT seq::text || ' ' || encode(hash, 'hex') FROM public.log_chain_head),
  (SELECT seq::text || ' ' || encode(hash, 'hex') FROM public.log_entry ORDER BY seq DESC LIMIT 1),
  'the head is the last row');
SELECT is(pg_temp.verified(), '{}', 'the chain verifies');
SET LOCAL TimeZone = 'Pacific/Kiritimati';
SET LOCAL DateStyle = 'SQL, DMY';
SET LOCAL extra_float_digits = -15;
SELECT is(pg_temp.verified(), '{}', 'and verifies under other time zone, date style and float digits (C10)');
RESET TimeZone;
RESET DateStyle;
RESET extra_float_digits;

-- 3. Forging the chain columns (A2, A3, A6).
SELECT is(pg_temp.try_as('ductus_logs_writer', w.sql), '42501', 'the writer is refused: ' || w.sql)
FROM unnest(ARRAY[
  'INSERT INTO public.log_entry (seq, kind, payload) VALUES (1, ''authn.login_started'', ''{}'')',
  'INSERT INTO public.log_entry (prev_hash, kind, payload) VALUES (''\x00'', ''authn.login_started'', ''{}'')',
  'INSERT INTO public.log_entry (hash, kind, payload) VALUES (''\x00'', ''authn.login_started'', ''{}'')',
  'SELECT 1 FROM public.log_chain_head',
  'SELECT * FROM public.log_chain_verify()',
  'SELECT public.log_entry_digest(''\x00'', 1, 1, now(), ''a.b'', ''{}'')',
  'UPDATE public.log_chain_head SET seq = 0'
]) w (sql);
SELECT is(pg_temp.try_as(r.replica_who, $$
  INSERT INTO public.log_entry (id, at, seq, prev_hash, hash, kind, payload) OVERRIDING SYSTEM VALUE
  VALUES (900000000 + $$ || r.n || $$, '1999-01-01', 1, decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'),
          'authn.login_started', '{"forged": true}') $$, r.replica),
  'ok', 'the superuser inserts a row with a forged place, time and digests' || r.what)
FROM (VALUES (1, NULL::text, false, ''), (2, NULL, true, ' under session_replication_role = replica')) r (n, replica_who, replica, what);
SELECT is(
  (SELECT array_agg((seq - pg_temp.at(0))::text || ' ' || (at > '2000-01-01')::text || ' ' || (prev_hash <> decode(repeat('ab', 32), 'hex'))::text ORDER BY seq)
   FROM public.log_entry WHERE payload ? 'forged'),
  ARRAY['6 true true', '7 true true'],
  'the trigger gave both forged rows their real place, time and digests');
SELECT is(pg_temp.verified(), '{}', 'and the chain still verifies');
SELECT is(pg_temp.try_as(NULL, x.sql), '23505', x.what)
FROM (VALUES
  ($$ DO $d$ BEGIN
        ALTER TABLE public.log_entry DISABLE TRIGGER log_entry_chain;
        INSERT INTO public.log_entry (seq, prev_hash, hash, kind, payload)
        SELECT seq, decode(repeat('11', 32), 'hex'), decode(repeat('22', 32), 'hex'), kind, payload FROM public.log_entry ORDER BY seq DESC LIMIT 1;
      END $d$ $$, 'with the trigger off, a second row in the same place is refused (no fork)'),
  ($$ DO $d$ BEGIN
        ALTER TABLE public.log_entry DISABLE TRIGGER log_entry_chain;
        INSERT INTO public.log_entry (seq, prev_hash, hash, kind, payload)
        SELECT seq + 100, prev_hash, decode(repeat('22', 32), 'hex'), kind, payload FROM public.log_entry ORDER BY seq DESC LIMIT 1;
      END $d$ $$, 'with the trigger off, a second successor of one row is refused (no fork)')
) x (sql, what);

-- 4. The head moves only with an append (D3); the base does not move (DAN-868-1).
CREATE TABLE pg_temp.head_attempt (who text, sql text, replica boolean, expected text);
INSERT INTO pg_temp.head_attempt
  SELECT w.who, s.sql, false, CASE WHEN w.who = 'ductus_logs_migrator' AND s.sql LIKE 'UPDATE public.log_chain_head%' THEN '55000'
                                   WHEN w.who = 'ductus_logs_migrator' AND s.sql LIKE 'SELECT%' THEN 'ok' ELSE '42501' END
  FROM unnest(ARRAY['ductus_logs_migrator', 'ductus_logs_writer', 'ductus_logs_reader', 'ductus_logs_retention']) w (who)
  CROSS JOIN unnest(ARRAY['UPDATE public.log_chain_head SET seq = seq + 1',
                          'DELETE FROM public.log_chain_head',
                          'INSERT INTO public.log_chain_head (only_row, seq, hash) VALUES (true, 0, ''\x00'')',
                          'TRUNCATE public.log_chain_head',
                          'SELECT 1 FROM public.log_chain_base',
                          'UPDATE public.log_chain_base SET seq = seq + 1',
                          'DELETE FROM public.log_chain_base',
                          'INSERT INTO public.log_chain_base (only_row, seq, hash) VALUES (true, 0, ''\x00'')',
                          'TRUNCATE public.log_chain_base']) s (sql);
INSERT INTO pg_temp.head_attempt
  SELECT NULL, s.sql, r.replica, '55000'
  FROM unnest(ARRAY['UPDATE public.log_chain_head SET seq = seq + 1',
                    'UPDATE public.log_chain_head SET hash = decode(repeat(''00'', 32), ''hex'')',
                    'DELETE FROM public.log_chain_head',
                    'INSERT INTO public.log_chain_head (only_row, seq, hash) VALUES (false, 0, decode(repeat(''00'', 32), ''hex''))',
                    'TRUNCATE public.log_chain_head',
                    'UPDATE public.log_chain_base SET seq = seq + 1',
                    'UPDATE public.log_chain_base SET hash = decode(repeat(''ab'', 32), ''hex'')',
                    'DELETE FROM public.log_chain_base',
                    'INSERT INTO public.log_chain_base (only_row, seq, hash) VALUES (false, 0, decode(repeat(''00'', 32), ''hex''))',
                    'TRUNCATE public.log_chain_base']) s (sql)
  CROSS JOIN unnest(ARRAY[false, true]) r (replica);
SELECT is(pg_temp.try_as(who, sql, replica), expected,
  coalesce(who, 'the superuser') || CASE WHEN replica THEN ' with session_replication_role = replica' ELSE '' END
  || CASE expected WHEN 'ok' THEN ' may: ' ELSE ' is refused: ' END || sql)
FROM pg_temp.head_attempt ORDER BY who NULLS LAST, replica, sql;
SELECT is(pg_temp.try_as(NULL, $$
  CREATE FUNCTION pg_temp.bump() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN UPDATE public.log_chain_head SET seq = seq + 2; RETURN NULL; END $f$;
  CREATE TEMP TABLE poke (x int);
  CREATE TRIGGER poke AFTER INSERT ON pg_temp.poke FOR EACH ROW EXECUTE FUNCTION pg_temp.bump();
  INSERT INTO pg_temp.poke VALUES (1) $$),
  '55000', 'from a trigger, the head still moves only one step');
SELECT is(pg_temp.verified(), '{}', 'after every attempt the chain verifies');

-- 5. The verification finds every change made behind the triggers' back (C).
SELECT is(pg_temp.tampered(t.sql), t.expected, t.what)
FROM (VALUES
  ('UPDATE public.log_entry SET payload = ''{"n": 9}'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a changed payload is found at its row'),
  ('UPDATE public.log_entry SET kind = ''authn.logout'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a changed kind is found at its row'),
  ('UPDATE public.log_entry SET at = at - interval ''1 microsecond'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a time moved by one microsecond is found at its row'),
  ('UPDATE public.log_entry SET at = ''infinity'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a time set to infinity is found at its row, the verification does not fail'),
  ('UPDATE public.log_entry SET at = ''-infinity'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a time set to -infinity is found at its row'),
  ('UPDATE public.log_entry SET at = ''294276-12-31 23:59:59.999999+00'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a time set to the end of the range (beyond 64-bit microseconds since 1970) is found at its row'),
  ('UPDATE public.log_entry SET at = ''4713-11-24 00:00:00+00 BC'' WHERE seq = :base + 2', ARRAY['2 hash'],
   'a time set to the start of the range is found at its row'),
  ('UPDATE public.log_entry SET hash = decode(repeat(''ee'', 32), ''hex'') WHERE seq = :base + 2', ARRAY['2 hash', '3 link'],
   'a changed digest is found at its row and the next'),
  ('UPDATE public.log_entry SET payload = ''{"n": 9}'', hash = public.log_entry_digest(prev_hash, seq, id, at, kind, ''{"n": 9}'')
    WHERE seq = :base + 2', ARRAY['3 link'],
   'a changed row with its digest made again is found at the next row'),
  ('DELETE FROM public.log_entry WHERE seq = :base + 3', ARRAY['4 gap', '4 link'],
   'a row deleted in the middle is found at the next row'),
  ('DELETE FROM public.log_entry WHERE seq >= :base + 6', ARRAY['7 head'],
   'rows deleted at the end are found at the head'),
  ('UPDATE public.log_entry SET seq = seq + 1000 WHERE seq > :base + 2;
    UPDATE public.log_entry SET seq = seq - 999 WHERE seq > :base + 1000;
    INSERT INTO public.log_entry (id, at, seq, prev_hash, hash, kind, payload) OVERRIDING SYSTEM VALUE
    SELECT 0, ''2026-11-16T05:00:00Z'', :base + 3, decode(repeat(''77'', 32), ''hex''),
           public.log_entry_digest(decode(repeat(''77'', 32), ''hex''), :base + 3, 0, ''2026-11-16T05:00:00Z'', ''authn.logout'', ''{}''),
           ''authn.logout'', ''{}''',
   ARRAY['3 link', '4 hash', '4 link', '5 hash', '6 hash', '7 hash', '7 head', '8 hash'],
   'a row inserted in the middle is found: its link, and every row moved one place on'),
  ('UPDATE public.log_entry SET seq = seq + 1000 WHERE seq = :base + 2;
    UPDATE public.log_entry SET seq = :base + 2 WHERE seq = :base + 3;
    UPDATE public.log_entry SET seq = :base + 3 WHERE seq = :base + 1002',
   ARRAY['2 hash', '2 link', '3 hash', '3 link', '4 link'],
   'two rows swapped are found'),
  ('UPDATE public.log_chain_head SET seq = seq - 1', ARRAY['6 head'],
   'a head set back is found'),
  ('UPDATE public.log_chain_head SET hash = decode(repeat(''00'', 32), ''hex'')', ARRAY['7 head'],
   'a head with another digest is found'),
  ('DELETE FROM public.log_chain_head', ARRAY['- head'],
   'a missing head is found'),
  ('DELETE FROM public.log_entry; UPDATE public.log_chain_head SET seq = 0, hash = decode(repeat(''00'', 32), ''hex'')', '{}'::text[],
   'control: an empty table with the first head verifies'),
  ('UPDATE public.log_entry SET id = DEFAULT WHERE seq = :base + 2', ARRAY['2 hash'],
   'a changed id is found at its row'),
  ('SELECT 1', '{}'::text[],
   'control: the chain left as it is verifies'),
  -- DAN-868-1: the chain cut at the base. :cut2 moves the base to the row at
  -- place 2 and deletes every row up to it; :cut7 does so up to the last row.
  (':cut2', '{}'::text[], 'a chain cut exactly at the base verifies from it'),
  (':cut7', '{}'::text[], 'a chain cut after its last row verifies: the head is the base'),
  (':cut2; SET LOCAL TimeZone = ''Pacific/Kiritimati''; SET LOCAL DateStyle = ''SQL, DMY''', '{}'::text[],
   'a cut chain verifies under another time zone and date style'),
  (':cut7; ALTER TABLE public.log_entry ENABLE ALWAYS TRIGGER log_entry_chain;
    SET LOCAL ROLE ductus_logs_writer; INSERT INTO public.log_entry (kind, payload) VALUES (''authn.logout'', ''{}''); RESET ROLE',
   '{}'::text[], 'an append after a cut of every row chains on the base and verifies'),
  (':cut2; UPDATE public.log_chain_base SET hash = decode(repeat(''ee'', 32), ''hex'')', ARRAY['3 link'],
   'a cut whose base holds another digest is found at the first row left'),
  (':cut2; UPDATE public.log_chain_base SET seq = seq - 1', ARRAY['3 gap'],
   'a cut whose base holds another place is found at the first row left'),
  (':cut2; DELETE FROM public.log_entry WHERE seq = :base + 3', ARRAY['4 gap', '4 link'],
   'a row deleted past the base is found at the next row'),
  (':cut7; UPDATE public.log_chain_base SET seq = seq + 1', ARRAY['7 head'],
   'with no row left, a base past the head is found at the head'),
  (':cut7; UPDATE public.log_chain_base SET seq = 9223372036854775807', ARRAY['7 head'],
   'a base at the greatest bigint does not fail the verification of an empty chain')
) t (sql, expected, what);
SELECT is(pg_temp.tampered('UPDATE public.log_chain_base SET (seq, hash) = (SELECT seq, hash FROM public.log_entry WHERE seq = :base + 2)'),
  ARRAY[(1 - pg_temp.at(0))::text || ' gap', (1 - pg_temp.at(0))::text || ' link'],
  'a base moved on while its rows stay is found at the first row');
SELECT is(pg_temp.tampered('UPDATE public.log_chain_base SET seq = 9223372036854775807'),
  ARRAY[(1 - pg_temp.at(0))::text || ' gap'],
  'a base at the greatest bigint is found at the first row, the verification does not fail');
SELECT is(pg_temp.tampered('ALTER TABLE public.log_chain_base DROP CONSTRAINT log_chain_base_pkey,
      ALTER seq DROP NOT NULL, ALTER hash DROP NOT NULL;
    INSERT INTO public.log_chain_base (seq, hash) SELECT seq, hash FROM public.log_entry WHERE seq = :base + 2;
    INSERT INTO public.log_chain_base (seq, hash) VALUES (NULL, NULL)'),
  ARRAY['- base', (1 - pg_temp.at(0))::text || ' gap', (1 - pg_temp.at(0))::text || ' link'],
  'a base of three rows is found, the chain is verified from the one with the greatest seq, and nothing fails');
SELECT is(pg_temp.tampered(':cut2; DELETE FROM public.log_chain_base'),
  ARRAY['- base', (pg_temp.at(3) - pg_temp.at(0))::text || ' gap', '3 link'],
  'a missing base is found, and the cut chain is then verified from seq 0');
SELECT is(pg_temp.tampered('DELETE FROM public.log_entry WHERE seq = 1'),
  ARRAY[(2 - pg_temp.at(0))::text || ' gap', (2 - pg_temp.at(0))::text || ' link'],
  'the first row of the chain deleted is found at the second');
SELECT is(pg_temp.tampered('UPDATE public.log_entry SET prev_hash = decode(repeat(''01'', 32), ''hex''),
    hash = public.log_entry_digest(decode(repeat(''01'', 32), ''hex''), seq, id, at, kind, payload) WHERE seq = 1'),
  ARRAY[(1 - pg_temp.at(0))::text || ' link', (2 - pg_temp.at(0))::text || ' link'],
  'a first row that does not follow 32 zero bytes is found, and so is its successor');
SELECT is(pg_temp.try_as(NULL, $$
  CREATE FUNCTION pg_temp.step() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN UPDATE public.log_chain_head SET seq = seq + 1, hash = decode(repeat('ab', 32), 'hex'); RETURN NULL; END $f$;
  CREATE TEMP TABLE step (x int);
  CREATE TRIGGER step AFTER INSERT ON pg_temp.step FOR EACH ROW EXECUTE FUNCTION pg_temp.step();
  INSERT INTO pg_temp.step VALUES (1);
  DO $d$ BEGIN
    IF (SELECT count(*) FROM public.log_chain_verify() v WHERE v.problem = 'head') <> 1 THEN
      RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
    END IF;
    RAISE EXCEPTION 'found' USING ERRCODE = 'P0001';
  END $d$ $$),
  'P0001', 'a head the superuser moves one step from a trigger of its own, without a row, is found (boundary of #125)');

-- 6. Negative controls: a right of the main application role is caught.
CREATE ROLE ductus_app NOLOGIN;
GRANT SELECT ON public.log_chain_head TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.chain_drift', ARRAY['+ductus_app: SELECT log_chain_head'],
  'a right of the main application role on the head is caught');
REVOKE SELECT ON public.log_chain_head FROM ductus_app;
GRANT UPDATE (seq) ON public.log_chain_base TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.chain_drift', ARRAY['+ductus_app: UPDATE log_chain_base'],
  'a column right of the main application role on the base is caught (DAN-868-1)');
REVOKE UPDATE (seq) ON public.log_chain_base FROM ductus_app;
GRANT EXECUTE ON FUNCTION public.log_chain_verify() TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.chain_drift', ARRAY['+ductus_app: EXECUTE log_chain_verify'],
  'EXECUTE of the verification for the main application role is caught');
REVOKE EXECUTE ON FUNCTION public.log_chain_verify() FROM ductus_app;
GRANT ductus_logs_reader TO ductus_app;
SELECT isnt_empty($$ SELECT found FROM pg_temp.chain_drift WHERE found = '+ductus_app: EXECUTE log_chain_verify via ductus_logs_reader' $$,
  'a right reached through membership of a logs role is caught');
REVOKE ductus_logs_reader FROM ductus_app;
DROP ROLE ductus_app;
GRANT EXECUTE ON FUNCTION public.log_entry_chain() TO ductus_logs_writer;
SELECT set_eq('SELECT found FROM pg_temp.chain_drift', ARRAY['+ductus_logs_writer: EXECUTE log_entry_chain'],
  'EXECUTE of the insert trigger for the writer is caught');
REVOKE EXECUTE ON FUNCTION public.log_entry_chain() FROM ductus_logs_writer;
SELECT is(pg_temp.tampered('ALTER TABLE public.log_entry ALTER COLUMN payload SET DEFAULT ''{}'''), '{}'::text[],
  'control: a change that touches no row leaves the chain verified, so the cases above found the change, not the tampering');

SELECT * FROM finish();
ROLLBACK;
