-- SRV-8A (wave 8, Ductus#2028): a general comment, a thread with no text
-- anchor (20261121000000). Same access as create_comment: the teacher of the
-- work and the student who owns it, nobody else. Every person, course and
-- text below is invented; the documents are those of 050.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- One document of Ana on Z1 (fak-a) and one of Tomo on Z3 (fak-b), with a
-- revision, a package and a segment each, as the evidence role writes them.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.package (
  id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id, max_payload_bytes
) VALUES
  ('pkg-a', pg_temp.id('fak_a'), '00000000-0000-4000-8000-0000000000d1', 'doc-a', 'project-a', pg_temp.id('ana'), 'standard-v1', 2097152);
INSERT INTO evidence.segment (
  id, evidence_package_id, institution_id, document_id, principal_id, session_id, sequence_from, sequence_to,
  event_count, descriptor, segment_hash, payload_bytes, storage_ref, accepted_at
) VALUES
  ('segment-a', 'pkg-a', pg_temp.id('fak_a'), 'doc-a', pg_temp.id('ana'), 'synthetic-session-a', 1, 1, 1,
   jsonb_build_object('segmentHash', repeat('b', 64), 'payloadBytes', 123), repeat('b', 64), 123,
   'synthetic://pkg-a/segment-a', now());
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- Catalogue: one more SECURITY DEFINER function of the identity role, for the web role only.
SELECT is((SELECT format('%s|%s', p.prosecdef, p.proowner::regrole) FROM pg_proc p
    WHERE p.oid = 'collaboration.create_general_comment(text,text)'::regprocedure),
  'true|ductus_identity', 'create_general_comment is a SECURITY DEFINER function of the identity role');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'public']) AS r
      WHERE r <> 'public' AND has_function_privilege(r, 'collaboration.create_general_comment(text,text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role executes create_general_comment');
SELECT is(pg_get_function_arguments('collaboration.create_general_comment(text,text)'::regprocedure),
  'p_document_id text, p_body text', 'the general comment takes no author and no anchor: they come from the session and the rule');

-- Creating: the teacher and the owning student; nobody else, nothing without a session.
INSERT INTO ref SELECT 'g1', pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-a', 'Općenito: dodaj zaključak.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'g1'), '^[0-9a-f-]{36}$', 'the teacher of K1 opens a general thread on Ana''s document');
INSERT INTO ref SELECT 'g2', pg_temp.ask('ana', $$ SELECT collaboration.create_general_comment('doc-a', 'Je li uvod dovoljno dug?') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'g2'), '^[0-9a-f-]{36}$', 'Ana opens a general thread on her own document');
SELECT is(pg_temp.ask(a.name, $$ SELECT collaboration.create_general_comment('doc-a', 'Tekst.') $$), 'ZD403: forbidden',
  a.name || ' cannot open a general thread on Ana''s document')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris'), ('nina')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-b', 'Tekst.') $$), 'ZD403: forbidden',
  'a teacher cannot open a general thread on a document of another institution');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-nema', 'Tekst.') $$), 'ZD403: forbidden',
  'a missing document reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT collaboration.create_general_comment('doc-a', 'Tekst.') $$), '^ZD401',
  'a general comment with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-a', NULL) $$), 'ZD422: invalid input',
  'a missing body is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_general_comment('doc-a', '   ') $$), 'ZD422: invalid input',
  'a blank body is refused');

-- The row: no anchor, owner and author from the session, state by who opened it.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, owner_id, created_by, state, anchor IS NULL FROM collaboration.comment_thread
      WHERE id = pg_temp.id('g1') $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'open'::text, true),
  'the general thread takes its scope from the document, its author from the session and has no anchor');
SELECT is((SELECT state FROM collaboration.comment_thread WHERE id = pg_temp.id('g2')), 'answered',
  'a general thread the student opens waits on the teacher, as an anchored one');

-- Reading and answering: the same list, with a null anchor; replies work as on any thread.
SELECT is(pg_temp.ask('ana', $$ SELECT format('%s|%s|%s', comment_position, author_role, anchor IS NULL)
    FROM collaboration.list_comments('doc-a') WHERE thread_id = {g1} $$), '1|teacher|t',
  'Ana reads the teacher''s general comment with a null anchor');
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.reply_comment({g1}, 'Dodat ću ga.') $$), '^[0-9a-f-]{36}$',
  'Ana answers a general thread');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), 'ZD403: forbidden',
  'a stranger reads no general thread either');

-- create_comment still refuses a missing anchor (050 keeps that case); the table refuses a bad one.
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment('doc-a', 'Tekst.', NULL) $$), 'ZD422: invalid input',
  'an anchored comment without an anchor is still refused');
SELECT throws_ok(
  $$ UPDATE collaboration.comment_thread SET anchor = '{"nodeId":"x"}'::jsonb WHERE id = pg_temp.id('g1') $$,
  '23514', NULL, 'the table still refuses an anchor that is not a text anchor');

SELECT * FROM finish();
ROLLBACK;
