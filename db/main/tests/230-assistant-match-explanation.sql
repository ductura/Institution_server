-- PIL-P1-PODUDARANJE-OBJASNJENJE-SRV (Ductus#2052; P-1, rule 13): the student's
-- explanation of a finding of the match with the assistant
-- (20261214130000). Only the student owner writes it, once per finding, 1 to
-- 2000 characters, NFC, without a control character; the owner and a reader of
-- the work read the same; nobody else gets anything but ZD403. While the switch
-- of the institution is off nothing is written or read. All people and texts are
-- the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('objasnjenje-' || p_name), 1, 12))::uuid
$$;
CREATE FUNCTION pg_temp.explain(p_actor text, p_segment text, p_text text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT app.assistant_match_explain('doc-a', %L, %L, %L) IS NOT NULL $q$,
                                     p_segment, pg_temp.u('m2'), p_text))
$$;

SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-0000000018e1', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak.', pg_temp.sha('Izmišljeni odlomak.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id = pg_temp.u('r1');
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
  'assistant_match_explanation has forced RLS, the evidence owner and no privilege for another role')
FROM pg_class c WHERE c.oid = 'evidence.assistant_match_explanation'::regclass;
SELECT policies_are('evidence', 'assistant_match_explanation', ARRAY['assistant_match_explanation_owner'],
  'only the owner''s policy');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.assistant_match_explain(text,text,uuid,text)', 'app.assistant_match_explanations(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.assistant_match_explanation_add(uuid,uuid,text,uuid,text)',
       'app.assistant_match_explanations_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers belong to the evidence and identity roles only');
SELECT ok(p.prosecdef AND p.proconfig @> ARRAY['search_path=""'], f || ' is SECURITY DEFINER with an empty search_path')
FROM unnest(ARRAY['app.assistant_match_explain(text,text,uuid,text)', 'app.assistant_match_explanations(text)',
  'app.assistant_match_explanation_add(uuid,uuid,text,uuid,text)', 'app.assistant_match_explanations_of(uuid,uuid)']) f
JOIN pg_proc p ON p.oid = f::regprocedure;
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'evidence' AND table_name = 'assistant_match_explanation' $$,
  ARRAY['institution_id', 'assignment_id', 'student_id', 'segment_ref', 'message_id', 'explanation_text', 'written_at'],
  'an explanation holds the finding''s key, the text and the time');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE'),
  'after the migration no role keeps CREATE on the schemas');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM evidence.assistant_match_explanation $$), '^42501',
  'session ' || t.name || ' does not read the table directly')
FROM (VALUES ('ana'), ('vesna')) AS t (name);

-- 2. Ana records two findings; an explanation needs a finding.
SELECT is(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', %L, %L, 9) $$, s.ref, pg_temp.u('m2'))), 'true',
  'Ana records the finding of ' || s.ref)
FROM (VALUES ('blok-1'), ('blok-2')) AS s (ref);
SELECT matches(pg_temp.explain('ana', 'blok-9', 'Pisala sam sama.'), '^ZD403', 'no finding of this segment: ZD403');
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.assistant_match_explain('doc-a', 'blok-1', %L, 'Tekst.') $$, pg_temp.u('m1'))),
  '^ZD403', 'no finding of this message: ZD403');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.assistant_match_explain('doc-nema', 'blok-1', gen_random_uuid(), 'Tekst.') $$),
  '^ZD403', 'an unknown document: ZD403');

-- 3. The text: 1 to 2000 characters, NFC, not blank, no control character but newline and tab.
SELECT matches(pg_temp.explain('ana', 'blok-1', v.body), '^ZD422', v.what)
FROM (VALUES
  ('an empty text is refused', ''),
  ('a blank text is refused', E'  \n\t '),
  ('2001 characters are refused', repeat('a', 2001)),
  ('a text that is not NFC is refused', 'Kafe' || U&'\0301'),
  ('a control character is refused', E'Prvi\u0001drugi'),
  ('a carriage return is refused', E'Prvi\rdrugi'),
  ('a bidirectional control is refused', E'Prvi‮drugi')
) AS v (what, body);
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.assistant_match_explain('doc-a', '', %L, 'Tekst.') $$, pg_temp.u('m2'))),
  '^ZD422', 'an empty segment reference is refused');
