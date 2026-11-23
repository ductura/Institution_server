-- PIL-P1-RITAM-PREDMET-SRV (Ductus#2052; Daniel 23. 11. 2026.): the switch of the
-- rhythm of typing per course, which the assignment's switch overrides
-- (20261214120000). The access matrix: only a teacher of the course sets and
-- reads the course's switch; the student, a teacher of another course, an
-- administrator, another institution, an unknown course and no session get
-- ZD403 or ZD401, each on the same course K1 that Vesna changes. The state the
-- student reads carries the level it comes from and who set it, and when. Every
-- change leaves an append-only audit row in the same call. All people are the
-- invented ones of the shared fixtures.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
VALUES (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Izmišljena', 'Nastavnica');

-- 1. Catalogue: the web role executes the new RPCs; the workers stay the owners'.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.input_rhythm_course_switch(uuid,boolean)', 'app.input_rhythm_course_switch_read(uuid)',
       'app.input_rhythm_switch_clear(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs of the course''s switch');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.input_rhythm_course_row(uuid)', 'app.input_rhythm_course_put(uuid,boolean)',
       'app.input_rhythm_assignment_clear(uuid)', 'app.input_rhythm_course_view(uuid)', 'app.input_rhythm_on(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers are not the web role''s');
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns
      WHERE table_schema = 'evidence' AND table_name = 'input_rhythm_course_setting' $$,
  ARRAY['institution_id', 'course_id', 'enabled', 'changed_by', 'changed_at'],
  'the course''s switch holds a state and its bookkeeping only');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE') AND NOT has_schema_privilege('ductus_identity', 'audit', 'CREATE')
    AND NOT has_schema_privilege('ductus_evidence', 'institution', 'USAGE')
    AND NOT has_table_privilege('ductus_evidence', 'institution.course', 'REFERENCES'),
  'after the migration no role keeps CREATE, USAGE or REFERENCES it was lent');

-- 2. On by default; the teacher of K1 reads it.
SELECT is(pg_temp.ask('vesna', format($$ SELECT row(s.*)::text FROM app.input_rhythm_course_switch_read(%L) s $$, pg_temp.id('k1'))),
  '(t,default,,,)', 'the course''s switch is on by default, nobody changed it');

-- 3. Negative controls on K1: nobody but its teacher sets or reads it.
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled FROM app.input_rhythm_course_switch(%L, false) $$, pg_temp.id('k1'))), '^ZD403',
  a.name || ' does not set the switch of K1')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('marko'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled FROM app.input_rhythm_course_switch_read(%L) $$, pg_temp.id('k1'))), '^ZD403',
  a.name || ' does not read the switch of K1')
FROM (VALUES ('ana'), ('marko'), ('iva'), ('petra')) AS a (name);
SELECT matches(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_course_switch(%L, false) $$, pg_temp.id('k2'))), '^ZD403',
  'Vesna does not set the switch of K2');
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled FROM app.input_rhythm_course_switch('00000000-0000-4000-8000-00000000dead', false) $$), '^ZD403',
  'an unknown course: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled FROM app.input_rhythm_course_switch(NULL, false) $$), '^ZD403', 'no course: ZD403');
SELECT matches(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_course_switch(%L, NULL) $$, pg_temp.id('k1'))), '^ZD422',
  'no state: ZD422');
SELECT matches(pg_temp.ask(t.name, format($$ SELECT enabled FROM app.input_rhythm_course_switch(%L, false) $$, pg_temp.id('k1'))), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled FROM app.input_rhythm_switch_clear(%L) $$, pg_temp.id('z1'))), '^ZD403',
  a.name || ' does not clear the switch of z1')
FROM (VALUES ('ana'), ('marko'), ('iva'), ('petra')) AS a (name);
SELECT is((SELECT count(*) FROM evidence.input_rhythm_course_setting), 0::bigint, 'no refused call left a setting');
SELECT is((SELECT count(*) FROM audit.input_rhythm_course_switch_event), 0::bigint, 'and no audit row');

-- 4. Positive control on the same K1: Vesna switches it off; the course holds for z1.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[120, 80]) $$), 'true', 'a burst is recorded while on');
SELECT is(pg_temp.ask('vesna', format($$ SELECT concat_ws('/', enabled::text, source, changed_by_role, changed_by_name) FROM app.input_rhythm_course_switch(%L, false) $$, pg_temp.id('k1'))),
  'false/course/teacher/Izmišljena Nastavnica', 'Vesna switches K1 off and reads who did');
