-- DAN-827 (S-1D-a; contract on Ductus#1836, c.6914672657): every session is
-- active, in progress, interrupted or ended, derived by
-- identity.session_state from the existing columns of identity.session. The
-- earliest of closed_at, expires_at and last_seen_at + 2 hours decides; idle
-- expiry and a change of institution give "interrupted" with a reason. Only
-- the review roles read it: an administrator or an appointed network engineer
-- of the session's own institution. "in_progress" is defined (state.ts) but
-- never derived: no column records a login that has not issued a session.
-- Every person below is invented (fixtures/institution.inc); now() is fixed
-- for the transaction.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- One fixture session of p_person, times relative to now(); its id goes into
-- ref under p_name, so {p_name} works in pg_temp.ask.
CREATE FUNCTION pg_temp.add(p_name text, p_person text, p_seen interval, p_expires interval,
                            p_closed interval DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO identity.session (token_hash, user_id, institution_id, created_at, expires_at, last_seen_at,
                                closed_at, close_reason)
  SELECT sha256(convert_to(rpad(p_name, 43, '_'), 'UTF8')), p.id, p.institution_id,
         now() - interval '13 hours', now() + p_expires, now() - p_seen,
         now() - p_closed, p_reason
    FROM person p WHERE p.name = p_person;
  INSERT INTO ref SELECT p_name, s.id::text FROM identity.session s
   WHERE s.token_hash = sha256(convert_to(rpad(p_name, 43, '_'), 'UTF8'));
$$;
-- The state of a session as p_actor sees it: "state reason", "-" for no
-- reason, NULL for no row, or the error.
CREATE FUNCTION pg_temp.state(p_actor text, p_session text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor,
    'SELECT state || '' '' || coalesce(reason, ''-'') FROM identity.session_state({' || p_session || '})')
$$;

-- Live sessions are spread over people, so the five-session limit closes none.
SELECT pg_temp.add('s_active', 'nina', '1 minute', '11 hours');
SELECT pg_temp.add('s_almost_idle', 'marko', '1 hour 59 minutes 59 seconds', '11 hours');
SELECT pg_temp.add('s_idle', 'nina', '2 hours', '11 hours');
SELECT pg_temp.add('s_expired', 'nina', '1 minute', '-1 second');
SELECT pg_temp.add('s_expires_now', 'nina', '1 minute', '0');
SELECT pg_temp.add('s_logout', 'dora', '5 minutes', '11 hours', '1 minute', 'logout');
SELECT pg_temp.add('s_logout_all', 'dora', '5 minutes', '11 hours', '1 minute', 'logout_all');
SELECT pg_temp.add('s_backchannel', 'dora', '5 minutes', '11 hours', '1 minute', 'backchannel_logout');
SELECT pg_temp.add('s_institution', 'vesna', '5 minutes', '11 hours', '1 minute', 'institution_changed');
SELECT pg_temp.add('s_issuer', 'vesna', '5 minutes', '11 hours', '1 minute', 'issuer_removed');
SELECT pg_temp.add('s_operator', 'vesna', '5 minutes', '11 hours', '1 minute', 'operator');
SELECT pg_temp.add('s_superseded', 'marko', '5 minutes', '11 hours', '1 minute', 'superseded');
-- Which came first: a logout after idleness is still idleness, and so on.
SELECT pg_temp.add('s_logout_after_idle', 'ana', '3 hours', '11 hours', '30 minutes', 'logout');
SELECT pg_temp.add('s_expired_before_idle', 'ana', '2 hours', '-30 minutes');
SELECT pg_temp.add('s_idle_before_expiry', 'ana', '3 hours', '-30 minutes');
SELECT pg_temp.add('s_close_at_expiry', 'ana', '5 minutes', '-1 minute', '1 minute', 'operator');
SELECT pg_temp.add('s_close_at_idle', 'ana', '2 hours 1 minute', '11 hours', '1 minute', 'institution_changed');
SELECT pg_temp.add('s_b_active', 'tomo', '1 minute', '11 hours');

-- 1. The function from the catalogue: definer, owner, empty search_path.
SELECT is(
  (SELECT p.prosecdef::text || ' ' || p.proowner::regrole::text || ' ' || p.provolatile::text || ' '
          || array_to_string(p.proconfig, ',')
     FROM pg_proc p WHERE p.oid = 'identity.session_state(uuid)'::regprocedure),
  'true ductus_identity s search_path=""', 'session_state is a stable definer of the identity role with an empty search_path');
SELECT is(
  (SELECT pg_get_function_result('identity.session_state(uuid)'::regprocedure)),
  'TABLE(state text, reason text)', 'it returns a state and a reason');

-- 2. EXECUTE: of the group roles, the web role and the owner only; PUBLIC none.
-- Login roles of the local stack join a group and are left out here.
SELECT bag_eq(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND NOT rolcanlogin
                            UNION ALL SELECT 'public') AS r
      WHERE has_function_privilege(r.rolname, 'identity.session_state(uuid)', 'EXECUTE') $$,
  ARRAY['ductus_app', 'ductus_identity'], 'only the web role and the owner may call session_state');
SELECT is(pg_temp.ask_as('ductus_auth', 'iva', 'SELECT state FROM identity.session_state({s_active})'),
  '42501: permission denied for function session_state', 'the login role cannot call it');
SELECT is(pg_temp.ask_as('ductus_worker', 'iva', 'SELECT state FROM identity.session_state({s_active})'),
  '42501: permission denied for schema identity', 'the worker does not even reach the schema');
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM identity.session'),
  '42501: permission denied for table session', 'the web role still cannot read the sessions themselves');

