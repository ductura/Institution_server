-- DAN-798 (S-1J.1-b; contract on Ductus#1836, comment 6903835425): the access
-- matrix of the five account kinds. Each kind of server/roles/account-kinds.ts
-- has one row naming where the main database keeps it; the vitest
-- server/roles/account-kinds-db.test.ts compares these rows with
-- ACCOUNT_KINDS both ways. The two tables of migration 20261116120000 have no
-- write path for any application role, and identity.app_admin is written only
-- by a superuser outside the application (owner action V-7): each of its three
-- layers is shown to refuse on its own. Synthetic fixtures only.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';

SELECT plan(30);

-- The matrix. One row per account kind: the relation and the condition that
-- picks the kind's rows out of it.
CREATE TEMP TABLE kind_matrix (kind text PRIMARY KEY, relation text NOT NULL, condition text NOT NULL);
INSERT INTO kind_matrix VALUES
-- account-kinds:begin
  ('student', 'institution.course_member', $$role = 'student'$$),
  ('teacher', 'institution.institution_role', $$role = 'teacher'$$),
  ('institution_admin', 'institution.institution_role', $$role = 'admin'$$),
  ('app_admin', 'identity.app_admin', 'true'),
  ('network_engineer', 'identity.network_engineer_appointment', 'true')
-- account-kinds:end
;

-- The SQLSTATE of p_sql run as p_role, or 'ok'.
CREATE FUNCTION pg_temp.try_as(p_role text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_result text := 'ok';
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_result := SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_result;
END
$$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END
$$;

-- Every write the tests try, on both new tables.
CREATE TEMP TABLE write_op (tbl text NOT NULL, op text NOT NULL, sql text NOT NULL);
INSERT INTO write_op VALUES
  ('app_admin', 'INSERT', 'INSERT INTO identity.app_admin DEFAULT VALUES'),
  ('app_admin', 'UPDATE', 'UPDATE identity.app_admin SET revoked_at = now()'),
  ('app_admin', 'DELETE', 'DELETE FROM identity.app_admin'),
  ('app_admin', 'TRUNCATE', 'TRUNCATE identity.app_admin'),
  ('network_engineer_appointment', 'INSERT',
   format('INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by) VALUES (%L, %L, %L)',
          pg_temp.id('fak_a'), pg_temp.id('boris'), pg_temp.id('iva'))),
  ('network_engineer_appointment', 'UPDATE', 'UPDATE identity.network_engineer_appointment SET revoked_at = now()'),
  ('network_engineer_appointment', 'DELETE', 'DELETE FROM identity.network_engineer_appointment'),
  ('network_engineer_appointment', 'TRUNCATE', 'TRUNCATE identity.network_engineer_appointment');
GRANT SELECT ON kind_matrix, write_op TO PUBLIC;

-- 1. The matrix and the catalogue.
SELECT bag_eq('SELECT kind FROM kind_matrix',
  ARRAY['student', 'teacher', 'institution_admin', 'app_admin', 'network_engineer'],
  'the matrix has exactly one row for each of the five account kinds');
SELECT is_empty(
  $$ SELECT m.kind FROM kind_matrix m LEFT JOIN pg_class c ON c.oid = to_regclass(m.relation)
     WHERE c.oid IS NULL OR c.relkind <> 'r' OR NOT (c.relrowsecurity AND c.relforcerowsecurity)
        OR c.relowner <> 'ductus_identity'::regrole $$,
  'every kind lives in a table of ductus_identity with ENABLE and FORCE ROW LEVEL SECURITY');
SELECT is_empty(
  $$ SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'identity'::regnamespace AND c.relname IN ('app_admin', 'network_engineer_appointment')
       AND c.relkind <> 'r' $$,
  'both new relations are plain tables');

-- 2. Rights. No role but the owner, nor PUBLIC, holds any right on the new
-- tables, login roles included; the owner holds no write right on app_admin.
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || p.privilege || ' ' || c.relname
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' UNION ALL SELECT 'public') AS r
     CROSS JOIN pg_class c
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE c.oid IN ('identity.app_admin'::regclass, 'identity.network_engineer_appointment'::regclass)
       AND NOT (r.rolname <> 'public' AND (SELECT rolsuper FROM pg_roles WHERE rolname = r.rolname))
       AND (has_table_privilege(r.rolname, c.oid, p.privilege)
            OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                AND has_any_column_privilege(r.rolname, c.oid, p.privilege))) $$,
  ARRAY[
    'ductus_identity SELECT app_admin',
    'ductus_identity REFERENCES app_admin',
    'ductus_identity TRIGGER app_admin',
    'ductus_identity SELECT network_engineer_appointment',
    'ductus_identity INSERT network_engineer_appointment',
    'ductus_identity UPDATE network_engineer_appointment',
    'ductus_identity DELETE network_engineer_appointment',
    'ductus_identity TRUNCATE network_engineer_appointment',
    'ductus_identity REFERENCES network_engineer_appointment',
    'ductus_identity TRIGGER network_engineer_appointment'
  ],
  'only the owner holds a right on the new tables, and on app_admin no write right');
