-- DAN-809 (S-1J-c; contract on Ductus#1836, comment 6906300892): the rule
-- assign_admin_network_engineer_roles x institution_admin = own_institution
-- of server/roles/permissions.ts, for network engineers. Only a confirmed
-- administrator of the caller's own institution appoints or revokes one; every
-- other account kind is refused, and so is a target of another institution,
-- one that does not exist or the caller, with the same code. Each change
-- writes one append-only row of audit.network_engineer_event in the same
-- statement; a call that changes nothing writes nothing. Every person below is
-- invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

CREATE FUNCTION pg_temp.as_owner(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_identity', 'anon', p_sql) $$;
-- Counts stay inside the fixture's two institutions.
CREATE FUNCTION pg_temp.ours(p_institution uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT p_institution IN (pg_temp.id('fak_a'), pg_temp.id('fak_b')) $$;
CREATE FUNCTION pg_temp.events() RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT count(*) FROM audit.network_engineer_event WHERE pg_temp.ours(institution_id) $$;
CREATE FUNCTION pg_temp.appointments() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT count(*) || ' ' || count(*) FILTER (WHERE revoked_at IS NULL)
    FROM identity.network_engineer_appointment WHERE pg_temp.ours(institution_id)
$$;
-- The appointment rows of a person, the one in force first.
CREATE FUNCTION pg_temp.appointment(p_name text, p_nth integer DEFAULT 1) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM identity.network_engineer_appointment
   WHERE user_id = pg_temp.id(p_name)
   ORDER BY revoked_at NULLS FIRST, id OFFSET p_nth - 1 LIMIT 1
$$;
-- The events of one appointment as "kind actor engineer institution", by kind.
CREATE FUNCTION pg_temp.event(p_appointment uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(e.kind || ' ' || a.name || ' ' || t.name || ' ' || f.name, ', ' ORDER BY e.kind)
    FROM audit.network_engineer_event e
    JOIN person a ON a.id = e.actor_id
    JOIN person t ON t.id = e.engineer_id
    JOIN ref f ON f.val = e.institution_id::text
   WHERE e.appointment_id = p_appointment
$$;

-- 1. Catalogue: owner, forced RLS, the only policy, the columns, the keys.
SELECT has_table('audit', 'network_engineer_event', 'appointments and revocations have their own table');
SELECT row_eq(
  $$ SELECT relowner::regrole::text, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'audit.network_engineer_event'::regclass $$,
  ROW('ductus_identity'::text, true, true), 'the identity role owns the table and RLS is enabled and forced');
SELECT bag_eq(
  $$ SELECT polname::text, polcmd::text, polroles::regrole[]::text FROM pg_policy WHERE polrelid = 'audit.network_engineer_event'::regclass $$,
  $$ VALUES ('network_engineer_event_owner', '*', '{ductus_identity}') $$, 'the only policy is the owner''s');
SELECT columns_are('audit', 'network_engineer_event', ARRAY[
  'id', 'institution_id', 'appointment_id', 'engineer_id', 'kind', 'actor_id', 'occurred_at'
], 'the table has exactly the listed columns: no session, no address, no reason');
SELECT col_is_unique('audit', 'network_engineer_event', ARRAY['appointment_id', 'kind'], 'one row per appointment and kind');
SELECT fk_ok('audit', 'network_engineer_event', ARRAY['appointment_id', 'institution_id', 'engineer_id'],
  'identity', 'network_engineer_appointment', ARRAY['id', 'institution_id', 'user_id'],
  'the event row names its appointment with institution and engineer');
SELECT fk_ok('audit', 'network_engineer_event', ARRAY['actor_id', 'institution_id'],
  'identity', 'user_account', ARRAY['id', 'institution_id'],
  'the administrator is an account of the same institution');
SELECT bag_eq(
  $$ SELECT tgname::text FROM pg_trigger WHERE tgrelid = 'audit.network_engineer_event'::regclass AND NOT tgisinternal
       AND tgenabled = 'O' AND tgfoid = 'audit.reject_change()'::regprocedure $$,
  ARRAY['network_engineer_event_append_only', 'network_engineer_event_no_truncate'],
  'the table has its two enabled append-only triggers');

-- 2. The access matrix of the table: nobody but the owner, PUBLIC and login
-- roles included, holds any right on it, not even on a column.
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || p.privilege
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND rolname <> 'ductus_identity'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE has_table_privilege(r.rolname, 'audit.network_engineer_event', p.privilege)
        OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            AND has_any_column_privilege(r.rolname, 'audit.network_engineer_event', p.privilege)) $$,
  'no role but the owner has any right on the table');
SELECT is(pg_temp.ask('iva', v.sql), '42501: permission denied for schema audit', 'the web role, even as an administrator: ' || v.op)
FROM (VALUES
  (1, 'SELECT', 'SELECT count(*) FROM audit.network_engineer_event'),
  (2, 'INSERT', $$ INSERT INTO audit.network_engineer_event (institution_id, appointment_id, engineer_id, kind, actor_id, occurred_at)
                   VALUES ({fak_a}, {nobody}, {boris}, 'appointed', {iva}, now()) RETURNING 'written' $$),
  (3, 'UPDATE', $$ UPDATE audit.network_engineer_event SET kind = 'revoked' RETURNING 'changed' $$),
  (4, 'DELETE', $$ DELETE FROM audit.network_engineer_event RETURNING 'deleted' $$),
  (5, 'TRUNCATE', 'TRUNCATE audit.network_engineer_event')
) AS v (n, op, sql)
ORDER BY v.n;
-- The appointment table stays out of the web role's reach (130), so the
-- functions below are its only way in.
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM identity.network_engineer_appointment'),
  '42501: permission denied for table network_engineer_appointment', 'the web role still cannot read the appointments');

-- 3. Who may call the functions: the web role and the owner, nobody else.
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || f.fn
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper
             AND NOT pg_has_role(rolname, 'ductus_app', 'MEMBER') UNION ALL SELECT 'ductus_app' UNION ALL SELECT 'public') AS r
     CROSS JOIN (VALUES ('identity.appoint_network_engineer(uuid)'), ('identity.revoke_network_engineer(uuid)')) AS f (fn)
     WHERE has_function_privilege(r.rolname, f.fn::regprocedure, 'EXECUTE') $$,
  ARRAY['ductus_app identity.appoint_network_engineer(uuid)', 'ductus_app identity.revoke_network_engineer(uuid)',
        'ductus_identity identity.appoint_network_engineer(uuid)', 'ductus_identity identity.revoke_network_engineer(uuid)'],
  'only the web role and the owner may call the two functions (a login of the web role inherits it)');
