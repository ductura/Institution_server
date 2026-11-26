-- SRV-ED43-DORADA-POSALJI (Ductus#2058, BLOK ED-43): the student owner sends
-- the revision for review (collaboration.send_revision, 20261220180000). The
-- table and its grants, who may send, the round, the repeated send that never
-- skips a round, the message rule, the submitted work and the retention
-- delete. Personas of institution.inc and evidence-acceptance.inc, all
-- invented: Ana writes doc-a in Vesna's course K1 (fak-a), Dora is another
-- student of K1, Marko teaches K2, Tomo writes doc-b in fak-b.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Ana's document has revisions up to 10, as in 112.
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'doc-a', pg_temp.id('fak_a'), n, n - 1, pg_temp.id('ana'), pg_temp.h('a') FROM generate_series(1, 10) AS n;
UPDATE evidence.document SET current_revision = 10 WHERE id = 'doc-a';
RESET ROLE;

INSERT INTO ref VALUES
  ('anchor', '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}');

-- A send as one line: the round, or the error.
CREATE FUNCTION pg_temp.send(p_actor text, p_document text, p_message text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT round::text FROM collaboration.send_revision(%L, %L)', p_document, p_message))
$$;
-- A new request of Vesna on Ana's document; its id.
CREATE FUNCTION pg_temp.open_request() RETURNS uuid LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', $q$ SELECT request_id::text FROM collaboration.create_revision_request('doc-a', {anchor},
    'Ovdje nedostaje izvor.', 0) $q$)::uuid
$$;
CREATE FUNCTION pg_temp.seq(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT row_seq FROM collaboration.revision_request WHERE id = p_id
$$;
CREATE FUNCTION pg_temp.sends() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(concat_ws('|', round, coalesce(message, '-')), ';' ORDER BY round), 'none')
    FROM collaboration.revision_send WHERE document_id = 'doc-a'
$$;

-- 1. Catalogue: forced RLS, only the owner's policy, no runtime grant; the
-- definer RPC only for the application.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND ARRAY(SELECT p.policyname::text FROM pg_policies p
      WHERE p.schemaname = 'collaboration' AND p.tablename = 'revision_send'
        AND p.roles = ARRAY['ductus_identity'::name] AND p.cmd = 'ALL') = ARRAY['revision_send_owner']
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'revision_send has forced RLS, only the identity owner has access and no runtime role has a grant')
  FROM pg_class c WHERE c.oid = to_regclass('collaboration.revision_send');
SELECT ok(p.prosecdef AND p.proowner = 'ductus_identity'::regrole AND 'search_path=""' = ANY(p.proconfig)
    AND has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_retention', p.oid, 'EXECUTE'),
  'send_revision is a definer RPC with an empty path, only for the application')
  FROM pg_proc p WHERE p.oid = to_regprocedure('collaboration.send_revision(text,text)');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT throws_ok($$ SET LOCAL ROLE ductus_app; INSERT INTO collaboration.revision_send
    (institution_id, assignment_id, owner_id, document_id, round, answered_seq)
    VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'doc-a', 1, 1) $$,
  '42501', NULL, 'the application cannot write a round directly');
RESET ROLE;

-- 2. Nothing open: no round.
SELECT is(pg_temp.send('ana', 'doc-a'), 'ZD409: not allowed', 'a send without an open request is not allowed');
SELECT is(pg_temp.sends(), 'none', 'and writes nothing');

-- 3. Who: only the student owner; the teacher 403, everybody else 404.
INSERT INTO ref SELECT 'r1', pg_temp.open_request();
SELECT is(pg_temp.send('vesna', 'doc-a', 'Poslano.'), 'ZD403: forbidden', 'the teacher of the work cannot send');
SELECT is(pg_temp.send(p.actor, p.doc), 'ZD404: not found', p.why)
  FROM (VALUES ('dora', 'doc-a', 'another student of the course reads the work as missing'),
               ('marko', 'doc-a', 'a teacher of another course reads the work as missing'),
               ('tomo', 'doc-a', 'a student of another institution reads the work as missing'),
               ('ana', 'doc-b', 'a work of another institution reads as missing'),
               ('ana', 'doc-nema', 'a work that does not exist is not found'),
               ('ana', '', 'an empty id is not found')) p(actor, doc, why);
SELECT is(pg_temp.sends(), 'none', 'no refused send wrote anything');

-- 4. The message rule: as every revision text.
SELECT is(pg_temp.send('ana', 'doc-a', m.text), 'ZD422: invalid input', m.why)
  FROM (VALUES ('', 'an empty message (send null for none)'),
               ('   ', 'a message of blanks'),
               (repeat('a', 2001), 'a message above 2000 characters'),
               (E'a\u0007b', 'a control character'),
               (E'a\u202Eb', 'a bidi override'),
               (E'e\u0301', 'a message that is not NFC')) m(text, why);
