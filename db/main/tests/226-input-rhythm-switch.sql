-- PIL-P1-RITAM-SRV (Ductus#2052; P-1 rule 4, Daniel 22. 11. 2026.): the switch
-- of the rhythm of typing is the teacher's (20261213110100). The access matrix:
-- the teacher of the assignment's course, or the mentor of a mentorship work,
-- sets and reads the switch; the student owner and the readers of the work read
-- its state through the work, with who changed it last and when; the student
-- never sets it; the rest (another student, a teacher of another course or of
-- no part in a mentorship, an administrator, a teacher nobody confirmed,
-- another institution, an unknown assignment or document, no session) get ZD403
-- or ZD401. Every switch leaves an append-only audit row in the same call. The
-- tables are reachable only through the RPCs. All people are the invented ones
-- of the shared fixtures.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
-- evidence-acceptance.inc leaves every constraint IMMEDIATE; mentorship.inc writes
-- an assignment before its first version, so defer that key for the fixture.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
VALUES (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Izmišljena', 'Nastavnica');

-- 1. Catalogue: the web role executes the three RPCs, no other role but the owners.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.input_rhythm_switch(uuid,boolean)', 'app.input_rhythm_switch_read(uuid)',
       'app.input_rhythm_state(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs of the switch');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.input_rhythm_assignment_on(uuid)', 'app.input_rhythm_assignment_row(uuid)',
       'app.input_rhythm_assignment_put(uuid,boolean,text)', 'app.input_rhythm_require_teacher(uuid)',
       'app.input_rhythm_setting_view(uuid)', 'app.input_rhythm_set(boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers and the old student switch are not the web role''s');
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns
      WHERE table_schema = 'evidence' AND table_name = 'input_rhythm_assignment_setting' $$,
  ARRAY['institution_id', 'assignment_id', 'enabled', 'changed_by', 'changed_by_role', 'changed_at'],
  'the switch holds a state and its bookkeeping only');
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT has_table_privilege('ductus_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'the audit trail has forced RLS and the identity owner')
  FROM pg_class c WHERE c.oid = 'audit.input_rhythm_switch_event'::regclass;
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE') AND NOT has_schema_privilege('ductus_identity', 'audit', 'CREATE'),
  'after the migration no role keeps CREATE on the schemas');

-- 2. On by default, nobody changed it; the teacher reads it, the owner and the readers read the state.
SELECT is(pg_temp.ask('vesna', format($$ SELECT row(s.*)::text FROM app.input_rhythm_switch_read(%L) s $$, pg_temp.id('z1'))),
  '(t,default,,,)', 'on by default for the teacher, with nobody who changed it');
SELECT is(pg_temp.ask('ana', $$ SELECT row(s.*)::text FROM app.input_rhythm_state('doc-a') s $$), '(t,default,,,)', 'Ana reads the default state of her work');
SELECT is(pg_temp.ask('vesna', $$ SELECT enabled FROM app.input_rhythm_state('doc-a') $$), 'true', 'the teacher reads it through the work');

-- 3. Only the teacher of the assignment sets it.
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))), '^ZD403',
  a.name || ' does not set the switch of z1')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('marko'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled FROM app.input_rhythm_switch_read(%L) $$, pg_temp.id('z1'))), '^ZD403',
  a.name || ' does not read the switch of z1')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('petra')) AS a (name);
SELECT matches(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('z2'))), '^ZD403',
  'the teacher does not set the switch of another course');
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled FROM app.input_rhythm_switch('00000000-0000-4000-8000-00000000dead', false) $$), '^ZD403',
  'an unknown assignment: ZD403');