SELECT bag_eq(
  $$ SELECT p.oid::regprocedure::text || ' ' || p.prosecdef || ' ' || p.proowner::regrole::text || ' ' || array_to_string(p.proconfig, ',')
     FROM pg_proc p WHERE p.oid IN ('identity.appoint_network_engineer(uuid)'::regprocedure, 'identity.revoke_network_engineer(uuid)'::regprocedure) $$,
  ARRAY['identity.appoint_network_engineer(uuid) true ductus_identity search_path=""',
        'identity.revoke_network_engineer(uuid) true ductus_identity search_path=""'],
  'both are SECURITY DEFINER of the identity role with an empty search_path');
SELECT is(pg_temp.ask_as('ductus_auth', 'iva', 'SELECT identity.appoint_network_engineer({boris})::text'),
  '42501: permission denied for function appoint_network_engineer', 'the login role cannot appoint');
SELECT is(left(pg_temp.ask_as('ductus_worker', 'iva', 'SELECT identity.revoke_network_engineer({boris})::text'), 6),
  '42501:', 'the worker role cannot revoke');

-- 4. Account kind x action: refused calls write nothing. Students (Ana,
-- Boris), teachers (Vesna), a teacher nobody confirmed (Nina), an
-- administrator of another institution (Lea), no session, a closed session.
SELECT is(pg_temp.ask(v.actor, format('SELECT identity.%s::text', v.call)), v.answer, v.actor || ': ' || v.call)
FROM (VALUES
  (1, 'anon', 'appoint_network_engineer({boris})', 'ZD401: not authenticated'),
  (2, 'closed', 'appoint_network_engineer({boris})', 'ZD401: not authenticated'),
  (3, 'expired', 'revoke_network_engineer({boris})', 'ZD401: not authenticated'),
  (4, 'ana', 'appoint_network_engineer({boris})', 'ZD403: forbidden'),
  (5, 'boris', 'appoint_network_engineer({boris})', 'ZD403: forbidden'),
  (6, 'vesna', 'appoint_network_engineer({boris})', 'ZD403: forbidden'),
  (7, 'nina', 'appoint_network_engineer({boris})', 'ZD403: forbidden'),
  (8, 'lea', 'appoint_network_engineer({boris})', 'ZD403: forbidden'),
  (9, 'ana', 'revoke_network_engineer({boris})', 'ZD403: forbidden'),
  (10, 'vesna', 'revoke_network_engineer({boris})', 'ZD403: forbidden'),
  -- The target: another institution, nobody, the caller, no value. All the same answer.
  (11, 'iva', 'appoint_network_engineer({tomo})', 'ZD403: forbidden'),
  (12, 'iva', 'appoint_network_engineer({lea})', 'ZD403: forbidden'),
  (13, 'iva', 'appoint_network_engineer({nobody})', 'ZD403: forbidden'),
  (14, 'iva', 'appoint_network_engineer({iva})', 'ZD403: forbidden'),
  (15, 'iva', 'appoint_network_engineer(NULL)', 'ZD403: forbidden'),
  -- Nothing to revoke.
  (16, 'iva', 'revoke_network_engineer({boris})', 'false'),
  (17, 'iva', 'revoke_network_engineer({nobody})', 'false'),
  (18, 'iva', 'revoke_network_engineer(NULL)', 'false')
) AS v (n, actor, call, answer)
ORDER BY v.n;
SELECT is(pg_temp.events(), 0::bigint, 'the refused and empty calls wrote no event');
SELECT is(pg_temp.appointments(), '0 0', 'and appointed nobody');

