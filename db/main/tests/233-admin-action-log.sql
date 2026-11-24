-- SRV-ADMIN-1 (NF-7 OA-3; owner decision 23. 11. 2026., item 4): the log of
-- the actions of administrators and operators (20261215100100_admin_action_log.sql).
-- Only a confirmed administrator of the institution reads it, only for that
-- institution; a row says when, in which role, what kind of action, about
-- which role and the outcome, never who, whom, which work or which case.
-- The actions are made through their own RPCs (the operator steps as the
-- test's superuser, as the operator procedure). All people are invented
-- (fixtures/institution.inc); Dora is appointed registry clerk here.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- 1. Catalogue.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.admin_action_log()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the log');
SELECT is_empty(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
       AND rolname NOT IN ('ductus_identity', 'ductus_evidence') UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.legal_hold_trail()', 'EXECUTE') $$,
  'the trail of legal holds is private to the two owners');
SELECT is(pg_get_function_result('app.admin_action_log()'::regprocedure),
  'TABLE(occurred_at timestamp with time zone, actor_role text, action text, subject_role text, outcome text,'
  ' course_id uuid, enrolled_count integer, already_enrolled_count integer, skipped_count integer)',
  'a row has a time, a role, an action, the role it concerns, the outcome and the counts of an import (240-); nothing names a person');
SELECT is(pg_get_function_result('app.legal_hold_trail()'::regprocedure),
  'TABLE(occurred_at timestamp with time zone, action text, by_operator boolean)',
  'the trail of holds carries no subject, case or reason');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'after the migration no owner keeps CREATE on app');

-- 2. Who reads it.
SELECT is(pg_temp.ask(a.name, 'SELECT count(*)::text FROM app.admin_action_log()'), 'ZD403: forbidden',
  a.name || ' does not read the log')
FROM (VALUES ('vesna'), ('marko'), ('ana'), ('dora'), ('boris'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask(t.name, 'SELECT count(*)::text FROM app.admin_action_log()'), 'ZD401: not authenticated',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- The fixture's administrators were appointed by the operator; its confirmed
-- teacher role leaves its event.
CREATE FUNCTION pg_temp.log(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT coalesce(string_agg(actor_role || ' ' || action || coalesce(' ' || subject_role, '')
                                                         || ' ' || outcome, ' | ' ORDER BY action, actor_role, subject_role), '')
                                 FROM app.admin_action_log() $q$)
$$;
SELECT is(pg_temp.log('iva'),
  'institution_admin role_confirmed teacher completed | operator role_confirmed institution_admin completed',
  'Iva reads her own appointment by the operator and the fixture''s confirmation');
SELECT is(pg_temp.log('lea'),
  'institution_admin role_confirmed teacher completed | operator role_confirmed institution_admin completed',
  'Lea reads only her institution''s');

-- 3. The actions, each through its own path, at distinct times.
-- Inside one test transaction now() is one instant, so the rows are compared
-- as a set; the order of the log is checked on its own below.
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Iva appoints Boris network engineer');
SELECT is(pg_temp.ask('iva', 'SELECT institution.revoke_teacher_role({marko})::text'), 'true', 'Iva revokes Marko''s teacher role');
SELECT is(pg_temp.ask('iva', $$ SELECT institution.publish_faculty_rule_version('essay', 0, 'prohibited', '{}', 'basic', false)::text $$),
  '1', 'Iva publishes a faculty rule');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('pasted_unknown', 15, 'soft')::text $$), 'true',
  'Iva sets a threshold');
INSERT INTO ref VALUES ('h1', pg_temp.ask('iva', $$ SELECT app.place_legal_hold('assignment', {z1}::text, 'Izmišljeni slučaj 1/2026') $$));
SELECT matches((SELECT val FROM ref WHERE name = 'h1'), '^[0-9a-f-]{36}$', 'Iva places a legal hold');
SELECT ok(evidence.operator_release_legal_hold(pg_temp.id('h1'), 'Izmišljeni zahtjev 2/2026', 'Izmišljeni razlog.') IS NOT NULL,
  'the operator releases it on a request');