SELECT is(pg_temp.sends(), 'none', 'no invalid message wrote anything');

-- 5. The first round, the repeated send, the next round.
SELECT is(pg_temp.send('ana', 'doc-a', 'Dodala sam izvore.'), '1', 'the owner sends round 1');
SELECT is(pg_temp.send('ana', 'doc-a', 'Još jednom.'), 'ZD409: not allowed', 'sending again with nothing new open is not allowed');
SELECT is(pg_temp.send('ana', 'doc-a'), 'ZD409: not allowed', 'and again without a message');
SELECT is(pg_temp.sends(), '1|Dodala sam izvore.', 'the repeated send skipped no round');
-- Answering the open request moves its counter but opens nothing new.
SELECT is(pg_temp.ask('ana', format($q$ SELECT outcome FROM collaboration.respond_revision_request(%L, %s, 'done', 'Dodano.', 5) $q$,
  (SELECT val FROM ref WHERE name = 'r1'), pg_temp.seq((SELECT val FROM ref WHERE name = 'r1')::uuid))), 'applied',
  'fixture: Ana answers the request');
SELECT is(pg_temp.send('ana', 'doc-a'), 'ZD409: not allowed', 'an answered request does not start a round');
-- The teacher reopens it: the next round.
SELECT is(pg_temp.ask('vesna', format($q$ SELECT outcome FROM collaboration.reopen_revision_request(%L, %s, 'Nova uputa.', 5) $q$,
  (SELECT val FROM ref WHERE name = 'r1'), pg_temp.seq((SELECT val FROM ref WHERE name = 'r1')::uuid))), 'applied',
  'fixture: Vesna reopens the request');
SELECT is(pg_temp.send('ana', 'doc-a'), '2', 'a reopened request starts round 2, without a message');
SELECT is(pg_temp.send('ana', 'doc-a'), 'ZD409: not allowed', 'round 2 is not sent twice');
-- A new request: round 3.
INSERT INTO ref SELECT 'r2', pg_temp.open_request();
SELECT is(pg_temp.send('ana', 'doc-a', 'Treća runda.'), '3', 'a new request starts round 3');
SELECT is(pg_temp.sends(), '1|Dodala sam izvore.;2|-;3|Treća runda.', 'one row per round, in order, the message as sent');
SELECT is((SELECT count(*)::int FROM collaboration.revision_send WHERE document_id = 'doc-a'
             AND owner_id = pg_temp.id('ana') AND assignment_id = pg_temp.id('z1') AND institution_id = pg_temp.id('fak_a')),
  3, 'every round carries the scope of the work');

-- 6. A withdrawn request is not open.
SELECT is(pg_temp.ask('vesna', format($q$ SELECT outcome FROM collaboration.withdraw_revision_request(%L, %s) $q$,
  (SELECT val FROM ref WHERE name = 'r2'), pg_temp.seq((SELECT val FROM ref WHERE name = 'r2')::uuid))), 'applied',
  'fixture: Vesna withdraws the new request');
INSERT INTO ref SELECT 'r3', pg_temp.open_request();
SELECT is(pg_temp.ask('vesna', format($q$ SELECT outcome FROM collaboration.withdraw_revision_request(%L, %s) $q$,
  (SELECT val FROM ref WHERE name = 'r3'), pg_temp.seq((SELECT val FROM ref WHERE name = 'r3')::uuid))), 'applied',
  'fixture: Vesna withdraws a request opened after round 3');
SELECT is(pg_temp.send('ana', 'doc-a'), 'ZD409: not allowed', 'a withdrawn request starts no round');

-- 7. A submitted work: no round, even with a new open request.
INSERT INTO ref SELECT 'r4', pg_temp.open_request();
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 10, repeat('a', 64), repeat('d', 64),
  repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 11');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 11) $$), 'requested', 'fixture: Ana requests revision 11');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
    (SELECT id FROM evidence.submission_request WHERE document_id = 'doc-a'), pg_temp.h('d'))), 'recorded',
  'fixture: the submission is recorded');
SELECT is(pg_temp.send('ana', 'doc-a'), 'ZD409: not allowed', 'a submitted work sends no round');
SELECT is(pg_temp.send('vesna', 'doc-a'), 'ZD403: forbidden', 'the teacher is still refused first');
SELECT is(pg_temp.sends(), '1|Dodala sam izvore.;2|-;3|Treća runda.', 'nothing was written after the submission');

-- 8. The retention delete removes the rounds with the requests.
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_revision_requests('doc-a', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is(pg_temp.sends(), 'none', 'the retention delete removes the rounds of the work');
SELECT is((SELECT count(*)::int FROM collaboration.revision_request WHERE document_id = 'doc-a'), 0,
  'and the requests, as before');

SELECT * FROM finish();
ROLLBACK;
