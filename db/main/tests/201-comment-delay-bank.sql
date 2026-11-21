-- SRV-1703 (M6.7; D-51, N-03, N-05): delayed publishing of a teacher's
-- comments, the comment bank and the last reviewed revision
-- (20261129100200). The student never reads an unpublished comment, nor
-- replies to or resolves its thread; a draft is read only by its author; the
-- bank (saved comment templates, SRV-8B) is private to its teacher; the
-- reviewed revision is the teacher's own record and the student never reads
-- it. Every person, document and text below is invented; the documents are
-- those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Marko teaches K1 too, so a second teacher of the same work is there.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');

CREATE TEMP TABLE anchor_json AS SELECT
  '{"nodeId":"aaaaaaaa-0000-4000-8000-000000000001","quote":"primjer","prefix":"","suffix":"","startHint":0,"endHint":7}'::jsonb AS a;

-- 1. Catalogue.
SELECT bag_eq(
  $$ SELECT relname::text FROM pg_class WHERE relnamespace = 'collaboration'::regnamespace AND relkind = 'r'
      AND relname = 'work_review' AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('work_review') $$,
  'the identity role owns work_review and RLS is forced on it');
SELECT bag_eq(
  $$ SELECT tablename::text, policyname::text, roles::text, cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename = 'work_review' $$,
  $$ VALUES ('work_review', 'work_review_owner', '{ductus_identity}', 'ALL') $$,
  'work_review has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.work_review', p) $$,
  'no runtime role reads or writes a review mark directly');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.create_comment_draft(text,text,jsonb)'::regprocedure,
        'collaboration.reply_comment_draft(text,uuid,text)'::regprocedure, 'collaboration.list_comment_drafts(text)'::regprocedure,
        'collaboration.discard_comment_draft(uuid)'::regprocedure, 'collaboration.publish_comments(text)'::regprocedure,
        'collaboration.mark_work_reviewed(text)'::regprocedure, 'collaboration.get_work_review(text)'::regprocedure,
        'collaboration.delete_work_reviews(text,uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the eight functions are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.create_comment_draft(text,text,jsonb)', 'collaboration.reply_comment_draft(text,uuid,text)',
        'collaboration.list_comment_drafts(text)', 'collaboration.discard_comment_draft(uuid)', 'collaboration.publish_comments(text)',
        'collaboration.mark_work_reviewed(text)', 'collaboration.get_work_review(text)', 'collaboration.delete_work_reviews(text,uuid)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.create_comment_draft(text,text,jsonb)'), ('ductus_app collaboration.reply_comment_draft(text,uuid,text)'),
            ('ductus_app collaboration.list_comment_drafts(text)'), ('ductus_app collaboration.discard_comment_draft(uuid)'),
            ('ductus_app collaboration.publish_comments(text)'), ('ductus_app collaboration.mark_work_reviewed(text)'),
            ('ductus_app collaboration.get_work_review(text)'), ('ductus_retention collaboration.delete_work_reviews(text,uuid)') $$,
  'the web role drafts, publishes and records reviews; only the retention role deletes marks');
SELECT ok(NOT has_function_privilege('ductus_app', 'collaboration.document_revision(text)', 'EXECUTE'),
  'the web role cannot read a revision directly');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'collaboration', 'CREATE'),
  'after the migration neither the identity nor the evidence role keeps CREATE on the schema');

-- 2. Delayed publishing: a draft is the author's alone.
INSERT INTO ref SELECT 't1', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Prvi odlomak treba izvor.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
SELECT matches((SELECT val FROM ref WHERE name = 't1'), '^[0-9a-f-]{36}$', 'Vesna, the teacher of K1, drafts a comment on Ana''s work');
INSERT INTO ref SELECT 't2', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Zaključak je prekratak.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
SELECT is(pg_temp.ask(a.name, format($$ SELECT collaboration.create_comment_draft('doc-a', 'Tekst.', %L::jsonb) $$, (SELECT a FROM anchor_json))),
  'ZD403: forbidden', a.name || ' cannot draft a comment on Ana''s work')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask('anon', format($$ SELECT collaboration.create_comment_draft('doc-a', 'Tekst.', %L::jsonb) $$, (SELECT a FROM anchor_json))),
  '^ZD401', 'drafting needs a session');