SELECT matches(pg_temp.ask(t.name, format($$ SELECT enabled FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is((SELECT count(*) FROM evidence.input_rhythm_assignment_setting), 0::bigint, 'no refused call left a setting');
SELECT is((SELECT count(*) FROM audit.input_rhythm_switch_event), 0::bigint, 'and no audit row');

-- 4. Nobody else reads the state of Ana's work.
SELECT matches(pg_temp.ask(a.name, $$ SELECT enabled FROM app.input_rhythm_state('doc-a') $$), '^ZD403',
  a.name || ' does not read the state of Ana''s work')
FROM (VALUES ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled FROM app.input_rhythm_state('doc-nema') $$), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled FROM app.input_rhythm_state('doc-b') $$), '^ZD403', 'another institution''s document: ZD403');
SELECT matches(pg_temp.ask('anon', $$ SELECT enabled FROM app.input_rhythm_state('doc-a') $$), '^ZD401', 'no session: ZD401');

-- 5. Off: nothing is recorded or read; the student sees who switched it and when; the trail has the row.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[120, 80]) $$), 'true', 'a burst is recorded while on');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled || '/' || changed_by_role || '/' || changed_by_name FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))),
  'false/teacher/Izmišljena Nastavnica', 'the teacher switches it off and reads who did');
SELECT is((SELECT changed_by FROM evidence.input_rhythm_assignment_setting), pg_temp.id('vesna'), 'the setting keeps who changed it');
SELECT is(pg_temp.ask('ana', $$ SELECT enabled || '/' || changed_by_role || '/' || changed_by_name FROM app.input_rhythm_state('doc-a') $$),
  'false/teacher/Izmišljena Nastavnica', 'Ana sees that it is off, and that her teacher switched it');
SELECT ok(pg_temp.ask('ana', $$ SELECT changed_at FROM app.input_rhythm_state('doc-a') $$) IS NOT NULL, 'and when');
SELECT is((SELECT count(*) FROM audit.input_rhythm_switch_event
            WHERE assignment_id = pg_temp.id('z1') AND NOT enabled AND actor_id = pg_temp.id('vesna') AND actor_role = 'teacher'),
  1::bigint, 'the switch wrote one audit row in the same call');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5, 6]) $$), 'false', 'nothing is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm), 1::bigint, 'and no row was added');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '0', 'nothing is read');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_delete('doc-a') $$), '1', 'Ana still deletes what was recorded');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_switch(%L, true) $$, pg_temp.id('z1'))), 'true', 'the teacher switches it on');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_switch_read(%L) $$, pg_temp.id('z1'))), 'true', 'and reads it on');
SELECT is((SELECT string_agg(enabled::text, ',' ORDER BY enabled) FROM audit.input_rhythm_switch_event),
  'false,true', 'every switch is in the trail');

-- 6. The mentor of a mentorship work sets its switch as the mentor; nobody else does.
SELECT is(pg_temp.ask('marko', format($$ SELECT enabled || '/' || changed_by_role || '/' || coalesce(changed_by_name, '-') FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('zm1'))),
  'false/mentor/-', 'Marko switches the recording of the thesis he mentors, as its mentor (no name known)');
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled FROM app.input_rhythm_switch(%L, true) $$, pg_temp.id('zm1'))), '^ZD403',
  a.name || ' does not set the switch of Marko''s mentorship work')
FROM (VALUES ('ana'), ('vesna'), ('iva')) AS a (name);
SELECT matches(pg_temp.ask('nina', format($$ SELECT enabled FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('zm3'))), '^ZD403',
  'a mentor whose teacher role nobody confirmed does not set it');

-- 7. The trail is append-only, and no table is reachable but through the RPCs.
SELECT matches(pg_temp.ask_as('ductus_identity', 'anon', v.statement), '^ZD403: append-only row', v.what)
FROM (VALUES
  ('no audit row is rewritten, not even by its owner', $$ UPDATE audit.input_rhythm_switch_event SET enabled = true $$),
  ('no audit row is deleted, not even by its owner', $$ DELETE FROM audit.input_rhythm_switch_event $$)
) AS v (what, statement);
SELECT is((SELECT count(*) FROM audit.input_rhythm_switch_event), 3::bigint, 'the trail kept its three rows');
SELECT matches(pg_temp.ask('ana', $$ SELECT count(*) FROM evidence.input_rhythm_assignment_setting $$), '^42501',
  'the web role reads no row of the setting');
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM audit.input_rhythm_switch_event $$), '^42501',
  'the web role reads no row of the trail');

SELECT * FROM finish();
ROLLBACK;
