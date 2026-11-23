-- INT-15-SRV komentar-revizija-ugovor (Ductus#2055; 20261214140000): a comment
-- thread names the revision it was written on. A teacher must name one, a
-- student may; it must be a revision of that document the caller may see (for
-- the teacher, once submitted, at most the submitted one); a reply and every
-- row of the list carry the thread's revision. A caller with no relation gets
-- the same ZD403 whatever revision is named. Personas of institution.inc;
-- every person, text and document is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Ana's second document on Z1 with revisions 0 to 3, written as the evidence role.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision, current_content_hash)
VALUES ('doc-r', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), 3, pg_temp.h('3'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'doc-r', pg_temp.id('fak_a'), r, nullif(r - 1, -1), pg_temp.id('ana'), pg_temp.h(r::text)
  FROM generate_series(0, 3) AS r;
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

INSERT INTO ref VALUES
  ('anchor', '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}');

-- Catalogue.
SELECT is((SELECT string_agg(format('%s|%s', p.prosecdef, p.proowner::regrole), ',' ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p WHERE p.oid IN ('collaboration.create_comment(text,text,jsonb,bigint)'::regprocedure,
                                   'collaboration.create_general_comment(text,text,bigint)'::regprocedure)),
  't|ductus_identity,t|ductus_identity', 'the two new create functions are SECURITY DEFINER functions of the identity role');
SELECT is((SELECT format('%s|%s', p.prosecdef, p.proowner::regrole) FROM pg_proc p
    WHERE p.oid = 'collaboration.revision_visible(text,bigint,boolean)'::regprocedure),
  't|ductus_evidence', 'the revision is read through a function of the evidence role, as document_scope');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_identity', 'ductus_evidence']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.create_comment(text,text,jsonb,bigint)',
        'collaboration.create_general_comment(text,text,bigint)', 'collaboration.revision_visible(text,bigint,boolean)',
        'collaboration.check_thread_revision(text,text,bigint)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE')
        AND NOT (r = 'ductus_identity' AND f <> 'collaboration.revision_visible(text,bigint,boolean)') $$,
  $$ VALUES ('ductus_app collaboration.create_comment(text,text,jsonb,bigint)'),
            ('ductus_app collaboration.create_general_comment(text,text,bigint)'),
            ('ductus_identity collaboration.revision_visible(text,bigint,boolean)'),
            ('ductus_evidence collaboration.revision_visible(text,bigint,boolean)') $$,
  'the web role creates; only the identity role (and the owner) reads the revision; the check is nobody''s');
SELECT is(has_function_privilege('public', 'collaboration.revision_visible(text,bigint,boolean)', 'EXECUTE'), false,
  'nobody else reads the revision');
SELECT is(pg_get_function_arguments('collaboration.create_comment(text,text,jsonb,bigint)'::regprocedure),
  'p_document_id text, p_body text, p_anchor jsonb, p_revision bigint', 'the revision is the only new input; the author comes from the session');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'collaboration', 'USAGE'),
  'after the migration neither role keeps a right on the schema');
SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'collaboration.comment_thread'::regclass),
  'comment_thread keeps forced RLS');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p
  CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  WHERE has_column_privilege(r, 'collaboration.comment_thread', 'revision', p)
), 'no runtime role reads or writes the revision column directly');

-- A teacher must name a revision; a student need not.
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment('doc-r', 'Tekst.', {anchor}::jsonb, NULL) $$),
  'ZD422: invalid input', 'a teacher''s anchored comment without a revision is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-r', 'Tekst.', NULL) $$),
  'ZD422: invalid input', 'a teacher''s general comment without a revision is refused');
INSERT INTO ref SELECT 's1', pg_temp.ask('ana', $$ SELECT collaboration.create_general_comment('doc-r', 'Pitanje.', NULL) $$);
SELECT matches((SELECT val FROM ref WHERE name = 's1'), '^[0-9a-f-]{36}$', 'the student opens a thread without a revision');

-- The teacher names any revision of the document, not only the latest.
INSERT INTO ref SELECT 't2', pg_temp.ask('vesna', $$ SELECT collaboration.create_comment('doc-r', 'Uz drugu verziju.', {anchor}::jsonb, 2) $$);
SELECT matches((SELECT val FROM ref WHERE name = 't2'), '^[0-9a-f-]{36}$', 'the teacher comments on revision 2 of 3');
INSERT INTO ref SELECT 't3', pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-r', 'Uz zadnju.', 3) $$);
SELECT matches((SELECT val FROM ref WHERE name = 't3'), '^[0-9a-f-]{36}$', 'the teacher comments generally on the current revision');
INSERT INTO ref SELECT 's3', pg_temp.ask('ana', $$ SELECT collaboration.create_comment('doc-r', 'Moje.', {anchor}::jsonb, 3) $$);
SELECT matches((SELECT val FROM ref WHERE name = 's3'), '^[0-9a-f-]{36}$', 'the student may name a revision too');
SELECT bag_eq(
  $$ SELECT r.name, coalesce(t.revision::text, 'null') FROM collaboration.comment_thread t
       JOIN ref r ON r.val = t.id::text WHERE t.document_id = 'doc-r' $$,
  $$ VALUES ('s1', 'null'), ('t2', '2'), ('t3', '3'), ('s3', '3') $$,
  'each thread keeps the revision it was written on');