SELECT is(pg_temp.ask('vesna', format($$ SELECT collaboration.create_comment_draft('doc-a', '   ', %L::jsonb) $$, (SELECT a FROM anchor_json))),
  'ZD422: invalid input', 'a blank draft is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft('doc-a', 'Tekst.', '{}'::jsonb) $$),
  'ZD422: invalid input', 'a draft with a malformed anchor is refused');

-- Acceptance (1): the student does not see an unpublished comment.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), '0',
  'Ana reads no comment while all are drafts');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), '0',
  'the author does not read her drafts as published comments either');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), '0',
  'another teacher of the work reads none of them');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), '2',
  'Vesna reads her two drafts');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), '0',
  'another teacher of the work reads none of Vesna''s drafts');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), 'ZD403: forbidden',
  'the student reads no list of drafts');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.reply_comment({t1}::uuid, 'Odgovor.') $$), 'ZD403: forbidden',
  'the student cannot reply to a thread with no published comment');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.reply_comment_draft('doc-a', {t1}::uuid, 'Odgovor.') $$), 'ZD403: forbidden',
  'the student cannot draft a reply');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.resolve_thread({t1}::uuid) $$), 'ZD403: forbidden',
  'the student cannot resolve a thread of drafts');

SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.reply_comment_draft('doc-b', {t1}::uuid, 'Krivi rad.') $$), 'ZD403: forbidden',
  'a draft reply names the work the thread belongs to: another work is refused');

-- An immediate comment stays immediate (existing behaviour).
SELECT matches(pg_temp.ask('marko', format($$ SELECT collaboration.create_comment('doc-a', 'Odmah vidljivo.', %L::jsonb) $$, (SELECT a FROM anchor_json))),
  '^[0-9a-f-]{36}$', 'Marko writes an ordinary comment, published at once');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(body, '|') FROM collaboration.list_comments('doc-a') $$), 'Odmah vidljivo.',
  'Ana reads that comment and none of the drafts');

-- A draft reply on a published thread.
INSERT INTO ref SELECT 'c1', pg_temp.ask('ana', format($$ SELECT collaboration.create_comment('doc-a', 'Pitanje studenta.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
INSERT INTO ref SELECT 'd1', pg_temp.ask('vesna', $$ SELECT collaboration.reply_comment_draft('doc-a', {c1}::uuid, 'Odgovor nastavnice.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'd1'), '^[0-9a-f-]{36}$', 'Vesna drafts a reply on Ana''s own thread');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') c WHERE c.comment_position = 2 $$), '0',
  'Ana does not read the draft reply');
SELECT is((SELECT state FROM collaboration.comment_thread WHERE id = (SELECT val::uuid FROM ref WHERE name = 'c1')), 'answered',
  'a draft reply does not move the state of the thread');

-- 3. Publishing: one instant, the author's drafts only.
SELECT is(pg_temp.ask('marko', $$ SELECT collaboration.publish_comments('doc-a') $$), 'ZD409: conflict',
  'a teacher with no draft has nothing to publish');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.publish_comments('doc-a') $$), 'ZD403: forbidden',
  'the student cannot publish');
SELECT is(pg_temp.ask('petra', $$ SELECT collaboration.publish_comments('doc-a') $$), 'ZD403: forbidden',
  'a teacher of another course cannot publish');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.publish_comments('doc-a') $$), '3',
  'Vesna publishes her three drafts at once');
SELECT is((SELECT count(DISTINCT published_at) FROM collaboration.comment WHERE author_id = pg_temp.id('vesna')), 1::bigint,
  'all of them carry one publishing instant');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), '5',
  'Ana now reads the two published threads, the reply, her own thread and the earlier comment');
SELECT is((SELECT state FROM collaboration.comment_thread WHERE id = (SELECT val::uuid FROM ref WHERE name = 'c1')), 'open',
  'the published reply makes the answered thread open');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), '0',
  'no draft is left');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.publish_comments('doc-a') $$), 'ZD409: conflict',
  'a second publish has nothing to give');
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.reply_comment({t1}::uuid, 'Hvala, ispravit ću.') $$), '^[0-9a-f-]{36}$',
  'after publishing the student replies to the thread');