-- 3. Each state and reason from the existing columns, read by Iva (admin, fak-a).
SELECT is(pg_temp.state('iva', 's_active'), 'active -', 'a session within both limits is active');
SELECT is(pg_temp.state('iva', 's_almost_idle'), 'active -', 'one second before the idle limit it is still active');
SELECT is(pg_temp.state('iva', 's_idle'), 'interrupted idle', 'at exactly two hours without activity it is interrupted as idle');
SELECT is(pg_temp.state('iva', 's_expired'), 'ended expired', 'past its expiry it has ended');
SELECT is(pg_temp.state('iva', 's_expires_now'), 'ended expired', 'at its expiry it has ended');
SELECT is(pg_temp.state('iva', 's_logout'), 'ended logout', 'a logout ends it');
SELECT is(pg_temp.state('iva', 's_logout_all'), 'ended logout_all', 'a logout of all sessions ends it');
SELECT is(pg_temp.state('iva', 's_backchannel'), 'ended backchannel_logout', 'a logout at the provider ends it');
SELECT is(pg_temp.state('iva', 's_institution'), 'interrupted institution_changed', 'a change of institution interrupts it');
SELECT is(pg_temp.state('iva', 's_issuer'), 'interrupted issuer_removed', 'a removed issuer interrupts it');
SELECT is(pg_temp.state('iva', 's_operator'), 'interrupted operator', 'the operator interrupts it');
SELECT is(pg_temp.state('iva', 's_superseded'), 'interrupted superseded', 'a sixth session interrupts it');
SELECT is(pg_temp.state('iva', 's_logout_after_idle'), 'interrupted idle', 'a logout after the idle limit does not hide the idleness');
SELECT is(pg_temp.state('iva', 's_expired_before_idle'), 'ended expired', 'expiry before the idle limit ends it');
SELECT is(pg_temp.state('iva', 's_idle_before_expiry'), 'interrupted idle', 'idleness before expiry interrupts it');
SELECT is(pg_temp.state('iva', 's_close_at_expiry'), 'interrupted operator', 'a close at the same moment as expiry wins');
SELECT is(pg_temp.state('iva', 's_close_at_idle'), 'interrupted institution_changed', 'a close at the same moment as idleness wins');

