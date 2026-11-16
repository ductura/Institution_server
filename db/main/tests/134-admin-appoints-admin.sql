-- DAN-810 (S-1J-c2; contract on Ductus#1836, comment 6907140478; attack plan
-- ductura/server#110): the rule assign_admin_network_engineer_roles x
-- institution_admin = own_institution of server/roles/permissions.ts, for
-- administrators (D-297 (2)). Only a confirmed administrator of the caller's
-- own institution appoints another; every other account kind is refused, and
-- so is a target of another institution, one that does not exist or the
-- caller, with the same code. Each appointment writes one append-only row of
-- audit.institution_admin_event in the same statement; a call that changes
-- nothing writes nothing. The operator procedure (106) is untouched. Every
-- person below is invented (fixtures/institution.inc); the fixture appoints
-- Iva (fak_a) and Lea (fak_b) through the operator procedure.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- The commit-time checks run at the end of each statement here.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE FUNCTION pg_temp.as_owner(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_identity', 'anon', p_sql) $$;
CREATE FUNCTION pg_temp.events() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM audit.institution_admin_event WHERE institution_id IN (pg_temp.id('fak_a'), pg_temp.id('fak_b'))
$$;
-- The administrator rows of a person as "confirmed? revoked?", the one in force first.
CREATE FUNCTION pg_temp.admin_rows(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg((confirmed_at IS NOT NULL)::text || ' ' || (revoked_at IS NOT NULL)::text, ', '
                             ORDER BY revoked_at NULLS FIRST, id), '')
    FROM institution.institution_role WHERE user_id = pg_temp.id(p_name) AND role = 'admin'
$$;
-- The active administrator row of a person.
CREATE FUNCTION pg_temp.office(p_name text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM institution.institution_role
   WHERE user_id = pg_temp.id(p_name) AND role = 'admin' AND revoked_at IS NULL
$$;
-- The trail of a person's administrator rows as "kind actor admin institution same-xmin same-time".
CREATE FUNCTION pg_temp.event(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(x.line, ', ' ORDER BY x.line) FROM (
    SELECT e.kind || ' ' || a.name || ' ' || t.name || ' ' || f.name || ' '
           || (e.xmin = r.xmin)::text || ' ' || (e.occurred_at = r.confirmed_at)::text AS line
      FROM audit.institution_admin_event e
      JOIN institution.institution_role r ON r.id = e.role_id
      JOIN person a ON a.id = e.actor_id
      JOIN person t ON t.id = e.admin_id
      JOIN ref f ON f.val = e.institution_id::text
     WHERE e.admin_id = pg_temp.id(p_name)) AS x
$$;

-- 1. Catalogue: owner, forced RLS, the only policy, the columns, the keys.
SELECT has_table('audit', 'institution_admin_event', 'appointments by an administrator have their own trail');
SELECT row_eq(
  $$ SELECT relowner::regrole::text, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'audit.institution_admin_event'::regclass $$,
  ROW('ductus_identity'::text, true, true), 'the identity role owns the table and RLS is enabled and forced');
SELECT bag_eq(
  $$ SELECT polname::text, polcmd::text, polroles::regrole[]::text FROM pg_policy WHERE polrelid = 'audit.institution_admin_event'::regclass $$,
  $$ VALUES ('institution_admin_event_owner', '*', '{ductus_identity}') $$, 'the only policy is the owner''s');
SELECT columns_are('audit', 'institution_admin_event', ARRAY[
  'id', 'institution_id', 'role_id', 'admin_id', 'role', 'kind', 'actor_id', 'occurred_at'
], 'the table has exactly the listed columns: no session, no address, no reason');
SELECT col_is_unique('audit', 'institution_admin_event', ARRAY['role_id', 'kind'], 'one row per role row and kind');
SELECT fk_ok('audit', 'institution_admin_event', ARRAY['role_id', 'institution_id', 'admin_id', 'role'],
  'institution', 'institution_role', ARRAY['id', 'institution_id', 'user_id', 'role'],
  'the row names its role row with institution, person and role');
SELECT fk_ok('audit', 'institution_admin_event', ARRAY['actor_id', 'institution_id'],
  'identity', 'user_account', ARRAY['id', 'institution_id'], 'the administrator is an account of the same institution');
SELECT bag_eq(
  $$ SELECT tgname::text || ' ' || tgfoid::regprocedure::text FROM pg_trigger
      WHERE tgrelid = 'audit.institution_admin_event'::regclass AND NOT tgisinternal AND tgenabled = 'O' $$,
  ARRAY['institution_admin_event_append_only audit.reject_change()', 'institution_admin_event_no_truncate audit.reject_change()',
        'institution_admin_event_actor institution.check_admin_event_actor()'],
  'the table has its two append-only triggers and the check of the appointing administrator');
-- The operator's trail is as 106 left it: the owner writes teacher rows only.
SELECT is(
  (SELECT with_check FROM pg_policies WHERE schemaname = 'audit' AND tablename = 'teacher_role_event'),
  '(role = ''teacher''::text)', 'the operator''s trail still admits no administrator row from the owner');

-- 2. The access matrix of the table: nobody but the owner, PUBLIC and login
-- roles included, holds any right on it, not even on a column.
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || p.privilege
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND rolname <> 'ductus_identity'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE has_table_privilege(r.rolname, 'audit.institution_admin_event', p.privilege)
        OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            AND has_any_column_privilege(r.rolname, 'audit.institution_admin_event', p.privilege)) $$,
  'no role but the owner has any right on the table');
SELECT is(pg_temp.ask('iva', v.sql), '42501: permission denied for schema audit', 'the web role, even as an administrator: ' || v.op)
FROM (VALUES
  (1, 'SELECT', 'SELECT count(*) FROM audit.institution_admin_event'),
  (2, 'INSERT', $$ INSERT INTO audit.institution_admin_event (institution_id, role_id, admin_id, role, kind, actor_id, occurred_at)
                   VALUES ({fak_a}, {nobody}, {marko}, 'admin', 'appointed', {iva}, now()) RETURNING 'written' $$),
  (3, 'UPDATE', $$ UPDATE audit.institution_admin_event SET actor_id = {iva} RETURNING 'changed' $$),
  (4, 'DELETE', $$ DELETE FROM audit.institution_admin_event RETURNING 'deleted' $$),
  (5, 'TRUNCATE', 'TRUNCATE audit.institution_admin_event')
) AS v (n, op, sql)
ORDER BY v.n;

-- 3. Who may call the function: the web role and the owner, nobody else; the
-- trigger function nobody.
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || f.fn
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper
             AND NOT pg_has_role(rolname, 'ductus_app', 'MEMBER') UNION ALL SELECT 'ductus_app' UNION ALL SELECT 'public') AS r
     CROSS JOIN (VALUES ('institution.admin_appoint_admin(uuid)'), ('institution.check_admin_event_actor()')) AS f (fn)
     WHERE has_function_privilege(r.rolname, f.fn::regprocedure, 'EXECUTE') $$,
  ARRAY['ductus_app institution.admin_appoint_admin(uuid)', 'ductus_identity institution.admin_appoint_admin(uuid)',
        'ductus_identity institution.check_admin_event_actor()'],
  'only the web role and the owner may call the function (a login of the web role inherits it)');
