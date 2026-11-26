-- INT-15-SRV (Ductus#2055): a comment thread names the revision of the work it
-- was written on (20261214140000). A teacher must name one, the owning student
-- may; it must exist and be one the caller may read: for the teacher up to the
-- newest standing submission, or the current revision before there is one. A
-- stranger learns nothing of the document or its revisions. Every person,
-- document, text and hash below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- A new general (null anchor) or anchored thread as p_actor, on p_revision.
CREATE FUNCTION pg_temp.comment(p_actor text, p_revision bigint, p_document text DEFAULT 'doc-a',
                                p_anchor jsonb DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT collaboration.create_revision_comment(%L, 'Izmišljeni komentar.', %L::jsonb, %L::bigint) $q$,
    p_document, p_anchor, p_revision))
$$;
CREATE FUNCTION pg_temp.req() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id::text FROM evidence.submission_request WHERE document_id = 'doc-a'
$$;

-- Shape: one RPC of the identity role for the web role; one helper of the
-- evidence role for the identity role alone; no schema right left behind.
SELECT is(
  (SELECT format('%s %s %s', proowner::regrole, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'collaboration.create_revision_comment(text,text,jsonb,bigint)'::regprocedure),
  'ductus_identity t t', 'create_revision_comment is a SECURITY DEFINER function of the identity role');
SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'collaboration.comment_revision_visible(text,uuid,bigint,text)'::regprocedure),
  'ductus_evidence s t t', 'the evidence role owns the one helper that reads revisions and submissions');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                            'ductus_identity', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.create_revision_comment(text,text,jsonb,bigint)',
                              'collaboration.comment_revision_visible(text,uuid,bigint,text)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.create_revision_comment(text,text,jsonb,bigint)'),
            ('ductus_identity collaboration.create_revision_comment(text,text,jsonb,bigint)'),
            ('ductus_identity collaboration.comment_revision_visible(text,uuid,bigint,text)'),
            ('ductus_evidence collaboration.comment_revision_visible(text,uuid,bigint,text)') $$,
  'the web role executes the RPC, never the helper; only the identity role and the owner execute the helper');
SELECT is(pg_get_function_arguments('collaboration.create_revision_comment(text,text,jsonb,bigint)'::regprocedure),
  'p_document_id text, p_body text, p_anchor jsonb, p_revision bigint',
  'the RPC takes no author, role or institution: they come from the session');
SELECT is(pg_get_function_result('collaboration.list_comments(text)'::regprocedure),
  'TABLE(thread_id uuid, comment_id uuid, comment_position integer, author_role text, is_own boolean, body text, anchor jsonb, state text, created_window timestamp with time zone, deleted_window timestamp with time zone, revision bigint, kind text)',
  'list_comments gives the thread''s revision as its last column, no exact time and no id of a person');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence',
                                'ductus_test_stranger']) AS r
      WHERE has_function_privilege(r, 'collaboration.list_comments(text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$, 'the remade list_comments keeps its one grant, to the web role');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'evidence', 'USAGE')
  AND NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'collaboration', 'USAGE')
  AND NOT has_schema_privilege('ductus_evidence', 'collaboration', 'CREATE'),
  'the migration leaves no schema right behind');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
  CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  WHERE has_table_privilege(r, 'collaboration.comment_thread', p)),
  'the thread table, with its new column, is still reached only through the RPCs');

-- An older thread, written before revisions were recorded, keeps a null revision.
INSERT INTO ref SELECT 'old', pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-a', 'Stari komentar.') $$);

-- Ana commits revisions 1 to 3 and requests revision 1.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
  repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'fixture: Ana requests revision 1');
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-2',
    pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
                       p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64)), 'reserved', 'fixture: Ana commits revision 2');
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-3',
    pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
                       p_hash => repeat('9', 64), p_predecessor => repeat('c', 64)),
    2, repeat('e', 64), repeat('f', 64), repeat('9', 64)), 'reserved', 'fixture: Ana commits revision 3');

-- Before a submission the teacher may comment on any revision up to the current one, not only the newest.
INSERT INTO ref SELECT 'v3', pg_temp.comment('vesna', 3);
SELECT matches((SELECT val FROM ref WHERE name = 'v3'), '^[0-9a-f-]{36}$', 'Vesna comments on the current revision 3');
INSERT INTO ref SELECT 'v2', pg_temp.comment('vesna', 2,
  p_anchor => '{"nodeId":"0f1e2d3c-4b5a-4968-8776-655443322110","quote":"odlomak","prefix":"","suffix":"","startHint":0,"endHint":7}');
