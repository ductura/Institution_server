-- SRV-0910 (Ductus#2052; P-1): the kind of origin of a change and the rhythm of
-- typing (20261213100300). The access matrix: the student owner writes and
-- reads; a reader of the work reads the composition and the bursts but writes
-- nothing; the rest (another student, a teacher of another course, another
-- institution, an unknown document, no session) get ZD403 or ZD401. No table
-- is reachable but through the RPCs. The rhythm holds gaps and nothing else:
-- no key, no content, no derived measure. All people are the invented ones of
-- the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- 1. Catalogue: three tables, forced RLS, the owner's only policy, no other privilege.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  t.name || ' has forced RLS, the evidence owner and no privilege for another role')
FROM (VALUES ('origin_change'), ('input_rhythm'), ('input_rhythm_setting')) AS t (name)
JOIN pg_class c ON c.oid = ('evidence.' || t.name)::regclass;
SELECT bag_eq(
  $$ SELECT tablename || ' ' || policyname FROM pg_policies WHERE schemaname = 'evidence'
      AND tablename IN ('origin_change', 'input_rhythm', 'input_rhythm_setting') $$,
  ARRAY['origin_change origin_change_owner', 'input_rhythm input_rhythm_owner',
        'input_rhythm_setting input_rhythm_setting_owner'],
  'only the owner''s policy on each');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.work_origin_record(text,text,integer)', 'app.work_origin_explain(text,uuid)',
       'app.work_origin_composition(text)', 'app.input_rhythm_record(text,integer[])', 'app.input_rhythm_set(boolean)',
       'app.input_rhythm_delete(text)', 'app.input_rhythm_read(text)', 'app.origin_work_access(text,boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.origin_change_add(uuid,uuid,text,integer)', 'app.origin_change_explain(uuid,uuid,uuid)',
       'app.origin_composition_of(uuid,uuid)', 'app.input_rhythm_add(uuid,uuid,integer[])',
       'app.input_rhythm_setting_put(uuid,boolean)', 'app.input_rhythm_remove(uuid,uuid)',
       'app.input_rhythm_of(uuid,uuid)', 'app.input_rhythm_purge_due()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers belong to the evidence and identity roles only');
SELECT bag_eq(
  $$ SELECT r::text FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth']) AS r
      WHERE has_function_privilege(r, 'app.input_rhythm_purge()', 'EXECUTE') $$,
  $$ VALUES ('ductus_retention') $$,
  'only the retention role runs the purge');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'after the migration no role keeps CREATE on the schema');
-- The rhythm has gaps, a time and a date of deletion; no column could hold a key, a content or a measure.
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'evidence' AND table_name = 'input_rhythm' $$,
  ARRAY['id', 'seq', 'institution_id', 'assignment_id', 'student_id', 'gaps_ms', 'recorded_at', 'delete_after'],
  'the rhythm table has only the gaps and their bookkeeping');
SELECT is_empty(
  $$ SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND (p.proname ~ 'rhythm|origin') AND p.prosrc ~* '(avg|percentile|stddev|variance|key_code|keycode)' $$,
  'no function of the class computes an average, a spread or reads a key');

-- 2. The student owner records changes; a paste starts as unknown.
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'typed', 600) $$), '^[0-9a-f-]{36}$', 'Ana records typed text');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'assistant_inserted', 200) $$), '^[0-9a-f-]{36}$', 'Ana records inserted text');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'imported_file', 100) $$), '^[0-9a-f-]{36}$', 'Ana records an import');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'pasted_unknown', 100) $$), '^[0-9a-f-]{36}$', 'Ana records a paste');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'pasted_known', 100) $$), '^ZD422', 'a paste cannot be recorded as known at once');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'typed', 0) $$), '^ZD422', 'zero characters is refused');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'dictated', 5) $$), '^ZD422', 'a kind outside the list is refused');

-- 3. The composition: the same for the student and the teacher, in the fixed order of the list.
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(kind || '=' || percent, ',') FROM app.work_origin_composition('doc-a') $$),
  'typed=60.0,assistant_inserted=20.0,assistant_match=0.0,imported_file=10.0,pasted_known=0.0,pasted_unknown=10.0',
  'Ana reads the share per kind');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(kind || '=' || percent, ',') FROM app.work_origin_composition('doc-a') $$),
  pg_temp.ask('ana', $$ SELECT string_agg(kind || '=' || percent, ',') FROM app.work_origin_composition('doc-a') $$),
  'the teacher reads the same answer');

-- 4. Who else: nothing but ZD403.
SELECT matches(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.work_origin_composition('doc-a') $$), '^ZD403',
  a.name || ' does not read the composition of Ana''s work')
