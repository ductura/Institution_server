-- SRV-1111 (Ductus#2052; P-1, rule 12): the thresholds of a faculty per kind of
-- origin and the comparison of a work with them (20261213100400). The access
-- matrix: only a confirmed administrator of the institution reads and writes
-- the thresholds; the owner of a work and its readers read the comparison;
-- everybody else gets ZD403 (an unknown document too) or ZD401 without a
-- session. No table is reachable but through the RPCs. There are no defaults.
-- All people are the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- 1. Catalogue.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND (SELECT count(*) FROM pg_policies p WHERE p.schemaname = t.nsp AND p.tablename = t.rel) = 1,
  t.nsp || '.' || t.rel || ': forced RLS, the identity owner and no privilege for another role')
FROM (VALUES ('institution', 'origin_threshold'), ('audit', 'origin_threshold_event')) AS t (nsp, rel)
JOIN pg_class c ON c.oid = (t.nsp || '.' || t.rel)::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.origin_thresholds_read()', 'app.origin_threshold_put(text,numeric,text)', 'app.origin_threshold_clear(text)',
       'app.work_origin_threshold_status(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
       AND rolname <> 'ductus_identity' UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.origin_threshold_admin()', 'EXECUTE') $$,
  'the administrator check is the owner''s alone');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_identity', 'audit', 'CREATE')
    AND NOT has_schema_privilege('ductus_identity', 'institution', 'CREATE'),
  'after the migration no role keeps CREATE on the schemas');
SELECT is_empty(
  $$ SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname ~ 'threshold' AND p.prosrc ~* '(avg|percentile|stddev|rank\(|row_number)' $$,
  'no function of the class averages, ranks or compares persons');

-- 2. No defaults: nothing is written, nothing is compared.
SELECT is((SELECT count(*) FROM institution.origin_threshold), 0::bigint, 'the migration writes no threshold');
SELECT is(pg_temp.ask('iva', $$ SELECT count(*) FROM app.origin_thresholds_read() $$), '0', 'the administrator reads an empty list');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-a') $$), '0', 'with no threshold nothing is compared');

-- 3. Who writes and reads the thresholds: the administrator of the institution only.
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.origin_threshold_put('pasted_unknown', 15, 'soft') $$), '^ZD403',
  a.name || ' does not write a threshold')
FROM (VALUES ('vesna'), ('marko'), ('ana'), ('dora'), ('boris'), ('nina')) AS a (name);
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.origin_threshold_clear('pasted_unknown') $$), '^ZD403',
  a.name || ' does not clear a threshold')
FROM (VALUES ('vesna'), ('ana'), ('nina')) AS a (name);
SELECT matches(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.origin_thresholds_read() $$), '^ZD403', a.name || ' does not read thresholds')
FROM (VALUES ('vesna'), ('ana'), ('nina')) AS a (name);
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM app.origin_thresholds_read() $$), '^ZD401', 'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT app.origin_threshold_put('typed', 10, 'soft') $$), '^ZD401', 'no session writes nothing');
SELECT is((SELECT count(*) FROM institution.origin_threshold), 0::bigint, 'and nothing was written');

-- 4. Input: the closed list of kinds, 0 to 100, hard or soft, no null.
SELECT matches(pg_temp.ask('iva', v.statement), '^ZD422', v.what)
FROM (VALUES
  ('a kind outside the list', $$ SELECT app.origin_threshold_put('dictated', 10, 'soft') $$),
  ('a negative threshold', $$ SELECT app.origin_threshold_put('typed', -1, 'soft') $$),
  ('a threshold above 100', $$ SELECT app.origin_threshold_put('typed', 100.1, 'soft') $$),
  ('a strictness outside the list', $$ SELECT app.origin_threshold_put('typed', 10, 'firm') $$),
  ('a null kind', $$ SELECT app.origin_threshold_put(NULL, 10, 'soft') $$),
  ('a null threshold', $$ SELECT app.origin_threshold_put('typed', NULL, 'soft') $$),
  ('a null strictness', $$ SELECT app.origin_threshold_put('typed', 10, NULL) $$),
  ('clearing a kind outside the list', $$ SELECT app.origin_threshold_clear('dictated') $$),
  ('clearing a null kind', $$ SELECT app.origin_threshold_clear(NULL) $$)
) AS v (what, statement);
SELECT is((SELECT count(*) FROM institution.origin_threshold), 0::bigint, 'a refused write leaves nothing');