SELECT matches(pg_temp.ask('ana', $$ SELECT app.assistant_match_explain('doc-a', 'blok-1', NULL, 'Tekst.') $$),
  '^ZD422', 'no message is refused');
SELECT is((SELECT count(*) FROM evidence.assistant_match_explanation), 0::bigint, 'nothing was saved');

-- 4. Only the owner writes.
SELECT matches(pg_temp.explain(a.name, 'blok-1', 'Tuđe objašnjenje.'), '^ZD403', a.name || ' writes no explanation of Ana''s finding')
FROM (VALUES ('vesna'), ('dora'), ('boris'), ('tomo')) AS a (name);
SELECT matches(pg_temp.explain(t.name, 'blok-1', 'Tekst.'), '^ZD401', 'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 5. Once per finding.
SELECT is(pg_temp.explain('ana', 'blok-1', E'Rečenicu sam prepisala iz bilješki.\nPoslije sam je preoblikovala.'), 'true',
  'Ana explains the first finding');
SELECT matches(pg_temp.explain('ana', 'blok-1', 'Drugo objašnjenje.'), '^ZD409', 'a second explanation of the same finding: ZD409');
SELECT is(pg_temp.explain('ana', 'blok-2', repeat('ž', 2000)), 'true', '2000 characters are accepted');
SELECT is((SELECT count(*) FROM evidence.assistant_match_explanation), 2::bigint, 'two explanations were saved');

-- 6. The student and the teacher read the same; others get ZD403.
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(segment_ref || '=' || char_length(explanation_text), ',' ORDER BY segment_ref) FROM app.assistant_match_explanations('doc-a') $$),
  pg_temp.ask('ana', $$ SELECT string_agg(segment_ref || '=' || char_length(explanation_text), ',' ORDER BY segment_ref) FROM app.assistant_match_explanations('doc-a') $$),
  'the teacher reads the same as the student');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(segment_ref || '=' || char_length(explanation_text), ',' ORDER BY segment_ref) FROM app.assistant_match_explanations('doc-a') $$),
  'blok-1=65,blok-2=2000', 'both explanations, whole');
SELECT is(pg_temp.ask('ana', $$ SELECT explanation_text FROM app.assistant_match_explanations('doc-a') WHERE segment_ref = 'blok-1' $$),
  E'Rečenicu sam prepisala iz bilješki.\nPoslije sam je preoblikovala.', 'the text as written');
SELECT matches(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.assistant_match_explanations('doc-a') $$), '^ZD403', a.name || ' reads no explanations')
FROM (VALUES ('dora'), ('boris'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM app.assistant_match_explanations('doc-a') $$), '^ZD401', 'no session reads nothing');

-- 7. Never rewritten or removed, not even by the owner of the table.
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', v.statement), 'ZD403: assistant match is append-only', v.what)
FROM (VALUES
  ('no explanation is deleted', $$ DELETE FROM evidence.assistant_match_explanation $$),
  ('no explanation is rewritten', $$ UPDATE evidence.assistant_match_explanation SET explanation_text = 'Drugo.' $$)
) AS v (what, statement);

-- 8. The switch: off, nothing is written or read.
SELECT is(pg_temp.ask('ana', format($$ SELECT app.assistant_match_record('doc-a', 'blok-3', %L, 9) $$, pg_temp.u('m2'))), 'true',
  'a third finding, while it is on');
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.assistant_match_setting (institution_id, enabled) VALUES (pg_temp.id('fak_a'), false);
RESET ROLE;
SELECT matches(pg_temp.explain('ana', 'blok-3', 'Objašnjenje.'), '^ZD403', 'no explanation is written while it is off');
SELECT is((SELECT count(*) FROM evidence.assistant_match_explanation), 2::bigint, 'and no row was added');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.assistant_match_explanations('doc-a') $$), '0', 'nothing is read while it is off');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_explanations('doc-a') $$), '0', 'nor by the student');
SET LOCAL ROLE ductus_evidence;
UPDATE evidence.assistant_match_setting SET enabled = true;
RESET ROLE;
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.assistant_match_explanations('doc-a') $$), '2', 'on again, the explanations are there');
SELECT is(pg_temp.explain('ana', 'blok-3', 'Objašnjenje.'), 'true', 'and the third finding can be explained');

SELECT * FROM finish();
ROLLBACK;
