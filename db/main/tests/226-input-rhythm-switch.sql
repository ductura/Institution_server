-- PIL-P1-RITAM-SRV (Ductus#2052; P-1 rule 4, Daniel 22. 11. 2026.): the switch
-- of the rhythm of typing is the teacher's (20261213110100). The access matrix:
-- the teacher of the assignment's course sets and reads the switch; the student
-- owner and the readers of the work read its state through the work; the
-- student never sets it; the rest (another student, a teacher of another course,
-- an administrator, another institution, an unknown assignment or document, no
-- session) get ZD403 or ZD401. The table is reachable only through the RPCs.
-- All people are the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

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
     CROSS JOIN unnest(ARRAY['app.input_rhythm_assignment_on(uuid)', 'app.input_rhythm_assignment_put(uuid,boolean)',
       'app.input_rhythm_require_teacher(uuid)', 'app.input_rhythm_set(boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers and the old student switch are not the web role''s');
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns
      WHERE table_schema = 'evidence' AND table_name = 'input_rhythm_assignment_setting' $$,
  ARRAY['institution_id', 'assignment_id', 'enabled', 'changed_by', 'changed_at'],
  'the switch holds a state and its bookkeeping only');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE'),
  'after the migration no role keeps CREATE on the schemas');

-- 2. On by default; the teacher reads it, the owner and the readers read the state.
SELECT is(pg_temp.ask('vesna', format($$ SELECT app.input_rhythm_switch_read(%L) $$, pg_temp.id('z1'))), 'true', 'on by default for the teacher');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_state('doc-a') $$), 'true', 'Ana reads the state of her work');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.input_rhythm_state('doc-a') $$), 'true', 'the teacher reads it through the work');

-- 3. Only the teacher of the assignment sets it.
SELECT matches(pg_temp.ask(a.name, format($$ SELECT app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))), '^ZD403',
  a.name || ' does not set the switch of z1')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('marko'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask(a.name, format($$ SELECT app.input_rhythm_switch_read(%L) $$, pg_temp.id('z1'))), '^ZD403',
  a.name || ' does not read the switch of z1')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('petra')) AS a (name);
SELECT matches(pg_temp.ask('vesna', format($$ SELECT app.input_rhythm_switch(%L, false) $$, pg_temp.id('z2'))), '^ZD403',
  'the teacher does not set the switch of another course');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.input_rhythm_switch('00000000-0000-4000-8000-00000000dead', false) $$), '^ZD403',
  'an unknown assignment: ZD403');
SELECT matches(pg_temp.ask(t.name, format($$ SELECT app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is((SELECT count(*) FROM evidence.input_rhythm_assignment_setting), 0::bigint, 'no refused call left a row');

-- 4. Nobody else reads the state of Ana's work.
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.input_rhythm_state('doc-a') $$), '^ZD403',
  a.name || ' does not read the state of Ana''s work')
FROM (VALUES ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.input_rhythm_state('doc-nema') $$), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.input_rhythm_state('doc-b') $$), '^ZD403', 'another institution''s document: ZD403');
SELECT matches(pg_temp.ask('anon', $$ SELECT app.input_rhythm_state('doc-a') $$), '^ZD401', 'no session: ZD401');

-- 5. Off: nothing is recorded or read, and everyone reads the same state.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[120, 80]) $$), 'true', 'a burst is recorded while on');
SELECT is(pg_temp.ask('vesna', format($$ SELECT app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))), 'false', 'the teacher switches it off');
SELECT is((SELECT changed_by FROM evidence.input_rhythm_assignment_setting), pg_temp.id('vesna'), 'the switch keeps who changed it');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_state('doc-a') $$), 'false', 'Ana reads that it is off');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5, 6]) $$), 'false', 'nothing is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm), 1::bigint, 'and no row was added');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '0', 'nothing is read');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_delete('doc-a') $$), '1', 'Ana still deletes what was recorded');
SELECT is(pg_temp.ask('vesna', format($$ SELECT app.input_rhythm_switch(%L, true) $$, pg_temp.id('z1'))), 'true', 'the teacher switches it on');
SELECT is(pg_temp.ask('vesna', format($$ SELECT app.input_rhythm_switch_read(%L) $$, pg_temp.id('z1'))), 'true', 'and reads it on');

-- 6. The table is reachable only through the RPCs.
SELECT matches(pg_temp.ask('ana', $$ SELECT count(*) FROM evidence.input_rhythm_assignment_setting $$), '^42501',
  'the web role reads no row of the table');

SELECT * FROM finish();
ROLLBACK;