-- 5. The administrator writes (the demo values) and reads them in the fixed order.
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('pasted_unknown', 15, 'soft') $$), 'true', 'Iva writes the first threshold');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('assistant_inserted', 10, 'hard') $$), 'true', 'and the second');
SELECT is(pg_temp.ask('iva', $$ SELECT string_agg(kind || '=' || threshold_percent || '/' || strictness, ',') FROM app.origin_thresholds_read() $$),
  'assistant_inserted=10.0/hard,pasted_unknown=15.0/soft', 'she reads them in the order of the list');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('pasted_unknown', 15, 'soft') $$), 'false', 'the same value again changes nothing');
SELECT is((SELECT count(*) FROM audit.origin_threshold_event), 2::bigint, 'and records nothing');
SELECT is(pg_temp.ask('lea', $$ SELECT count(*) FROM app.origin_thresholds_read() $$), '0', 'the other institution''s administrator sees none of them');

-- 6. The comparison: Ana has typed 60, inserted 20, imported 10, pasted unknown 10 (of 100).
SELECT pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'typed', 600) $$);
SELECT pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'assistant_inserted', 200) $$);
SELECT pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'imported_file', 100) $$);
SELECT pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'pasted_unknown', 100) $$);
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(kind || '=' || status, ',') FROM app.work_origin_threshold_status('doc-a') $$),
  'assistant_inserted=exceeded,pasted_unknown=in_line', 'above a hard threshold: exceeded; under a soft one: in line');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(kind || '=' || status, ',') FROM app.work_origin_threshold_status('doc-a') $$),
  pg_temp.ask('ana', $$ SELECT string_agg(kind || '=' || status, ',') FROM app.work_origin_threshold_status('doc-a') $$),
  'the teacher reads the same answer as the student');

-- A soft threshold exceeded is for review; a share equal to the threshold is in line.
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('pasted_unknown', 5, 'soft') $$), 'true', 'Iva lowers the soft threshold');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('assistant_inserted', 20, 'hard') $$), 'true', 'raises the hard one to the share itself');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_put('typed', 60, 'hard') $$), 'true', 'and adds one for the typed text');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(kind || '=' || status, ',') FROM app.work_origin_threshold_status('doc-a') $$),
  'typed=in_line,assistant_inserted=in_line,pasted_unknown=for_review',
  'equal to the threshold is in line; above a soft one is for review');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-a') WHERE status NOT IN ('in_line', 'for_review', 'exceeded') $$),
  '0', 'only the three words are ever answered');

-- 7. Who else reads the comparison: nothing but ZD403.
SELECT matches(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-a') $$), '^ZD403',
  a.name || ' does not read the comparison of Ana''s work')
FROM (VALUES ('dora'), ('boris'), ('lea'), ('petra'), ('tomo'), ('iva'), ('marko')) AS a (name);
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-nema') $$), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-b') $$), '^ZD403', 'another institution''s document: ZD403');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-a') $$), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-b') $$), '0',
  'the thresholds of one institution are not applied to another''s work');

-- 8. The trail: one event per change, with the administrator; append-only.
SELECT is((SELECT string_agg(action || ':' || kind, ',' ORDER BY kind, action) FROM audit.origin_threshold_event WHERE actor_id = pg_temp.id('iva')),
  'set:assistant_inserted,set:assistant_inserted,set:pasted_unknown,set:pasted_unknown,set:typed', 'the trail names what was set');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_clear('typed') $$), 'true', 'clearing a kind that has a threshold');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_clear('typed') $$), 'false', 'clearing it again changes nothing');
SELECT is((SELECT count(*) FROM audit.origin_threshold_event WHERE action = 'cleared' AND threshold_percent IS NULL AND strictness IS NULL), 1::bigint,
  'a cleared kind is recorded without a value, once');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_clear('pasted_unknown') $$), 'true', 'Iva clears another');
SELECT is(pg_temp.ask('iva', $$ SELECT app.origin_threshold_clear('assistant_inserted') $$), 'true', 'and the last');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.work_origin_threshold_status('doc-a') $$), '0', 'without thresholds nothing is shown again');
SELECT throws_ok($$ DELETE FROM audit.origin_threshold_event $$, NULL, NULL, 'the trail is not deleted');
SELECT throws_ok($$ UPDATE audit.origin_threshold_event SET actor_id = actor_id $$, NULL, NULL, 'the trail is not rewritten');

SELECT * FROM finish();
ROLLBACK;
