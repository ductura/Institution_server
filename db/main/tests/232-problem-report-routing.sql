-- SRV-ADMIN-1 (NF-7 OA-7; owner decision 23. 11. 2026., item 8): the problem
-- reports reach the people who answer them, by kind
-- (20261215100000_problem_report_routing.sql). A technical report reaches a
-- network engineer of the institution, an account report and a course report
-- without a course the administrator, a course report with a course the team
-- of that course; nobody else. The reader never learns who sent a report.
-- The state trail is append-only. All people and texts are invented
-- (fixtures/institution.inc); Boris is appointed network engineer here.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- 1. Catalogue.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND (SELECT count(*) FROM pg_policies p
          WHERE p.schemaname = 'identity' AND p.tablename = 'problem_report_status_event') = 1,
  'the state trail has forced RLS, the identity owner and no privilege for another role')
FROM pg_class c WHERE c.oid = 'identity.problem_report_status_event'::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['identity.routed_problem_reports()', 'identity.set_problem_report_status(text,text)',
       'identity.submit_course_problem_report(uuid,text,text,text,text,integer,text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the three RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
             AND rolname <> 'ductus_identity' UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['identity.problem_report_reader()',
       'identity.problem_report_routed_to(text,uuid,uuid,boolean,boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the routing helpers are the owner''s alone');
SELECT ok(pg_get_function_result('identity.routed_problem_reports()'::regprocedure) !~* '(user|reporter|actor_id|name)',
  'the read has no column for the reporter or a person');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'identity', 'CREATE'),
  'after the migration the owner keeps no CREATE on the schema');

-- 2. Positions: Boris is a network engineer of fak-a.
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Iva appoints Boris');

-- 3. Reports. Ana: technical, account and one about K1; Dora: a course report
-- naming no course; Vesna: one about her K1; Tomo (fak-b): technical.
CREATE FUNCTION pg_temp.report(p_actor text, p_category text, p_text text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT identity.submit_problem_report(%L, %L, NULL, ''1.0.0'', ''other'', NULL, NULL)', p_category, p_text))
$$;
CREATE FUNCTION pg_temp.course_report(p_actor text, p_course text, p_text text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT identity.submit_course_problem_report(%s, %L, NULL, ''1.0.0'', ''other'', NULL, NULL)', p_course, p_text))
$$;
INSERT INTO ref VALUES
  ('t1', pg_temp.report('ana', 'technical', 'Izmišljeni opis: ne sprema se.')),
  ('a1', pg_temp.report('ana', 'account', 'Izmišljeni opis: ne vidim ulogu.')),
  ('c1', pg_temp.course_report('ana', '{k1}', 'Izmišljeni opis: rok zadatka.')),
  ('c0', pg_temp.report('dora', 'course', 'Izmišljeni opis: koji kolegij?')),
  ('cv', pg_temp.course_report('vesna', '{k1}', 'Izmišljeni opis nastavnice.')),
  ('tb', pg_temp.report('tomo', 'technical', 'Izmišljeni opis druge ustanove.'));
SELECT ok((SELECT bool_and(val ~ '^PR-[0-9A-F]{10}$') FROM ref WHERE name IN ('t1', 'a1', 'c1', 'c0', 'cv', 'tb')),
  'all six reports are accepted');
SELECT is((SELECT course_id FROM identity.problem_report WHERE reference = (SELECT val FROM ref WHERE name = 'c1')),
  pg_temp.id('k1'), 'the course report names its course');

-- A course outside the caller's reach is ZD422, whether it exists or not.
SELECT is(pg_temp.course_report(c.actor, c.course, 'Izmišljeno.'), 'ZD422: invalid input', c.what)
FROM (VALUES
  ('ana', '{k2}', 'a student outside K2 does not report about K2'),
  ('ana', '{k3}', 'nor about a course of another institution'),
  ('ana', '{nobody}', 'nor about a course that does not exist'),
  ('ana', 'NULL', 'nor about no course'),
  ('boris', '{k1}', 'Boris, in no course, does not report about K1'),
  ('marko', '{k1}', 'Marko, a teacher of K2, does not report about K1')
) AS c (actor, course, what);
SELECT is(pg_temp.course_report('anon', '{k1}', 'Izmišljeno.'), 'ZD401: not authenticated', 'no session, no report');
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', format(
    $$ WITH u AS (UPDATE identity.problem_report SET course_id = %L WHERE reference = %L RETURNING 1) SELECT count(*) FROM u $$,
    pg_temp.id('k1'), (SELECT val FROM ref WHERE name = 't1'))),
  '23514: new row for relation "problem_report" violates check constraint "problem_report_course_only_for_course"',
  'only a course report can name a course');

-- 4. Who reads what.
CREATE FUNCTION pg_temp.seen(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT coalesce(string_agg(category || ':' || routed_to || ':' || description, ' | '
                                                         ORDER BY category, description), '')
                                 FROM identity.routed_problem_reports() $q$)
$$;
SELECT is(pg_temp.seen('boris'), 'technical:network_engineer:Izmišljeni opis: ne sprema se.',
  'the network engineer reads only the technical report of his institution');
SELECT is(pg_temp.seen('iva'),
  'account:institution_admin:Izmišljeni opis: ne vidim ulogu. | course:institution_admin:Izmišljeni opis: koji kolegij?',
  'the administrator reads the account report and the course report naming no course');
SELECT is(pg_temp.seen('vesna'),
  'course:course_teacher:Izmišljeni opis nastavnice. | course:course_teacher:Izmišljeni opis: rok zadatka.',
  'the teacher of K1 reads the reports about K1');