SELECT bag_eq(
  $$ SELECT p.oid::regprocedure::text || ' ' || p.prosecdef || ' ' || p.proowner::regrole::text || ' ' || array_to_string(p.proconfig, ',')
     FROM pg_proc p WHERE p.oid IN ('institution.admin_appoint_admin(uuid)'::regprocedure,
                                    'institution.check_admin_event_actor()'::regprocedure,
                                    'institution.check_admin_appointment()'::regprocedure) $$,
  ARRAY['institution.admin_appoint_admin(uuid) true ductus_identity search_path=""',
        'institution.check_admin_event_actor() true ductus_identity search_path=""',
        'institution.check_admin_appointment() true ductus_identity search_path=""'],
  'all three are SECURITY DEFINER of the identity role with an empty search_path');
SELECT is(pg_temp.ask_as('ductus_auth', 'iva', 'SELECT institution.admin_appoint_admin({marko})::text'),
  '42501: permission denied for schema institution', 'the login role cannot appoint');
SELECT is(left(pg_temp.ask_as('ductus_worker', 'iva', 'SELECT institution.admin_appoint_admin({marko})::text'), 6),
  '42501:', 'the worker role cannot appoint');
-- The refusal under REPEATABLE READ cannot be reached inside this test's
-- transaction (as 119): the source holds it, before the session is read.
SELECT ok(
  (SELECT p.prosrc LIKE '%read committed required%' AND p.prosrc LIKE '%25000%'
          AND strpos(p.prosrc, 'read committed required') < strpos(p.prosrc, 'require_actor')
          AND strpos(p.prosrc, 'pg_advisory_xact_lock') < strpos(p.prosrc, 'FOR SHARE')
     FROM pg_proc p WHERE p.oid = 'institution.admin_appoint_admin(uuid)'::regprocedure),
  'the function refuses a level above read committed with 25000 and reads the caller''s office only under the lock');