FROM (VALUES ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.work_origin_composition('doc-nema') $$), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.work_origin_composition('doc-b') $$), '^ZD403', 'another institution''s document: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.work_origin_record('doc-a', 'typed', 10) $$), '^ZD403', 'a teacher writes no change');
SELECT matches(pg_temp.ask('dora', $$ SELECT app.work_origin_record('doc-a', 'typed', 10) $$), '^ZD403', 'another student writes no change');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM app.work_origin_composition('doc-a') $$), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 5. Explaining a paste: unknown -> known, the original kept; nobody else, once only.
CREATE TEMP TABLE chg AS SELECT pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'pasted_unknown', 100) $$) AS id;
SELECT is(pg_temp.ask('vesna', format($$ SELECT app.work_origin_explain('doc-a', %L) $$, (SELECT id FROM chg)))::text, 'ZD403: forbidden',
  'a teacher does not explain a paste');
SELECT is(pg_temp.ask('ana', format($$ SELECT app.work_origin_explain('doc-a', %L) $$, (SELECT id FROM chg))), 'true', 'Ana explains it');
SELECT is(pg_temp.ask('ana', format($$ SELECT app.work_origin_explain('doc-a', %L) $$, (SELECT id FROM chg))), 'false', 'a second time changes nothing');
SELECT is((SELECT kind || '/' || original_kind FROM evidence.origin_change WHERE id = (SELECT id::uuid FROM chg)),
  'pasted_known/pasted_unknown', 'the original kind is kept');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(kind || '=' || percent, ',') FROM app.work_origin_composition('doc-a') WHERE kind LIKE 'pasted%' $$),
  'pasted_known=9.1,pasted_unknown=9.1', 'the composition counts the explained paste as known');

-- 6. A change is never rewritten or removed, not even by the owner of the table.
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', v.statement), 'ZD403: origin change is append-only', v.what)
FROM (VALUES
  ('no change is deleted', $$ DELETE FROM evidence.origin_change $$),
  ('no size is rewritten', $$ UPDATE evidence.origin_change SET characters = 1 $$),
  ('a known paste is not turned back', $$ UPDATE evidence.origin_change SET kind = 'typed', original_kind = NULL WHERE kind = 'pasted_known' $$)
) AS v (what, statement);

-- 7. Rhythm: on by default; thinned to 130; read by the owner and a reader.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[120, 80, 4000]) $$), 'true', 'a burst is recorded');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', (SELECT array_agg(i) FROM generate_series(1, 1000) i)) $$), 'true', 'a long burst is recorded');
SELECT is((SELECT max(cardinality(gaps_ms)) FROM evidence.input_rhythm), 130, 'a burst holds at most 130 values');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[-1]) $$), '^ZD422', 'a negative gap is refused');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[NULL, 5]::integer[]) $$), '^ZD422', 'a null gap is refused');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[]::integer[]) $$), '^ZD422', 'an empty burst is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '2', 'Ana reads her bursts');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '2', 'the teacher reads them too');
SELECT matches(pg_temp.ask('dora', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '^ZD403', 'another student does not');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5]) $$), '^ZD403', 'a teacher records no rhythm');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.input_rhythm_delete('doc-a') $$), '^ZD403', 'a teacher deletes no rhythm');
-- RITAM-ROK-30D (20261220510000, Constitution v1.11 C-14): kept until 30 days
-- after the submission, so a burst of a work not yet submitted has no date yet.
SELECT is((SELECT count(*) FROM evidence.input_rhythm WHERE delete_after IS NULL), 2::bigint,
  'each row of a work not yet submitted waits for the submission for its date of deletion');

-- 8. The switch holds from the moment of switching off. It is the teacher's
-- (20261213110100, Daniel 22. 11. 2026.); the student no longer switches it.
SELECT matches(pg_temp.ask('ana', $$ SELECT app.input_rhythm_set(false)::text $$), '^42501', 'Ana cannot switch the recording off');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_switch(%L, false) $$, pg_temp.id('z1'))), 'false', 'the teacher switches the recording off');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5, 6]) $$), 'false', 'nothing is recorded while it is off');
SELECT is((SELECT count(*) FROM evidence.input_rhythm), 2::bigint, 'and no row was added');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '0', 'nothing is read while it is off');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_switch(%L, true) $$, pg_temp.id('z1'))), 'true', 'the teacher switches it on');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.input_rhythm_read('doc-a') $$), '2', 'the earlier bursts are there again');
SELECT matches(pg_temp.ask('vesna', format($$ SELECT enabled FROM app.input_rhythm_switch(%L, NULL) $$, pg_temp.id('z1'))), '^ZD422', 'a null switch is refused');

-- 9. Deletion on request, and the retention job.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_delete('doc-a') $$), '2', 'Ana deletes the recorded rhythm');
SELECT is((SELECT count(*) FROM evidence.input_rhythm), 0::bigint, 'nothing is left');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5]) $$), 'true', 'a new burst is recorded');
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', 'SELECT app.input_rhythm_purge()'), '0', 'the job deletes nothing that is not due');
SET LOCAL ROLE ductus_evidence;
UPDATE evidence.input_rhythm SET recorded_at = now() - interval '13 months', delete_after = now() - interval '1 month';
RESET ROLE;
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', 'SELECT app.input_rhythm_purge()'), '1', 'the job deletes what is due');

SELECT * FROM finish();
ROLLBACK;