-- 4. Discarding a draft.
INSERT INTO ref SELECT 'x1', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Predomislila sam se.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
INSERT INTO ref SELECT 'xc', (SELECT c.id::text FROM collaboration.comment c WHERE c.thread_id = (SELECT val::uuid FROM ref WHERE name = 'x1'));
SELECT is(pg_temp.ask('marko', $$ SELECT collaboration.discard_comment_draft({xc}::uuid) $$), 'ZD403: forbidden',
  'another teacher cannot discard Vesna''s draft');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.discard_comment_draft({d1}::uuid) $$), 'ZD403: forbidden',
  'a published comment cannot be discarded');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.discard_comment_draft({xc}::uuid) $$), '',
  'Vesna discards her draft');
SELECT is((SELECT count(*) FROM collaboration.comment_thread WHERE id = (SELECT val::uuid FROM ref WHERE name = 'x1')), 0::bigint,
  'the thread that had only that draft goes with it');

-- Draft replies: not into another teacher's unpublished thread; discarding a
-- reply keeps the opening; the bound of 500 holds for replies too.
INSERT INTO ref SELECT 'y1', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Nova nit.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
SELECT is(pg_temp.ask('marko', $$ SELECT collaboration.reply_comment_draft('doc-a', {y1}::uuid, 'Tuđa nit.') $$), 'ZD403: forbidden',
  'another teacher cannot draft a reply into an unpublished thread of Vesna''s');
INSERT INTO ref SELECT 'yr', pg_temp.ask('vesna', $$ SELECT collaboration.reply_comment_draft('doc-a', {y1}::uuid, 'Vlastiti nastavak.') $$);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.discard_comment_draft({yr}::uuid) $$), '',
  'Vesna discards only her draft reply');
SELECT is((SELECT count(*) FROM collaboration.comment WHERE thread_id = (SELECT val::uuid FROM ref WHERE name = 'y1')), 1::bigint,
  'the opening draft of the thread is still there');
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body, published_at)
SELECT (SELECT val::uuid FROM ref WHERE name = 'y1'), pg_temp.id('fak_a'), 1 + g, pg_temp.id('vesna'), 'teacher', 'Nacrt ' || g, NULL
FROM generate_series(1, 498) g;
RESET ROLE;
-- Vesna now holds 499 drafts on the work (the opening and 498 more... plus none else): one more fits, the next does not.
SELECT matches(pg_temp.ask('vesna', $$ SELECT collaboration.reply_comment_draft('doc-a', {y1}::uuid, 'Petstoti.') $$), '^[0-9a-f-]{36}$',
  'the 500th draft of an author on a work is accepted');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.reply_comment_draft('doc-a', {y1}::uuid, 'Šeststoti.') $$), 'ZD422: invalid input',
  'the 501st is refused, replies included');
INSERT INTO ref SELECT 'yo', (SELECT c.id::text FROM collaboration.comment c WHERE c.thread_id = (SELECT val::uuid FROM ref WHERE name = 'y1') AND c.position = 1);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.discard_comment_draft({yo}::uuid) $$), '',
  'discarding the opening draft of an unpublished thread');
SELECT is((SELECT count(*) FROM collaboration.comment WHERE thread_id = (SELECT val::uuid FROM ref WHERE name = 'y1')), 0::bigint,
  'takes the thread''s other drafts and the thread with it');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), '0', 'no draft is left');

-- A teacher removed from the course cannot discard a draft she wrote earlier.
INSERT INTO ref SELECT 'w1', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Zadnji nacrt.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
INSERT INTO ref SELECT 'wc', (SELECT c.id::text FROM collaboration.comment c WHERE c.thread_id = (SELECT val::uuid FROM ref WHERE name = 'w1'));
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.discard_comment_draft({wc}::uuid) $$), 'ZD403: forbidden',
  'Vesna, no longer a teacher of K1, cannot discard her draft');
UPDATE institution.course_member SET member_to = NULL
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.discard_comment_draft({wc}::uuid) $$), '', 'back in the course she can');

-- 5. The comment bank (N-03) is private to its teacher.
INSERT INTO ref SELECT 'b1', pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template('Navedite izvor.', 'must') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'b1'), '^[0-9a-f-]{36}$', 'Vesna saves a comment in her bank');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_templates() $$), '1', 'Vesna reads her bank');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_comment_templates() $$), '0',
  a.name || ' reads nothing of Vesna''s bank')
FROM (VALUES ('marko'), ('petra')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_comment_templates() $$), '0',
  a.name || ' has an empty bank of their own and reads nothing of Vesna''s')