-- 4. in_progress is never derived from a row, and every row has a known state.
SELECT is(
  pg_temp.ask('iva', $q$
    SELECT string_agg(DISTINCT d.state || ' ' || coalesce(d.reason, '-'), ',' ORDER BY d.state || ' ' || coalesce(d.reason, '-'))
      FROM (VALUES ({s_active}), ({s_idle}), ({s_expired}), ({s_logout}), ({s_logout_all}), ({s_backchannel}),
                   ({s_institution}), ({s_issuer}), ({s_operator}), ({s_superseded})) AS v (id)
      CROSS JOIN LATERAL identity.session_state(v.id::uuid) d $q$),
  'active -,ended backchannel_logout,ended expired,ended logout,ended logout_all,interrupted idle,'
  || 'interrupted institution_changed,interrupted issuer_removed,interrupted operator,interrupted superseded',
  'the rows give only the closed lists, never in_progress');
-- A close reason the function does not map would fail here first: the CHECK
-- on identity.session holds exactly the seven reasons mapped above.
SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'identity.session'::regclass AND conname = 'session_close_reason_check'),
  'CHECK ((close_reason = ANY (ARRAY[''logout''::text, ''backchannel_logout''::text, ''logout_all''::text, '
  || '''institution_changed''::text, ''issuer_removed''::text, ''operator''::text, ''superseded''::text])))',
  'the close reasons are the seven the function maps');

-- 5. Who reads: no session, a student, teachers → refused; other institution
-- or an unknown id → no row, the same as a session that does not exist.
SELECT is(pg_temp.state('anon', 's_active'), 'ZD401: not authenticated', 'without a session: refused');
SELECT is(pg_temp.state('unknown', 's_active'), 'ZD401: not authenticated', 'with an unknown token: refused');
SELECT is(pg_temp.state('closed', 's_active'), 'ZD401: not authenticated', 'with a closed session: refused');
SELECT is(pg_temp.state('expired', 's_active'), 'ZD401: not authenticated', 'with an expired session: refused');
SELECT is(pg_temp.state('ana', 's_active'), 'ZD403: not allowed', 'a student cannot read a session state');
SELECT is(pg_temp.state('ana', 'ana'), 'ZD403: not allowed', 'not even of her own session');
SELECT is(pg_temp.state('vesna', 's_active'), 'ZD403: not allowed', 'a teacher cannot read it');
SELECT is(pg_temp.state('nina', 's_active'), 'ZD403: not allowed', 'nor a person with an unconfirmed teacher role');
SELECT is(pg_temp.state('iva', 's_b_active'), NULL, 'an administrator gets no row of another institution');
SELECT is(pg_temp.state('iva', 'nobody'), NULL, 'nor of an id that is no session');
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM identity.session_state(NULL)'), '0', 'nor of no id');
SELECT is(pg_temp.state('lea', 's_b_active'), 'active -', 'the administrator of fak-b reads her own institution');
SELECT is(pg_temp.state('lea', 's_active'), NULL, 'and gets no row of fak-a');

-- 6. A network engineer reads while appointed, and not after the revocation.
SELECT is(pg_temp.state('boris', 's_active'), 'ZD403: not allowed', 'before the appointment Boris cannot read it');
SELECT isnt(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), NULL, 'Iva appoints Boris');
SELECT is(pg_temp.state('boris', 's_idle'), 'interrupted idle', 'the appointed engineer reads a state of his institution');
SELECT is(pg_temp.state('boris', 's_b_active'), NULL, 'and no row of another institution');
SELECT isnt(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({dora})::text'), NULL, 'Iva appoints Dora');
SELECT isnt(pg_temp.ask('iva', 'SELECT identity.revoke_network_engineer({dora})::text'), NULL, 'and revokes her');
SELECT is(pg_temp.state('dora', 's_active'), 'ZD403: not allowed', 'a revoked engineer cannot read it');

-- 7. Reading changes nothing.
SELECT is(
  (SELECT count(*) FROM identity.session s JOIN ref r ON r.val = s.id::text WHERE r.name LIKE 's\_%'
    AND s.last_seen_at > now() - interval '1 minute'),
  0::bigint, 'no read touched a fixture session');

SELECT * FROM finish();
ROLLBACK;