-- 5. Appointment by the administrator of the own institution.
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Iva appoints Boris');
INSERT INTO ref VALUES ('boris_appointment', pg_temp.appointment('boris')::text);
SELECT is(
  (SELECT institution_id::text || ' ' || (appointed_by = pg_temp.id('iva')) || ' ' || (revoked_at IS NULL)
     FROM identity.network_engineer_appointment WHERE id = pg_temp.id('boris_appointment')),
  pg_temp.id('fak_a')::text || ' true true', 'in Iva''s institution, by Iva, in force');
SELECT is(pg_temp.event(pg_temp.id('boris_appointment')), 'appointed iva boris fak_a',
  'the appointment has its row: kind, who, whom, institution');
SELECT is(
  (SELECT a.appointed_at = e.occurred_at AND e.occurred_at = now()
     FROM identity.network_engineer_appointment a JOIN audit.network_engineer_event e ON e.appointment_id = a.id
    WHERE a.id = pg_temp.id('boris_appointment')),
  true, 'at the database time of the appointment');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'false', 'appointing Boris again changes nothing');
SELECT is(pg_temp.events(), 1::bigint, 'and wrote nothing');
SELECT is(pg_temp.appointments(), '1 1', 'one appointment in force');
-- A network engineer is not an administrator.
SELECT is(pg_temp.ask('boris', 'SELECT identity.appoint_network_engineer({dora})::text'), 'ZD403: forbidden',
  'the engineer cannot appoint another');
SELECT is(pg_temp.ask('boris', 'SELECT identity.revoke_network_engineer({boris})::text'), 'ZD403: forbidden',
  'nor revoke');
-- An administrator of another institution neither sees nor ends it.
SELECT is(pg_temp.ask('lea', 'SELECT identity.revoke_network_engineer({boris})::text'), 'false',
  'Lea finds nothing to revoke in another institution');
SELECT is(pg_temp.appointments(), '1 1', 'and Boris stays appointed');
-- A teacher or a student may be appointed: the kind is its own row.
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({vesna})::text'), 'true', 'Iva appoints Vesna, a teacher');
INSERT INTO ref VALUES ('vesna_appointment', pg_temp.appointment('vesna')::text);
SELECT is(pg_temp.ask('lea', 'SELECT identity.appoint_network_engineer({tomo})::text'), 'true', 'Lea appoints Tomo in her own institution');
SELECT is(pg_temp.event(pg_temp.appointment('tomo')), 'appointed lea tomo fak_b', 'with fak_b and Lea in the row');
SELECT is(pg_temp.events(), 3::bigint, 'three rows on three appointments');

-- 6. Revocation: one 'revoked' row on the appointment it ends.
SELECT is(pg_temp.ask('iva', 'SELECT identity.revoke_network_engineer({boris})::text'), 'true', 'Iva revokes Boris');
SELECT is(pg_temp.event(pg_temp.id('boris_appointment')), 'appointed iva boris fak_a, revoked iva boris fak_a',
  'the appointment has its revoked row');
SELECT is(
  (SELECT a.revoked_at = e.occurred_at FROM identity.network_engineer_appointment a
     JOIN audit.network_engineer_event e ON e.appointment_id = a.id AND e.kind = 'revoked'
    WHERE a.id = pg_temp.id('boris_appointment')),
  true, 'at the time the appointment was revoked');