-- 4. Account kind x action: refused calls write nothing. Dora holds a pending
-- administrator row nobody confirmed; Boris is a network engineer (DAN-809).
SELECT is(pg_temp.as_owner($$ INSERT INTO institution.institution_role (institution_id, user_id, role)
  VALUES ({fak_a}, {dora}, 'admin') RETURNING 'written' $$), 'written', 'Dora has a pending administrator row');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Boris is a network engineer');
SELECT is(pg_temp.ask(v.actor, format('SELECT institution.admin_appoint_admin(%s)::text', v.target)), v.answer, v.why)
FROM (VALUES
  (1, 'anon', '{marko}', 'ZD401: not authenticated', 'no session'),
  (2, 'closed', '{marko}', 'ZD401: not authenticated', 'a closed session'),
  (3, 'expired', '{marko}', 'ZD401: not authenticated', 'an expired session'),
  (4, 'ana', '{marko}', 'ZD403: forbidden', 'a student'),
  (5, 'ana', '{ana}', 'ZD403: forbidden', 'a student, herself'),
  (6, 'vesna', '{marko}', 'ZD403: forbidden', 'a teacher'),
  (7, 'nina', '{nina}', 'ZD403: forbidden', 'a teacher nobody confirmed'),
  (8, 'boris', '{marko}', 'ZD403: forbidden', 'a network engineer'),
  (9, 'dora', '{marko}', 'ZD403: forbidden', 'a pending administrator'),
  (10, 'dora', '{dora}', 'ZD403: forbidden', 'a pending administrator, herself'),
  (11, 'lea', '{marko}', 'ZD403: forbidden', 'the administrator of another institution'),
  -- The target: another institution, nobody, the caller, no value. All the same answer.
  (12, 'iva', '{tomo}', 'ZD403: forbidden', 'a person of another institution'),
  (13, 'iva', '{lea}', 'ZD403: forbidden', 'the administrator of another institution as target'),
  (14, 'iva', '{nobody}', 'ZD403: forbidden', 'a person who does not exist'),
  (15, 'iva', '{iva}', 'ZD403: forbidden', 'the caller herself'),
  (16, 'iva', 'NULL', 'ZD403: forbidden', 'no person')
) AS v (n, actor, target, answer, why)
ORDER BY v.n;
SELECT is(pg_temp.events(), 0::bigint, 'the refused calls wrote no event');
SELECT is(pg_temp.admin_rows('marko') || '|' || pg_temp.admin_rows('tomo') || '|' || pg_temp.admin_rows('dora'),
  '|' || '|false false', 'and changed no role row');

-- 5. Appointment by the administrator of the own institution.
SELECT is(pg_temp.ask('iva', 'SELECT institution.admin_appoint_admin({marko})::text'), 'true', 'Iva appoints Marko');
SELECT is(pg_temp.admin_rows('marko'), 'true false', 'Marko is an administrator in office');
SELECT is(
  (SELECT institution_id::text || ' ' || (confirmed_by = pg_temp.id('iva')) || ' ' || (confirmed_at = now())
     FROM institution.institution_role WHERE id = pg_temp.office('marko')),
  pg_temp.id('fak_a')::text || ' true true', 'in Iva''s institution, confirmed by Iva at the database time');
SELECT is(pg_temp.event('marko'), 'appointed iva marko fak_a true true',
  'the appointment has its row: kind, who, whom, institution, same statement, same time');
SELECT is(pg_temp.ask('iva', 'SELECT institution.admin_appoint_admin({marko})::text'), 'false', 'appointing Marko again changes nothing');
SELECT is(pg_temp.events(), 1::bigint, 'and wrote nothing');
-- The appointed administrator acts as one.
SELECT is(pg_temp.ask('marko', 'SELECT identity.appoint_network_engineer({vesna})::text'), 'true',
  'Marko, now an administrator, appoints a network engineer');
SELECT is(pg_temp.ask('marko', 'SELECT institution.admin_appoint_admin({iva})::text'), 'false',
  'and finds Iva already in office');
