-- SRV-1230 (Ductus#2052; P-1, rule 13): the match of a segment with an answer of
-- the assistant (20261213100800). The student owner reads the answers and
-- records a finding; the owner and a reader of the work read the same findings;
-- nobody else gets anything but ZD403. While the switch of the institution is off
-- nothing is returned and nothing is saved. Findings hold ids and a number, never
-- text. All people and texts are the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('srv1230-' || p_name), 1, 12))::uuid
$$;

SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_t'), pg_temp.id('fak_b'), pg_temp.id('tomo'), pg_temp.id('z3'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-0000000017e1', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved'),
  (pg_temp.u('r3'), pg_temp.id('fak_b'), pg_temp.id('tomo'), pg_temp.id('z3'), 1, pg_temp.u('conv_t'),
   '00000000-0000-4000-8000-0000000017e3', pg_temp.sha('r3'), 1, 'translation', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak.', pg_temp.sha('Izmišljeni odlomak.')),
  (pg_temp.u('m3'), pg_temp.u('conv_t'), pg_temp.id('fak_b'), 1, pg_temp.u('r3'), 'student_paragraph',
   'Drugi izmišljeni odlomak.', pg_temp.sha('Drugi izmišljeni odlomak.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id IN (pg_temp.u('r1'), pg_temp.u('r3'));
UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id = pg_temp.u('r1');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m2'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 2, pg_temp.u('r1'), 'provider_response',
   'Izmišljeni odgovor o kišobranima na stanici.', pg_temp.sha('Izmišljeni odgovor o kišobranima na stanici.'));
RESET ROLE;

-- 1. Catalogue.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  t.name || ' has forced RLS, the evidence owner and no privilege for another role')
FROM (VALUES ('assistant_match_finding'), ('assistant_match_attachment'), ('assistant_match_setting')) AS t (name)
JOIN pg_class c ON c.oid = ('evidence.' || t.name)::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.assistant_match_responses(text)', 'app.assistant_match_record(text,text,uuid,integer)',
       'app.assistant_match_read(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.assistant_match_enabled()', 'app.assistant_match_finding_add(uuid,uuid,text,uuid,uuid,integer)',
       'app.assistant_match_findings_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers belong to the evidence and identity roles only');
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'evidence' AND table_name = 'assistant_match_finding' $$,
  ARRAY['id', 'seq', 'institution_id', 'assignment_id', 'student_id', 'segment_ref', 'conversation_id', 'message_id', 'run_words', 'recorded_at'],
  'a finding holds ids and a number, no text');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'after the migration no role keeps CREATE on the schema');

-- 2. The owner reads the answers; nobody else does.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_responses('doc-a') $$), '1', 'Ana reads the one answer of the assistant');
SELECT matches(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.assistant_match_responses('doc-a') $$), '^ZD403',
  a.name || ' reads no answers of Ana''s conversations')
FROM (VALUES ('vesna'), ('dora'), ('boris'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_responses('doc-nema') $$), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM app.assistant_match_responses('doc-a') $$), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 3. A finding: only for an answer of the owner's own conversation, 8 words or more.
SELECT is(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-1', %L, 9) $$, pg_temp.u('m2'))), 'true', 'Ana records a finding');
SELECT is(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-1', %L, 12) $$, pg_temp.u('m2'))), 'false', 'the same segment and answer once only');
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-2', %L, 7) $$, pg_temp.u('m2'))), '^ZD422', 'fewer than 8 words is refused');
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', '', %L, 9) $$, pg_temp.u('m2'))), '^ZD422', 'an empty segment reference is refused');
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-2', %L, 9) $$, pg_temp.u('m1'))), '^ZD403', 'a paragraph of the student is no answer of the assistant');
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-2', %L, 9) $$, gen_random_uuid())), '^ZD403', 'an unknown message: ZD403');
SELECT matches(pg_temp.ask('vesna', format($$ SELECT app.assistant_match_record('doc-a', 'blok-2', %L, 9) $$, pg_temp.u('m2'))), '^ZD403', 'a teacher records no finding');
SELECT matches(pg_temp.ask('dora', format($$ SELECT app.assistant_match_record('doc-a', 'blok-2', %L, 9) $$, pg_temp.u('m2'))), '^ZD403', 'another student records no finding');
SELECT is((SELECT count(*) FROM evidence.assistant_match_finding), 1::bigint, 'one finding was saved');
SELECT is((SELECT count(*) FROM evidence.assistant_match_attachment WHERE reason = 'assistant_match'), 1::bigint,
  'the conversation was attached once, as transferred text');

-- 4. The student and the teacher read the same findings; others get ZD403.
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(segment_ref || '=' || run_words, ',') FROM app.assistant_match_read('doc-a') $$),
  pg_temp.ask('ana', $$ SELECT string_agg(segment_ref || '=' || run_words, ',') FROM app.assistant_match_read('doc-a') $$),
  'the teacher reads the same answer as the student');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(segment_ref || '=' || run_words, ',') FROM app.assistant_match_read('doc-a') $$), 'blok-1=9', 'with the run of 9 words');
SELECT matches(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.assistant_match_read('doc-a') $$), '^ZD403', a.name || ' reads no findings')
FROM (VALUES ('dora'), ('boris'), ('tomo')) AS a (name);

-- 5. Never rewritten or removed, not even by the owner of the table.
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', v.statement), 'ZD403: assistant match is append-only', v.what)
FROM (VALUES
  ('no finding is deleted', $$ DELETE FROM evidence.assistant_match_finding $$),
  ('no finding is rewritten', $$ UPDATE evidence.assistant_match_finding SET run_words = 99 $$),
  ('no attachment is deleted', $$ DELETE FROM evidence.assistant_match_attachment $$)
) AS v (what, statement);

-- 6. The switch: off, nothing is returned, computed or saved.
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.assistant_match_setting (institution_id, enabled) VALUES (pg_temp.id('fak_a'), false);
RESET ROLE;
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_responses('doc-a') $$), '0', 'no answers are returned while it is off');
SELECT is(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-3', %L, 20) $$, pg_temp.u('m2'))), 'false', 'nothing is recorded while it is off');
SELECT is((SELECT count(*) FROM evidence.assistant_match_finding), 1::bigint, 'and no row was added');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.assistant_match_read('doc-a') $$), '0', 'nothing is read while it is off');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_read('doc-a') $$), '0', 'nor by the student');
SET LOCAL ROLE ductus_evidence;
UPDATE evidence.assistant_match_setting SET enabled = true;
RESET ROLE;
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_read('doc-a') $$), '1', 'on again, the finding is there');

SELECT * FROM finish();
ROLLBACK;