SELECT bag_eq(
  $$ SELECT tablename || ': ' || policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',')
     FROM pg_policies WHERE schemaname = 'identity' AND tablename IN ('app_admin', 'network_engineer_appointment') $$,
  ARRAY[
    'app_admin: app_admin_owner_read SELECT to ductus_identity',
    'network_engineer_appointment: network_engineer_appointment_owner ALL to ductus_identity'
  ],
  'the only policy on app_admin lets its owner read');
SELECT bag_eq(
  $$ SELECT t.tgname::text FROM pg_trigger t WHERE t.tgrelid = 'identity.app_admin'::regclass AND NOT t.tgisinternal
       AND t.tgenabled = 'O' AND t.tgfoid = 'identity.refuse_app_admin_write()'::regprocedure $$,
  ARRAY['app_admin_refuse_row_write', 'app_admin_refuse_truncate'],
  'app_admin has its two enabled refusal triggers');
SELECT is_empty(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper
                            UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'identity.refuse_app_admin_write()'::regprocedure, 'EXECUTE')
       AND r.rolname <> 'ductus_identity' $$,
  'nobody but its owner may call the refusal function');

-- 3. No path around the rights: no function but the refusal names either
-- table, in its source, in an SQL-standard body (BEGIN ATOMIC) or as a
-- dependency, except settings.set_value (DAN-801), which only reads
-- network_engineer_appointment to know a network engineer, and the two
-- functions of DAN-809 that appoint and revoke one (133); no SECURITY
-- DEFINER function runs dynamic SQL, which could name a table without
-- spelling it; and no view, rule or materialised view reads one. Each
-- function and table it names is one row, marked "writes" when the source
-- has a write statement on the table and "reads" otherwise. Each function
-- check has a negative control below.
CREATE VIEW pg_temp.touching_function AS
  SELECT p.oid::regprocedure::text || ' ' || t.name || ' '
         || CASE WHEN s.src ~* ('(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\s+(ONLY\s+)?(TABLE\s+)?[a-z_."]*'
                                || t.name) THEN 'writes' ELSE 'reads' END AS found
  FROM pg_proc p
  CROSS JOIN (VALUES ('app_admin', 'identity.app_admin'::regclass),
                     ('network_engineer_appointment', 'identity.network_engineer_appointment'::regclass)) AS t (name, rel)
  CROSS JOIN LATERAL (SELECT coalesce(p.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(p.oid), '') AS src) AS s
  WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    AND p.pronamespace <> pg_my_temp_schema()
    AND p.oid <> 'identity.refuse_app_admin_write()'::regprocedure
    AND (s.src ~* t.name
         OR EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.refobjid = t.rel));
CREATE VIEW pg_temp.dynamic_definer AS
  SELECT p.oid::regprocedure::text AS found FROM pg_proc p
  WHERE p.prosecdef AND p.pronamespace <> pg_my_temp_schema()
    AND regexp_replace(coalesce(p.prosrc, ''), 'EXECUTE\s+(FUNCTION|PROCEDURE)', '', 'gi') ~* '\mEXECUTE\M';
SELECT bag_eq('SELECT found FROM pg_temp.touching_function',
  ARRAY['settings.set_value(text,uuid,text,jsonb,jsonb) network_engineer_appointment reads',
        'identity.appoint_network_engineer(uuid) network_engineer_appointment writes',
        'identity.revoke_network_engineer(uuid) network_engineer_appointment writes'],
  'only settings.set_value and, since DAN-809 (133), the appointment and revocation name a new table, and none names app_admin');
SELECT is_empty('SELECT found FROM pg_temp.dynamic_definer',
  'no SECURITY DEFINER function runs dynamic SQL');
CREATE FUNCTION identity.test_atomic_write(p_institution uuid, p_user uuid, p_by uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
BEGIN ATOMIC
  INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by) VALUES (p_institution, p_user, p_by);