-- A pending row is confirmed in place.
SELECT is(pg_temp.ask('marko', 'SELECT institution.admin_appoint_admin({dora})::text'), 'true', 'Marko appoints Dora');
SELECT is(pg_temp.admin_rows('dora'), 'true false', 'her pending row is now in office, no second row');
SELECT is(pg_temp.event('dora'), 'appointed marko dora fak_a true true', 'with Marko in the row');
-- Lea in her own institution; a student may be appointed (the kind is its own row).
SELECT is(pg_temp.ask('lea', 'SELECT institution.admin_appoint_admin({tomo})::text'), 'true', 'Lea appoints Tomo in fak_b');
SELECT is(pg_temp.event('tomo'), 'appointed lea tomo fak_b true true', 'with fak_b and Lea in the row');
SELECT is(pg_temp.events(), 3::bigint, 'three rows on three appointments');

-- 6. The operator still revokes, the last administrator included; an
-- administrator appointed again gets a new role row with its own row.
SELECT ok(institution.revoke_institution_admin(pg_temp.id('marko'), 'Zahtjev marko-opoziv/2026'), 'the operator revokes Marko');
SELECT is(pg_temp.ask('marko', 'SELECT institution.admin_appoint_admin({nina})::text'), 'ZD403: forbidden',
  'a revoked administrator cannot appoint');
SELECT is(pg_temp.ask('iva', 'SELECT institution.admin_appoint_admin({marko})::text'), 'true', 'Iva appoints Marko anew');
SELECT is(pg_temp.admin_rows('marko'), 'true false, true true', 'on a new role row; the revoked one stays revoked');
SELECT is(pg_temp.event('marko'), 'appointed iva marko fak_a false true, appointed iva marko fak_a true true',
  'each role row has its own appointed row');
SELECT ok(institution.revoke_institution_admin(pg_temp.id('lea'), 'Zahtjev lea-opoziv/2026'), 'the operator revokes Lea');
SELECT ok(institution.revoke_institution_admin(pg_temp.id('tomo'), 'Zahtjev tomo-opoziv/2026'),
  'and Tomo, the last administrator of fak_b, whom Lea appointed');
SELECT is(pg_temp.ask('tomo', 'SELECT institution.admin_appoint_admin({petra})::text'), 'ZD403: forbidden',
  'fak_b has no administrator left to appoint one');

-- 7. A pending row that was confirmed once before (made pending by a direct
-- write) is closed and the person appointed on a new row, as by the operator.
INSERT INTO ref VALUES ('dora_office', pg_temp.office('dora')::text);
SELECT is(pg_temp.as_owner($$ UPDATE institution.institution_role SET confirmed_at = NULL, confirmed_by = NULL
  WHERE id = {dora_office} RETURNING 'written' $$), 'written', 'the owner makes Dora''s row pending again');
SELECT is(pg_temp.ask('iva', 'SELECT institution.admin_appoint_admin({dora})::text'), 'true', 'Iva appoints Dora again');
SELECT is(pg_temp.admin_rows('dora'), 'true false, false true', 'on a new row; the old one is closed');
SELECT isnt(pg_temp.office('dora'), pg_temp.id('dora_office'), 'the row in office is not the old one');

-- 8. No administrator in office without its row of the same statement: a
-- direct write, by the owner too, is refused at commit; and the trail row
-- cannot carry anybody but an administrator in office.
SELECT is(pg_temp.as_owner($$ INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
  VALUES ({fak_a}, {ana}, 'admin', {iva}, now()) RETURNING 'written' $$),
  'ZD409: administrator not appointed by the operator', 'an administrator written without a row is refused');
SELECT is(pg_temp.as_owner(format($$
  WITH appointed AS (
    INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
    VALUES ({fak_a}, {ana}, 'admin', %s, now()) RETURNING id, institution_id, user_id, role)
  INSERT INTO audit.institution_admin_event (institution_id, role_id, admin_id, role, kind, actor_id, occurred_at)
  SELECT institution_id, id, user_id, role, 'appointed', %s, now() FROM appointed
  RETURNING 'written' $$, v.actor, v.actor)), v.answer, v.why)
FROM (VALUES
  (1, '{vesna}', 'ZD409: appointing administrator not in office', 'a teacher cannot be written as the appointing administrator'),
  (2, '{boris}', 'ZD409: appointing administrator not in office', 'nor a network engineer'),
  (3, '{nina}', 'ZD409: appointing administrator not in office', 'nor a pending teacher'),
  (4, '{lea}', 'ZD409: appointing administrator not in office', 'nor a revoked administrator of another institution'),
  (5, '{ana}', 'ZD409: appointing administrator not in office', 'nor the person appointed')
) AS v (n, actor, answer, why)
ORDER BY v.n;
SELECT is(pg_temp.admin_rows('ana'), '', 'Ana has no administrator row');
-- A trail row written apart from its role row does not admit it.
SELECT is(pg_temp.as_owner($$ INSERT INTO institution.institution_role (institution_id, user_id, role)
  VALUES ({fak_a}, {ana}, 'admin') RETURNING 'written' $$), 'written', 'a pending row for Ana');