SELECT is((SELECT count(*) FROM audit.input_rhythm_course_switch_event
            WHERE course_id = pg_temp.id('k1') AND NOT enabled AND actor_id = pg_temp.id('vesna')),
  1::bigint, 'the switch wrote one audit row in the same call');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws('/', enabled::text, source, changed_by_role, changed_by_name) FROM app.input_rhythm_state('doc-a') $$),
  'false/course/teacher/Izmišljena Nastavnica', 'Ana reads that it is off, for the course, and who switched it');
SELECT ok(pg_temp.ask('ana', $$ SELECT changed_at FROM app.input_rhythm_state('doc-a') $$) IS NOT NULL, 'and when');
SELECT is(pg_temp.ask('vesna', format($$ SELECT source FROM app.input_rhythm_switch_read(%L) $$, pg_temp.id('z1'))), 'course',
  'the teacher reads z1 following the course');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5, 6]) $$), 'false', 'nothing is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm), 1::bigint, 'and no row was added');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '0', 'nothing is read');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '0', 'not by the teacher either');
SELECT is(pg_temp.ask('marko', format($$ SELECT concat_ws('/', enabled::text, source) FROM app.input_rhythm_switch_read(%L) $$, pg_temp.id('zm1'))),
  'true/default', 'a mentorship work has no course and keeps the default');

-- 5. The assignment overrides the course, both ways; clearing it gives the course back.
SELECT is(pg_temp.ask('vesna', format($$ SELECT concat_ws('/', enabled::text, source, changed_by_role) FROM app.input_rhythm_switch(%L, true) $$, pg_temp.id('z1'))),
  'true/assignment/teacher', 'Vesna switches z1 on while K1 is off: the assignment holds');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws('/', enabled::text, source) FROM app.input_rhythm_state('doc-a') $$), 'true/assignment',
  'Ana reads it on, from the assignment');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[7]) $$), 'true', 'a burst is recorded again');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '2', 'and both are read');
SELECT is(pg_temp.ask('vesna', format($$ SELECT concat_ws('/', enabled::text, source) FROM app.input_rhythm_switch_clear(%L) $$, pg_temp.id('z1'))),
  'false/course', 'Vesna clears z1''s switch: K1 holds again');
SELECT is((SELECT count(*) FROM audit.input_rhythm_switch_event
            WHERE assignment_id = pg_temp.id('z1') AND enabled IS NULL AND actor_id = pg_temp.id('vesna')),
  1::bigint, 'the clearing wrote one audit row in the same call');
SELECT is(pg_temp.ask('vesna', format($$ SELECT source FROM app.input_rhythm_switch_clear(%L) $$, pg_temp.id('z1'))), 'course',
  'clearing again changes nothing');
SELECT is((SELECT count(*) FROM audit.input_rhythm_switch_event WHERE enabled IS NULL), 1::bigint, 'and writes no audit row');
SELECT is(pg_temp.ask('vesna', format($$ SELECT concat_ws('/', enabled::text, source) FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))),
  'false/assignment', 'switched off on the assignment');
SELECT is(pg_temp.ask('vesna', format($$ SELECT concat_ws('/', enabled::text, source) FROM app.input_rhythm_course_switch(%L, true) $$, pg_temp.id('k1'))),
  'true/course', 'K1 switched on');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws('/', enabled::text, source) FROM app.input_rhythm_state('doc-a') $$), 'false/assignment',
  'the assignment''s off still overrides the course''s on');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[8]) $$), 'false', 'nothing is recorded');
SELECT is((SELECT string_agg(enabled::text, ',' ORDER BY occurred_at, enabled) FROM audit.input_rhythm_course_switch_event),
  'false,true', 'every switch of the course is in its trail');

-- 6. The trail is append-only, and no table is reachable but through the RPCs.
SELECT matches(pg_temp.ask_as('ductus_identity', 'anon', v.statement), '^ZD403: append-only row', v.what)
FROM (VALUES
  ('no audit row is rewritten, not even by its owner', $$ UPDATE audit.input_rhythm_course_switch_event SET enabled = true $$),
  ('no audit row is deleted, not even by its owner', $$ DELETE FROM audit.input_rhythm_course_switch_event $$)
) AS v (what, statement);
SELECT is((SELECT count(*) FROM audit.input_rhythm_course_switch_event), 2::bigint, 'the trail kept its rows');
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM evidence.input_rhythm_course_setting $$), '^42501',
  'the web role reads no row of the setting');
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM audit.input_rhythm_course_switch_event $$), '^42501',
  'the web role reads no row of the trail');

SELECT * FROM finish();
ROLLBACK;
