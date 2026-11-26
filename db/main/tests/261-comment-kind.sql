-- SRV-F4-EDI-R20 (F4, EDI-R20; Ductus#2058): the kind of a comment and a
-- general draft (20261220210000). A teacher drafts a thread with an optional
-- kind (must, sugg, q, praise) and with no anchor at all (a general comment);
-- the kind is the author's alone while a draft and the student's once it is
-- published. Who may draft is as for create_comment_draft (the teacher of the
-- work); the old function is unchanged. Personas of institution.inc and
-- evidence-acceptance.inc, all invented: Ana writes doc-a in Vesna's course K1,
-- Marko teaches K2.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

INSERT INTO ref VALUES
  ('anchor', '{"nodeId":"aaaaaaaa-0000-4000-8000-000000000001","quote":"primjer","prefix":"","suffix":"","startHint":0,"endHint":7}');

-- 1. Catalogue.
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid = 'collaboration.create_comment_draft_v2(text,text,jsonb,text)'::regprocedure
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'create_comment_draft_v2 is a SECURITY DEFINER function of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_function_privilege(r, 'collaboration.create_comment_draft_v2(text,text,jsonb,text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role executes create_comment_draft_v2');
SELECT is(
  (SELECT string_agg(attname, ',') FROM pg_attribute
    WHERE attrelid = 'collaboration.comment'::regclass AND attname = 'kind' AND NOT attisdropped),
  'kind', 'a comment has a kind column');
SELECT ok(NOT has_table_privilege('ductus_app', 'collaboration.comment', 'INSERT')
  AND NOT has_table_privilege('ductus_app', 'collaboration.comment', 'UPDATE'),
  'the web role still writes no comment directly: the kind goes through the function');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

CREATE FUNCTION pg_temp.evidence_print() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce((SELECT string_agg(row_to_json(d)::text, '|' ORDER BY d.id) FROM evidence.document d), '')
    || coalesce((SELECT string_agg(row_to_json(r)::text, '|' ORDER BY r.document_id, r.revision) FROM evidence.document_revision r), ''))
$$;
INSERT INTO ref SELECT 'ev-before', pg_temp.evidence_print();

-- 2. Drafting: a general draft with a kind, an anchored one without.
INSERT INTO ref SELECT 'g1', pg_temp.ask('vesna',
  $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Opći komentar o radu.', NULL, 'q') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'g1'), '^[0-9a-f-]{36}$', 'Vesna drafts a general comment with a kind');
INSERT INTO ref SELECT 'g2', pg_temp.ask('vesna',
  $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Još jedan opći.', 'null'::jsonb, NULL) $$);
SELECT matches((SELECT val FROM ref WHERE name = 'g2'), '^[0-9a-f-]{36}$', 'a json null anchor is a general draft too, and a missing kind is allowed');
INSERT INTO ref SELECT 'a1', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Odlomak treba izvor.', %L::jsonb, 'must') $$, (SELECT val FROM ref WHERE name = 'anchor')));
SELECT matches((SELECT val FROM ref WHERE name = 'a1'), '^[0-9a-f-]{36}$', 'she drafts an anchored comment with a kind');
INSERT INTO ref SELECT 'old', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Bez vrste.', %L::jsonb) $$, (SELECT val FROM ref WHERE name = 'anchor')));
SELECT matches((SELECT val FROM ref WHERE name = 'old'), '^[0-9a-f-]{36}$', 'the old function still drafts, with no kind');

SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), '4',
  'the author reads her four drafts');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') WHERE kind = 'q' AND anchor IS NULL $$), '1',
  'the general draft lists with a null anchor and its kind');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') WHERE kind = 'must' AND anchor IS NOT NULL $$), '1',
  'the anchored draft lists with its anchor and its kind');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') WHERE kind IS NULL $$), '2',
  'a draft with no kind lists with a null kind');

-- 3. Bad input and the wrong people.
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Tekst.', NULL, 'other') $$),
  'ZD422: invalid input', 'a kind outside the bank''s is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Tekst.', NULL, '') $$),
  'ZD422: invalid input', 'an empty kind is refused, not read as none');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft_v2('doc-a', '   ', NULL, 'q') $$),
  'ZD422: invalid input', 'a blank general draft is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Tekst.', '{}'::jsonb, 'q') $$),
  'ZD422: invalid input', 'a malformed anchor is refused, as it is for the old function');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Tekst.', '"x"'::jsonb, NULL) $$),
  'ZD422: invalid input', 'an anchor that is neither an object nor null is refused');
SELECT is(pg_temp.ask(a.name, $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Tekst.', NULL, 'q') $$),
  'ZD403: forbidden', a.name || ' cannot draft a general comment on Ana''s work')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft_v2('doc-nema', 'Tekst.', NULL, 'q') $$),
  'ZD403: forbidden', 'a work that is not there reads as one she does not teach');
SELECT matches(pg_temp.ask('anon', $$ SELECT collaboration.create_comment_draft_v2('doc-a', 'Tekst.', NULL, 'q') $$),
  '^ZD401', 'drafting needs a session');

-- 4. Unpublished: the student and another teacher see nothing.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), '0',
  'Ana reads no comment while all are drafts');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), 'ZD403: forbidden',
  'a teacher of another course reads no drafts of the work');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), 'ZD403: forbidden',
  'the student reads no list of drafts and so no kind');

-- 5. Published: the student reads the thread, the kind and the null anchor.
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.publish_comments('doc-a') $$), '4', 'Vesna publishes her four drafts');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') WHERE kind = 'q' AND anchor IS NULL AND body = 'Opći komentar o radu.' $$), '1',
  'Ana reads the general comment with its kind and no anchor');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') WHERE kind = 'must' AND anchor IS NOT NULL $$), '1',
  'Ana reads the anchored comment with its kind');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') WHERE kind IS NULL $$), '2',
  'comments written without a kind read with a null kind');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), 'ZD403: forbidden',
  'another student reads none of it');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), '0',
  'a published comment is no longer a draft');

-- 6. The student''s own comment has no kind; a reply carries none.
INSERT INTO ref SELECT 's1', pg_temp.ask('ana', $$ SELECT collaboration.create_general_comment('doc-a', 'Moj opći komentar.') $$);
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') WHERE author_role = 'student' AND kind IS NULL $$), '1',
  'a student''s comment has a null kind');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-a', 'Moj odgovor.') $$) ~ '^[0-9a-f-]{36}$', 'true',
  'a comment written without the draft function has a null kind');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') WHERE author_role = 'teacher' AND kind IS NULL AND body = 'Moj odgovor.' $$), '1',
  'and reads with a null kind');

-- 7. Nothing of it enters the evidence of the work (as 201: a comment is its own record).
SELECT is(pg_temp.evidence_print(), (SELECT val FROM ref WHERE name = 'ev-before'),
  'drafting, publishing and a kind write no document, revision or hash');

SELECT * FROM finish();
ROLLBACK;