SELECT is(pg_temp.as_owner($$ INSERT INTO audit.institution_admin_event (institution_id, role_id, admin_id, role, kind, actor_id, occurred_at)
  SELECT institution_id, id, user_id, role, 'appointed', {iva}, now() FROM institution.institution_role
   WHERE user_id = {ana} AND role = 'admin' RETURNING 'written' $$), 'written', 'a row for it, in another statement');
SELECT is(pg_temp.as_owner($$ UPDATE institution.institution_role SET confirmed_at = now(), confirmed_by = {iva}
  WHERE user_id = {ana} AND role = 'admin' RETURNING 'written' $$),
  'ZD409: administrator not appointed by the operator', 'does not let the row be confirmed later');
-- Nor does a row restored after the operator's revocation.
SELECT is(pg_temp.as_owner($$ UPDATE institution.institution_role SET revoked_at = NULL
  WHERE user_id = {lea} AND role = 'admin' RETURNING 'written' $$),
  'ZD409: administrator not appointed by the operator', 'a revoked administrator cannot be restored');
SELECT is(pg_temp.as_owner($$ UPDATE institution.institution_role SET revoked_at = NULL
  WHERE user_id = {tomo} AND role = 'admin' RETURNING 'written' $$),
  'ZD409: administrator not appointed by the operator', 'nor one an administrator had appointed (Lea appointed Tomo)');

-- 9. Append-only, for the owner too; the keys hold.
SELECT is(pg_temp.as_owner(v.sql), 'ZD403: append-only row', v.why)
FROM (VALUES
  (1, $$ UPDATE audit.institution_admin_event SET actor_id = {iva} RETURNING 'changed' $$, 'the owner cannot rewrite who acted'),
  (2, $$ DELETE FROM audit.institution_admin_event RETURNING 'deleted' $$, 'the owner cannot delete a row'),
  (3, 'TRUNCATE audit.institution_admin_event', 'the owner cannot empty the table')
) AS v (n, sql, why)
ORDER BY v.n;
INSERT INTO ref VALUES ('marko_office', pg_temp.office('marko')::text),
  ('lea_row', (SELECT id::text FROM institution.institution_role WHERE user_id = pg_temp.id('lea') AND role = 'admin')),
  ('vesna_teacher', (SELECT id::text FROM institution.institution_role WHERE user_id = pg_temp.id('vesna') AND role = 'teacher'));
SELECT is(left(pg_temp.as_owner(format($$ INSERT INTO audit.institution_admin_event (institution_id, role_id, admin_id, role, kind, actor_id, occurred_at)
  VALUES (%s, %s, %s, %L, %L, {iva}, now()) RETURNING 'written' $$, v.inst, v.role_id, v.person, v.role, v.kind)), 6), v.code, v.why)
FROM (VALUES
  (1, '{fak_a}', '{marko_office}', '{marko}', 'admin', 'appointed', '23505:', 'a second appointed row for one role row is refused'),
  (2, '{fak_a}', '{marko_office}', '{marko}', 'admin', 'revoked', '23514:', 'a kind outside the list is refused'),
  (3, '{fak_a}', '{vesna_teacher}', '{vesna}', 'teacher', 'appointed', '23514:', 'a teacher role is refused'),
  (4, '{fak_a}', '{vesna_teacher}', '{vesna}', 'admin', 'appointed', '23503:', 'a teacher row named as administrator is refused'),
  (5, '{fak_a}', '{lea_row}', '{marko}', 'admin', 'appointed', '23503:', 'another person and institution for a role row is refused'),
  (6, '{fak_a}', '{nobody}', '{marko}', 'admin', 'appointed', '23503:', 'a role row that does not exist is refused')
) AS v (n, inst, role_id, person, role, kind, code, why)
ORDER BY v.n;

-- 10. No appointment without its row: when the row cannot be written,
-- nothing changes.
CREATE TRIGGER institution_admin_event_refuse_insert BEFORE INSERT ON audit.institution_admin_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
SELECT is(pg_temp.ask('iva', 'SELECT institution.admin_appoint_admin({boris})::text'), 'ZD403: append-only row',
  'an appointment whose row cannot be written fails');
DROP TRIGGER institution_admin_event_refuse_insert ON audit.institution_admin_event;
SELECT is(pg_temp.admin_rows('boris'), '', 'so Boris is not an administrator');

SELECT * FROM finish();
ROLLBACK;