SELECT ok(app.appoint_registry_clerk(pg_temp.id('dora'), 'Izmišljeni zahtjev 3/2026') IS NOT NULL,
  'the operator appoints Dora registry clerk');
INSERT INTO ref VALUES ('e1', pg_temp.ask('dora',
  $$ SELECT app.request_student_data_export({ana}, true, 'Izmišljena provjera 4/2026')::text $$));
SELECT matches((SELECT val FROM ref WHERE name = 'e1'), '^[0-9a-f-]{36}$', 'Dora requests the export of Ana''s data');
SELECT is(pg_temp.ask('iva', $$ SELECT (app.approve_student_data_export({e1}, 'izmisljeni-posao-5') IS NOT NULL)::text $$), 'true',
  'Iva approves it');

SELECT is(pg_temp.log('iva'),
  'institution_admin export_approved completed'
  ' | registry_clerk export_requested completed'
  ' | institution_admin hold_placed completed'
  ' | operator hold_released completed'
  ' | institution_admin role_confirmed network_engineer completed'
  ' | institution_admin role_confirmed teacher completed'
  ' | operator role_confirmed institution_admin completed'
  ' | operator role_confirmed registry_clerk completed'
  ' | institution_admin role_revoked teacher completed'
  ' | institution_admin rule_published completed'
  ' | institution_admin threshold_changed completed',
  'every action is one row with its role and outcome');
-- The order: an earlier event (written by the owner with its own time) comes last.
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', format($$ WITH i AS (INSERT INTO audit.teacher_role_event
    (institution_id, role_id, teacher_id, role, kind, actor_id, occurred_at)
    SELECT r.institution_id, r.id, r.user_id, 'teacher', 'confirmed', %L, now() - interval '1 day'
      FROM institution.institution_role r WHERE r.user_id = %L AND r.role = 'teacher' RETURNING 1) SELECT count(*) FROM i $$,
    pg_temp.id('iva'), pg_temp.id('vesna'))), '1', 'an older confirmation of Vesna''s role is recorded');
SELECT is(pg_temp.ask('iva', $$ SELECT string_agg(action, ',') FROM (SELECT action, row_number() OVER () AS n
                                  FROM app.admin_action_log()) l WHERE l.n = (SELECT count(*) FROM app.admin_action_log()) $$),
  'role_confirmed', 'the log comes newest first: the day-old row is the last');
SELECT is(pg_temp.log('lea'),
  'institution_admin role_confirmed teacher completed | operator role_confirmed institution_admin completed',
  'nothing of fak-a reaches the administrator of fak-b');

-- No value of the log is an identifier, a reference or a text of the actions.
SELECT is(pg_temp.ask('iva', $$ SELECT count(*)::text FROM app.admin_action_log() l, ref r
                                 WHERE r.val IN (l.actor_role, l.action, coalesce(l.subject_role, ''), l.outcome) $$),
  '0', 'no row carries an id of a person, course, hold or export');
SELECT is(pg_temp.ask('iva', $$ SELECT count(*)::text FROM app.admin_action_log() l
                                 WHERE concat_ws(' ', l.actor_role, l.action, l.subject_role, l.outcome) ~* '(izmi|zahtjev|slu.aj|provjera)' $$),
  '0', 'no row carries a case, request, check or reason text');

-- 4. A demoted administrator no longer reads it; the log keeps every row.
INSERT INTO ref SELECT 'events', count(*)::text FROM audit.teacher_role_event;
SELECT ok(institution.revoke_institution_admin(pg_temp.id('iva'), 'Izmišljeni zahtjev 6/2026') IS NOT NULL,
  'the operator revokes Iva''s administrator role');
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM app.admin_action_log()'), 'ZD403: forbidden',
  'Iva no longer reads the log');
SELECT ok((SELECT count(*) FROM audit.teacher_role_event) >= (SELECT val::bigint FROM ref WHERE name = 'events'),
  'the sources keep every row they had');

SELECT * FROM finish();
ROLLBACK;