-- A revision that is not one of the document's is the same invalid input.
SELECT is(pg_temp.ask(c.who, format($$ SELECT collaboration.create_general_comment('doc-r', 'Tekst.', %s) $$, c.rev)),
  'ZD422: invalid input', c.who || ' cannot name revision ' || c.rev)
FROM (VALUES ('vesna', '0'), ('vesna', '4'), ('vesna', '-1'), ('vesna', '9007199254740991'), ('ana', '0'), ('ana', '4')) AS c (who, rev);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment('doc-r', 'Tekst.', {anchor}::jsonb, 4) $$),
  'ZD422: invalid input', 'an anchored comment on a revision that is not there is refused');
-- Revision 1 of doc-a does not exist (doc-a has only 0): a revision of another document does not count.
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-a', 'Tekst.', 2) $$),
  'ZD422: invalid input', 'a revision of Ana''s other document does not count for this one');

-- No relation: the same ZD403 whatever revision, so nothing about the work leaks.
SELECT is(pg_temp.ask(a.name, format($$ SELECT collaboration.create_general_comment('doc-r', 'Tekst.', %s) $$, a.rev)),
  'ZD403: forbidden', a.name || ' cannot comment on Ana''s work with revision ' || a.rev)
FROM (VALUES ('dora', '2'), ('dora', '99'), ('marko', '2'), ('marko', '99'), ('tomo', '2'), ('petra', '2')) AS a (name, rev);
SELECT is(pg_temp.ask('petra', $$ SELECT collaboration.create_comment('doc-r', 'Tekst.', {anchor}::jsonb, 2) $$),
  'ZD403: forbidden', 'a teacher of another institution is refused before the revision is looked at');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-nema', 'Tekst.', 1) $$),
  'ZD403: forbidden', 'a missing document reads as a forbidden one, revision or not');
SELECT matches(pg_temp.ask(t.name, $$ SELECT collaboration.create_general_comment('doc-r', 'Tekst.', 1) $$), '^ZD401',
  'with session ' || t.name || ' nobody is signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- A reply inherits the thread's revision; the list gives it on every row.
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.reply_comment({t2}, 'Ispravit ću.') $$), '^[0-9a-f-]{36}$',
  'Ana answers the thread on revision 2');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(format('%s:%s', comment_position, coalesce(revision::text, 'null')), ' ' ORDER BY comment_position)
    FROM collaboration.list_comments('doc-r') WHERE thread_id = {t2} $$), '1:2 2:2',
  'the reply lists with the revision of its thread');
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(revision::text, 'null') FROM collaboration.list_comments('doc-r') WHERE thread_id = {s1} $$),
  'null', 'a thread without a revision lists a null one');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM collaboration.list_comments('doc-r') $$), 'ZD403: forbidden',
  'a stranger lists nothing');

-- The old functions are unchanged for their callers: no revision.
INSERT INTO ref SELECT 'old', pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-r', 'Staro.') $$);
SELECT is((SELECT revision FROM collaboration.comment_thread WHERE id = pg_temp.id('old')), NULL::bigint,
  'create_general_comment/2 writes a thread without a revision');

CREATE TEMP TABLE due AS
SELECT due_at FROM institution.assignment_version WHERE assignment_id = pg_temp.id('z1') AND version_no = 2;
GRANT SELECT ON due TO PUBLIC;

-- Ana submits revision 2. The teacher now reads the submitted text, so a
-- later revision is not one she may name; an earlier one still is.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.submission_request (
  id, institution_id, assignment_id, assignment_version, project_id, document_id, principal_id, revision, content_hash, requested_at
) VALUES ('00000000-0000-4000-8000-0000000000f1', pg_temp.id('fak_a'), pg_temp.id('z1'), 2, 'project-a', 'doc-r',
          pg_temp.id('ana'), 2, pg_temp.h('2'), now());
INSERT INTO evidence.submission (
  submission_request_id, institution_id, principal_id, assignment_id, assignment_version, revision,
  artifact_hash, requested_at, due_at, recorded_at
)
SELECT q.id, q.institution_id, q.principal_id, q.assignment_id, q.assignment_version, q.revision, q.content_hash,
       q.requested_at, due.due_at, q.requested_at + interval '2 seconds'
  FROM evidence.submission_request q, due
 WHERE q.id = '00000000-0000-4000-8000-0000000000f1';
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-r', 'Tekst.', 3) $$),
  'ZD422: invalid input', 'after the submission of revision 2 the teacher cannot name revision 3');
SELECT matches(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment('doc-r', 'Starija verzija.', {anchor}::jsonb, 1) $$),
  '^[0-9a-f-]{36}$', 'the teacher still comments on an earlier version');
SELECT matches(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-r', 'Predana verzija.', 2) $$),
  '^[0-9a-f-]{36}$', 'the teacher comments on the submitted version');
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.create_general_comment('doc-r', 'Moja zadnja.', 3) $$),
  '^[0-9a-f-]{36}$', 'the student still names her own current revision');

SELECT * FROM finish();
ROLLBACK;