SELECT is(pg_temp.seen(a.name), '', a.name || ' is a reader but nothing reaches them')
FROM (VALUES ('marko'), ('lea'), ('petra')) AS a (name);
SELECT is(pg_temp.seen(a.name), 'ZD403: forbidden', a.name || ' reads no reports')
FROM (VALUES ('ana'), ('dora'), ('tomo'), ('nina')) AS a (name);
SELECT is(pg_temp.seen(t.name), 'ZD401: not authenticated', 'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM identity.problem_report'), '0',
  'the table itself still shows the administrator nothing');
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM identity.problem_report_status_event'),
  '42501: permission denied for table problem_report_status_event', 'the web role cannot read the trail directly');

-- A revoked network engineer reads nothing any more.
SELECT is(pg_temp.ask('iva', 'SELECT identity.revoke_network_engineer({boris})::text'), 'true', 'Iva revokes Boris');
SELECT is(pg_temp.seen('boris'), 'ZD403: forbidden', 'Boris no longer reads technical reports');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Iva appoints him again');

-- 5. The state.
CREATE FUNCTION pg_temp.mark(p_actor text, p_report text, p_status text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT (identity.set_problem_report_status(%L, %L) IS NOT NULL)::text',
    (SELECT val FROM ref WHERE name = p_report), p_status))
$$;
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(DISTINCT status || ':' || (status_changed_at IS NULL)::text, ',')
                                   FROM identity.routed_problem_reports() $$),
  'received:true', 'a new report is received and was never changed');
SELECT is(pg_temp.mark('vesna', 'c1', 'resolved'), 'true', 'Vesna marks the report about K1 resolved');
SELECT is(pg_temp.ask('vesna', format($$ SELECT status || ':' || status_changed_by_role || ':' || status_changed_by_me
                                         FROM identity.routed_problem_reports() WHERE reference = %L $$,
                                      (SELECT val FROM ref WHERE name = 'c1'))),
  'resolved:course_teacher:true', 'she reads it resolved, changed by a course teacher, by her');
SELECT is(pg_temp.mark('vesna', 'c1', 'resolved'), 'true', 'the same state again');
SELECT is((SELECT count(*) FROM identity.problem_report_status_event), 1::bigint, 'records nothing');
SELECT is(pg_temp.mark('vesna', 'c1', 'received'), 'true', 'she reopens it');
SELECT is((SELECT string_agg(status || '/' || actor_role, ',' ORDER BY occurred_at, status DESC)
             FROM identity.problem_report_status_event), 'resolved/course_teacher,received/course_teacher',
  'each change is one row of the trail with the role');
SELECT is(pg_temp.mark('iva', 'a1', 'resolved'), 'true', 'Iva resolves the account report');
SELECT is(pg_temp.mark('boris', 't1', 'resolved'), 'true', 'Boris resolves the technical report');
SELECT is(pg_temp.mark(c.actor, c.report, 'resolved'), 'ZD404: not found', c.what)
FROM (VALUES
  ('iva', 'c1', 'the administrator does not change the report about K1'),
  ('iva', 't1', 'nor a technical report'),
  ('boris', 'a1', 'the network engineer does not change an account report'),
  ('marko', 'c1', 'a teacher of K2 does not change a report about K1'),
  ('vesna', 'c0', 'a teacher does not change a course report naming no course'),
  ('lea', 'tb', 'an administrator of fak-b does not change a technical report'),
  ('petra', 'c1', 'nor a teacher of another institution')
) AS c (actor, report, what);
SELECT is(pg_temp.ask('iva', $$ SELECT identity.set_problem_report_status('PR-0000000000', 'resolved')::text $$),
  'ZD404: not found', 'an unknown reference is not found');
SELECT is(pg_temp.mark(c.actor, c.report, 'resolved'), 'ZD403: forbidden', c.actor || ' changes no state')
FROM (VALUES ('ana', 'c1'), ('dora', 'c0'), ('tomo', 'tb'), ('nina', 'c1')) AS c (actor, report);
SELECT is(pg_temp.mark('anon', 'c1', 'resolved'), 'ZD401: not authenticated', 'no session changes no state');
SELECT is(pg_temp.ask('vesna', v.statement), 'ZD422: invalid input', v.what)
FROM (VALUES
  ('a state outside the two', $$ SELECT identity.set_problem_report_status('PR-0000000000', 'closed')::text $$),
  ('a null state', $$ SELECT identity.set_problem_report_status('PR-0000000000', NULL)::text $$),
  ('a malformed reference', $$ SELECT identity.set_problem_report_status('pr-1', 'resolved')::text $$),
  ('a null reference', $$ SELECT identity.set_problem_report_status(NULL, 'resolved')::text $$)
) AS v (what, statement);
SELECT is(pg_temp.ask('iva', format($$ SELECT status || ':' || status_changed_by_role || ':' || status_changed_by_me
                                       FROM identity.routed_problem_reports() WHERE reference = %L $$,
                                    (SELECT val FROM ref WHERE name = 'a1'))),
  'resolved:institution_admin:true', 'the administrator reads her own change');

-- 6. The trail is never changed or removed, not even by the owner.
SELECT is(pg_temp.ask_as('ductus_identity', 'iva',
    $$ WITH u AS (UPDATE identity.problem_report_status_event SET status = 'resolved' RETURNING 1) SELECT count(*) FROM u $$),
  'ZD403: append-only row', 'a row of the trail is not changed');
SELECT is(pg_temp.ask_as('ductus_identity', 'iva',
    $$ WITH d AS (DELETE FROM identity.problem_report_status_event RETURNING 1) SELECT count(*) FROM d $$),
  'ZD403: append-only row', 'nor removed');
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', 'TRUNCATE identity.problem_report_status_event'),
  'ZD403: append-only row', 'nor truncated');

SELECT * FROM finish();
ROLLBACK;