FROM (VALUES ('ana'), ('dora'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask('marko', $$ SELECT collaboration.delete_comment_template({b1}::uuid) $$), 'ZD403: forbidden',
  'another teacher cannot delete a comment of Vesna''s bank');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.comment_template $$) ~ '^42501', true,
  'the student cannot read the bank table directly');

-- 6. The last reviewed revision (N-05).
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), pg_temp.h('b'));
UPDATE evidence.document SET current_revision = 1, current_content_hash = pg_temp.h('b') WHERE id = 'doc-a';
RESET ROLE;
SELECT is(pg_temp.ask('vesna', $$ SELECT reviewed_revision || '/' || current_revision FROM collaboration.get_work_review('doc-a') $$)::text IS NULL, true,
  'before any review the reviewed revision is empty (null) and the current one is 1');
SELECT is(pg_temp.ask('vesna', $$ SELECT current_revision FROM collaboration.get_work_review('doc-a') $$), '1', 'the current revision is read');
SELECT is(pg_temp.ask('vesna', $$ SELECT reviewed_revision FROM collaboration.mark_work_reviewed('doc-a') $$), '1',
  'Vesna marks revision 1 as reviewed');
SELECT is(pg_temp.ask('vesna', $$ SELECT reviewed_revision FROM collaboration.get_work_review('doc-a') $$), '1', 'it is read back');
SELECT is(pg_temp.ask('marko', $$ SELECT coalesce(reviewed_revision::text, 'none') FROM collaboration.get_work_review('doc-a') $$), 'none',
  'the mark is the teacher''s own: another teacher of the work has none');
SELECT is(pg_temp.ask(a.name, $$ SELECT reviewed_revision FROM collaboration.get_work_review('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no review mark')
FROM (VALUES ('ana'), ('dora'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT reviewed_revision FROM collaboration.mark_work_reviewed('doc-a') $$), 'ZD403: forbidden',
  a.name || ' cannot mark a work reviewed')
FROM (VALUES ('ana'), ('dora'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT reviewed_revision FROM collaboration.mark_work_reviewed('doc-nema') $$), 'ZD403: forbidden',
  'a missing work reads as a forbidden one');
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-a', pg_temp.id('fak_a'), 2, 1, pg_temp.id('ana'), pg_temp.h('c'));
UPDATE evidence.document SET current_revision = 2, current_content_hash = pg_temp.h('c') WHERE id = 'doc-a';
RESET ROLE;
SELECT is(pg_temp.ask('vesna', $$ SELECT reviewed_revision || '/' || current_revision FROM collaboration.get_work_review('doc-a') $$), '1/2',
  'after the student writes on, the reviewed revision stays 1 and the current one is 2');
SELECT is(pg_temp.ask('vesna', $$ SELECT reviewed_revision FROM collaboration.mark_work_reviewed('doc-a') $$), '2', 'a new review moves the mark to 2');
SELECT is((SELECT count(*) FROM collaboration.work_review WHERE document_id = 'doc-a'), 1::bigint, 'the mark is one row per teacher and work');

-- 7. Nothing written in the evidence schema's chain by comments or drafts beyond the revisions inserted above.
SELECT is((SELECT count(*) FROM evidence.document_revision WHERE document_id = 'doc-a'), 3::bigint,
  'drafting, publishing and marking wrote no revision: only the two inserted above and revision 0');

-- 8. The marks go with the document, only through the retention role.
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.delete_work_reviews('doc-a', {fak_a}) $$), '^42501',
  'the web role cannot call the retention delete');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_work_reviews('doc-a', pg_temp.id('fak_b'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.work_review), 1::bigint, 'a delete with another institution leaves the mark alone');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_work_reviews('doc-a', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.work_review), 0::bigint, 'after the retention delete no mark is left');

-- 9. A teacher who leaves the course loses drafts and marks at once.
INSERT INTO ref SELECT 't9', pg_temp.ask('vesna',
  format($$ SELECT collaboration.create_comment_draft('doc-a', 'Još jedna.', %L::jsonb) $$, (SELECT a FROM anchor_json)));
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_drafts('doc-a') $$), 'ZD403: forbidden',
  'Vesna, no longer a teacher of K1, reads no draft');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.publish_comments('doc-a') $$), 'ZD403: forbidden',
  'nor publishes');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') c WHERE c.body = 'Još jedna.' $$), '0',
  'her unpublished draft stays unseen by the student');

SELECT * FROM finish();
ROLLBACK;