SELECT matches((SELECT val FROM ref WHERE name = 'v2'), '^[0-9a-f-]{36}$', 'Vesna anchors a comment on the older revision 2');
SELECT is(pg_temp.comment('vesna', NULL), 'ZD422: invalid input', 'a teacher''s thread without a revision is refused');
SELECT is(pg_temp.comment('vesna', r.revision), 'ZD422: invalid input',
  'Vesna is refused revision ' || r.revision || ', which ' || r.why)
FROM (VALUES (0::bigint, 'is revision zero, no saved text'), (4, 'does not exist yet'), (-1, 'is negative'),
             (9007199254740991, 'does not exist')) AS r (revision, why);

-- The student who owns the work may name a revision or none.
INSERT INTO ref SELECT 'a0', pg_temp.comment('ana', NULL);
SELECT matches((SELECT val FROM ref WHERE name = 'a0'), '^[0-9a-f-]{36}$', 'Ana opens a thread without a revision');
INSERT INTO ref SELECT 'a3', pg_temp.comment('ana', 3);
SELECT matches((SELECT val FROM ref WHERE name = 'a3'), '^[0-9a-f-]{36}$', 'Ana opens a thread on revision 3');
SELECT is(pg_temp.comment('ana', 4), 'ZD422: invalid input', 'Ana cannot name a revision that does not exist');

-- Nobody else, with a revision that exists or not, learns more than for a missing document.
SELECT is(pg_temp.comment(a.name, r.revision), 'ZD403: forbidden',
  a.name || ' cannot comment on Ana''s revision ' || r.revision)
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo')) AS a (name)
CROSS JOIN (VALUES (1::bigint), (4)) AS r (revision);
SELECT is(pg_temp.comment('vesna', 1, 'doc-b'), 'ZD403: forbidden', 'Vesna cannot comment on Tomo''s work');
SELECT is(pg_temp.comment('vesna', 1, 'doc-nema'), 'ZD403: forbidden', 'a missing document reads as a forbidden one');
SELECT matches(pg_temp.comment(t.name, 1), '^ZD401', 'a comment with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_revision_comment('doc-a', '   ', NULL, 1) $$),
  'ZD422: invalid input', 'a blank body is still refused');
SELECT is(pg_temp.comment('vesna', 1, p_anchor => '{"nodeId":"x"}'), 'ZD422: invalid input',
  'an anchor that is not a text anchor is refused');

-- The row: the revision on the thread, scope from the document, author from the session.
SELECT row_eq(
  $$ SELECT institution_id, document_id, owner_id, created_by, state, revision FROM collaboration.comment_thread
      WHERE id = pg_temp.id('v3') $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('ana'), pg_temp.id('vesna'), 'open'::text, 3::bigint),
  'the thread holds the revision it was written on');
SELECT throws_ok($$ UPDATE collaboration.comment_thread SET revision = 0 WHERE id = pg_temp.id('v3') $$,
  '23514', NULL, 'the table refuses a revision below 1');

-- A reply carries its thread's revision; the old thread lists null. Teacher and owner read the same.
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.reply_comment({v2}, 'Izmišljeni odgovor.') $$),
  '^[0-9a-f-]{36}$', 'Ana answers the thread on revision 2');
SELECT is(pg_temp.ask(a.name, $$ SELECT string_agg(format('%s:%s:%s', t.name, comment_position, coalesce(revision::text, '-')),
                                    ',' ORDER BY t.name, comment_position)
                                 FROM collaboration.list_comments('doc-a') l JOIN ref t ON t.val = l.thread_id::text $$),
  'a0:1:-,a3:1:3,old:1:-,v2:1:2,v2:2:2,v3:1:3', a.name || ' reads every thread with its revision, the reply with its thread''s')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), 'ZD403: forbidden',
  'a stranger still reads no thread');

-- After the submission of revision 1 the teacher reads that one: older and
-- submitted revisions stay open to comment, later ones are not hers to read.
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)', pg_temp.req(),
  pg_temp.h('d'))), 'recorded', 'fixture: the submission of revision 1 is recorded');
SELECT matches(pg_temp.comment('vesna', 1), '^[0-9a-f-]{36}$', 'Vesna comments on the submitted revision 1');
SELECT is(pg_temp.comment('vesna', r.revision), 'ZD422: invalid input',
  'Vesna cannot comment on revision ' || r.revision || ', after the submission')
FROM (VALUES (2::bigint), (3)) AS r (revision);
SELECT matches(pg_temp.comment('ana', 3), '^[0-9a-f-]{36}$', 'Ana still comments on her own revision 3');

-- Revocation is immediate: a teacher who left the course is refused before any revision is looked at.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna');
SELECT is(pg_temp.comment('vesna', 1), 'ZD403: forbidden', 'Vesna, gone from K1, cannot comment');

SELECT * FROM finish();
ROLLBACK;