END;
CREATE FUNCTION identity.test_plain_read() RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $f$ BEGIN RETURN (SELECT count(*) FROM identity.app_admin); END $f$;
CREATE FUNCTION identity.test_plain_write() RETURNS void
LANGUAGE plpgsql SET search_path = ''
AS $f$ BEGIN UPDATE  identity.network_engineer_appointment SET revoked_at = now(); END $f$;
CREATE FUNCTION identity.test_dynamic_write(p_table text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $f$ BEGIN EXECUTE format('DELETE FROM identity.%I', p_table); END $f$;
SELECT bag_eq('SELECT found FROM pg_temp.touching_function',
  ARRAY['settings.set_value(text,uuid,text,jsonb,jsonb) network_engineer_appointment reads',
        'identity.appoint_network_engineer(uuid) network_engineer_appointment writes',
        'identity.revoke_network_engineer(uuid) network_engineer_appointment writes',
        'identity.test_atomic_write(uuid,uuid,uuid) network_engineer_appointment writes',
        'identity.test_plain_read() app_admin reads',
        'identity.test_plain_write() network_engineer_appointment writes'],
  'control: a BEGIN ATOMIC body that writes a new table, a read and a write in plpgsql are found');
SELECT bag_eq('SELECT found FROM pg_temp.dynamic_definer',
  ARRAY['identity.test_dynamic_write(text)'],
  'control: a definer with dynamic SQL is found');
DROP FUNCTION identity.test_atomic_write(uuid, uuid, uuid);
DROP FUNCTION identity.test_dynamic_write(text);
DROP FUNCTION identity.test_plain_read();
DROP FUNCTION identity.test_plain_write();
SELECT is_empty(
  $$ SELECT r.ev_class::regclass::text FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
     WHERE d.classid = 'pg_rewrite'::regclass
       AND d.refobjid IN ('identity.app_admin'::regclass, 'identity.network_engineer_appointment'::regclass)
       AND r.ev_class NOT IN ('identity.app_admin'::regclass, 'identity.network_engineer_appointment'::regclass)
       AND (SELECT c.relnamespace FROM pg_class c WHERE c.oid = r.ev_class) <> pg_my_temp_schema() $$,
  'no view or rule reads the new tables');

-- 4. Every role but the owner is refused every write, by its rights.
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || w.op || ' ' || w.tbl || ': ' || pg_temp.try_as(r.rolname, w.sql)
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolsuper
             AND rolname <> 'ductus_identity') AS r
     CROSS JOIN write_op w
     WHERE pg_temp.try_as(r.rolname, w.sql) <> '42501' $$,
  'every ductus role but the owner, the application role included, is refused every write on both tables');
SELECT is(pg_temp.try_as('ductus_app', 'SELECT count(*) FROM identity.app_admin'), '42501',
  'ductus_app cannot read app_admin');
SELECT is(pg_temp.try_as('ductus_app', 'SELECT count(*) FROM identity.network_engineer_appointment'), '42501',
  'ductus_app cannot read network_engineer_appointment');

-- 5. A superuser outside the application may write app_admin (the positive
-- control; this file rolls back). One row stays for the controls below.
SELECT lives_ok('INSERT INTO identity.app_admin DEFAULT VALUES', 'a superuser may add an application administrator');
SELECT lives_ok('UPDATE identity.app_admin SET revoked_at = created_at', 'a superuser may revoke one');
SELECT throws_ok('UPDATE identity.app_admin SET revoked_at = created_at - interval ''1 second''', '23514', NULL,
  'a revocation before the row was made is refused');
SELECT lives_ok('INSERT INTO identity.app_admin DEFAULT VALUES', 'a second row for the controls');

-- 6. The owner, layer by layer. First with the rights as the migration left
-- them: every write is refused for want of a right.
SELECT is_empty(
  $$ SELECT w.op || ': ' || pg_temp.try_as('ductus_identity', w.sql) FROM write_op w
     WHERE w.tbl = 'app_admin' AND pg_temp.try_as('ductus_identity', w.sql) <> '42501' $$,
  'the owner is refused every write on app_admin by its rights');
-- A SECURITY DEFINER function the owner owns runs with the same rights.
CREATE FUNCTION identity.test_definer_write() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN INSERT INTO identity.app_admin DEFAULT VALUES; END $$;
ALTER FUNCTION identity.test_definer_write() OWNER TO ductus_identity;
SELECT is(pg_temp.try('SELECT identity.test_definer_write()'), '42501',
  'a SECURITY DEFINER function of the owner cannot write app_admin');