SELECT is(pg_temp.ask('iva', 'SELECT identity.revoke_network_engineer({boris})::text'), 'false', 'revoking it again finds nothing');
SELECT is(pg_temp.events(), 4::bigint, 'and wrote nothing');
-- Appointed anew: a new appointment with its own row; the old keeps its two.
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Iva appoints Boris anew');
SELECT isnt(pg_temp.appointment('boris'), pg_temp.id('boris_appointment'), 'as a new appointment');
SELECT is(pg_temp.event(pg_temp.appointment('boris')), 'appointed iva boris fak_a', 'the new appointment has its own row');
SELECT is(pg_temp.appointments(), '4 3', 'four appointments, three in force');
SELECT is(
  (SELECT count(*) FROM identity.network_engineer_appointment a
    WHERE pg_temp.ours(a.institution_id)
      AND (NOT EXISTS (SELECT 1 FROM audit.network_engineer_event e WHERE e.appointment_id = a.id AND e.kind = 'appointed')
           OR (a.revoked_at IS NOT NULL) <> EXISTS (SELECT 1 FROM audit.network_engineer_event e WHERE e.appointment_id = a.id AND e.kind = 'revoked'))),
  0::bigint, 'every appointment has its appointed row, and a revoked row exactly when revoked');

-- 7. No change without its row: when the row cannot be written, nothing changes.
CREATE TRIGGER network_engineer_event_refuse_insert BEFORE INSERT ON audit.network_engineer_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({dora})::text'), 'ZD403: append-only row',
  'an appointment whose row cannot be written fails');
SELECT is(pg_temp.ask('iva', 'SELECT identity.revoke_network_engineer({vesna})::text'), 'ZD403: append-only row',
  'a revocation whose row cannot be written fails');
DROP TRIGGER network_engineer_event_refuse_insert ON audit.network_engineer_event;
SELECT is(pg_temp.appointments(), '4 3', 'so Dora is not appointed and Vesna stays appointed');
SELECT is(pg_temp.events(), 5::bigint, 'and no row was written');

-- 8. Append-only, for the owner too; the keys hold.
SELECT is(pg_temp.as_owner(v.sql), 'ZD403: append-only row', v.why)
FROM (VALUES
  (1, $$ UPDATE audit.network_engineer_event SET kind = 'revoked' RETURNING 'changed' $$, 'the owner cannot change a row'),
  (2, $$ UPDATE audit.network_engineer_event SET actor_id = {marko} RETURNING 'changed' $$, 'the owner cannot rewrite who acted'),
  (3, $$ DELETE FROM audit.network_engineer_event RETURNING 'deleted' $$, 'the owner cannot delete a row'),
  (4, 'TRUNCATE audit.network_engineer_event', 'the owner cannot empty the table')
) AS v (n, sql, why)
ORDER BY v.n;
SELECT is(left(pg_temp.as_owner(format($$ INSERT INTO audit.network_engineer_event (institution_id, appointment_id, engineer_id, kind, actor_id, occurred_at)
  VALUES (%s, %s, %s, %L, %s, now()) RETURNING 'written' $$, v.inst, v.appointment, v.engineer, v.kind, v.actor)), 6), v.code, v.why)
FROM (VALUES
  (1, '{fak_a}', '{boris_appointment}', '{boris}', 'revoked', '{iva}', '23505:', 'a second row of one kind for one appointment is refused'),
  (2, '{fak_a}', '{boris_appointment}', '{boris}', 'removed', '{iva}', '23514:', 'a kind outside the list is refused'),
  -- Vesna's appointment is in force and has no revoked row yet, so these
  -- reach the foreign keys rather than the unique key.
  (3, '{fak_a}', '{vesna_appointment}', '{dora}', 'revoked', '{iva}', '23503:', 'another person for Vesna''s appointment is refused'),
  (4, '{fak_b}', '{vesna_appointment}', '{vesna}', 'revoked', '{lea}', '23503:', 'another institution for Vesna''s appointment is refused'),
  (5, '{fak_a}', '{nobody}', '{boris}', 'appointed', '{iva}', '23503:', 'an appointment that does not exist is refused'),
  (6, '{fak_a}', '{vesna_appointment}', '{vesna}', 'revoked', '{lea}', '23503:', 'an actor of another institution is refused')
) AS v (n, inst, appointment, engineer, kind, actor, code, why)
ORDER BY v.n;

-- 9. A revoked administrator is refused like any other kind.
SELECT ok(institution.revoke_institution_admin(pg_temp.id('iva'), 'Zahtjev iva-opoziv/2026'), 'the operator revokes Iva as administrator');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({dora})::text'), 'ZD403: forbidden',
  'a revoked administrator cannot appoint');
SELECT is(pg_temp.ask('iva', 'SELECT identity.revoke_network_engineer({boris})::text'), 'ZD403: forbidden',
  'nor revoke');
SELECT is(pg_temp.appointments(), '4 3', 'and nothing changed');

SELECT * FROM finish();
ROLLBACK;