DROP FUNCTION identity.test_definer_write();

-- Control: the rights given back and the trigger off, RLS alone still
-- refuses (the BEFORE trigger would otherwise answer first). An INSERT breaks
-- the policy; UPDATE and DELETE see no row.
GRANT INSERT, UPDATE, DELETE ON identity.app_admin TO ductus_identity;
ALTER TABLE identity.app_admin DISABLE TRIGGER app_admin_refuse_row_write;
SELECT is(pg_temp.try_as('ductus_identity', 'INSERT INTO identity.app_admin DEFAULT VALUES'), '42501',
  'with the rights back, RLS refuses the owner an INSERT');
SELECT is(pg_temp.try_as('ductus_identity',
  $$ DO $d$ DECLARE n integer; BEGIN
       UPDATE identity.app_admin SET revoked_at = now(); GET DIAGNOSTICS n = ROW_COUNT;
       IF n > 0 THEN RAISE EXCEPTION 'updated' USING ERRCODE = 'P0099'; END IF;
       DELETE FROM identity.app_admin; GET DIAGNOSTICS n = ROW_COUNT;
       IF n > 0 THEN RAISE EXCEPTION 'deleted' USING ERRCODE = 'P0099'; END IF;
     END $d$ $$), 'ok',
  'with the rights back, RLS lets the owner neither update nor delete a row');
SELECT is((SELECT count(*)::integer FROM identity.app_admin WHERE revoked_at IS NULL), 1,
  'the rows are as the superuser left them');

-- Control: rights and a write policy, the trigger alone still refuses.
ALTER TABLE identity.app_admin ENABLE TRIGGER app_admin_refuse_row_write;
CREATE POLICY test_write ON identity.app_admin TO ductus_identity USING (true) WITH CHECK (true);
GRANT TRUNCATE ON identity.app_admin TO ductus_identity;
SELECT is_empty(
  $$ SELECT w.op || ': ' || pg_temp.try_as('ductus_identity', w.sql) FROM write_op w
     WHERE w.tbl = 'app_admin' AND pg_temp.try_as('ductus_identity', w.sql) <> 'ZD409' $$,
  'with rights and a write policy, the trigger refuses the owner every write');
SELECT is((SELECT count(*)::integer FROM identity.app_admin), 2, 'app_admin still holds the superuser''s two rows');

-- 7. network_engineer_appointment: what its constraints hold (superuser).
SELECT lives_ok(
  format('INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by) VALUES (%L, %L, %L)',
         pg_temp.id('fak_a'), pg_temp.id('boris'), pg_temp.id('iva')),
  'an engineer appointed by someone of the same institution is accepted');
SELECT is(
  pg_temp.try(format('INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by) VALUES (%L, %L, %L)',
                     pg_temp.id('fak_a'), pg_temp.id('boris'), pg_temp.id('iva')))
  || '/' ||
  pg_temp.try(format('INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by) VALUES (%L, %L, %L)',
                     pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('lea')))
  || '/' ||
  pg_temp.try(format('INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by) VALUES (%L, %L, %L)',
                     pg_temp.id('fak_a'), pg_temp.id('tomo'), pg_temp.id('iva')))
  || '/' ||
  pg_temp.try('UPDATE identity.network_engineer_appointment SET revoked_at = appointed_at - interval ''1 second'''),
  '23505/23503/23503/23514',
  'a second active appointment, an appointer or an engineer of another institution, and an early revocation are refused');

-- 8. Every condition picks out its own kind and no other: by now each kind
-- has at least one row (fixture, section 5 or 7), and a kind is counted only
-- in its own table, so a mistyped value or a condition that also matches
-- another kind's rows fails.
CREATE FUNCTION pg_temp.matrix_count(p_relation text, p_condition text) RETURNS bigint
LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %s WHERE %s', p_relation, p_condition) INTO n;
  RETURN n;
END $f$;
SELECT is_empty(
  $$ SELECT kind FROM kind_matrix WHERE pg_temp.matrix_count(relation, condition) = 0 $$,
  'the condition of every kind selects at least one row of that kind');
SELECT is_empty(
  $$ SELECT m.relation FROM kind_matrix m GROUP BY m.relation
     HAVING count(*) > 1 AND sum(pg_temp.matrix_count(m.relation, m.condition))
            <> pg_temp.matrix_count(m.relation, 'true') $$,
  'the kinds that share a table split its rows exactly, so no row is two kinds at once or none');

SELECT * FROM finish();
ROLLBACK;
