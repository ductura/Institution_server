-- SRV-1503 (plan M3.3, B-12): reconstruction checkpoints. They are only
-- appended, written and read by the worker of the package's own evidence
-- domain, and the owning student reads only the own ones. The texts are
-- stand-ins such as repeat('e', 64); every person, document and package below
-- is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.worker(p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask_as('ductus_worker', 'anon', p_sql)
$$;
CREATE FUNCTION pg_temp.record(p_domain text, p_package text, p_revision bigint, p_segment text, p_body text)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker(format(
    'SELECT app.worker_record_reconstruction_checkpoint(%s, %s, %s, %s, %s)',
    coalesce(quote_literal(p_domain) || '::uuid', 'NULL::uuid'), coalesce(quote_literal(p_package), 'NULL::text'),
    coalesce(p_revision::text, 'NULL::bigint'), coalesce(quote_literal(p_segment), 'NULL::text'),
    coalesce(quote_literal(p_body), 'NULL::text')))
$$;
-- 'revision:first letter of the text', '-' for no row, or 'CODE: message'.
CREATE FUNCTION pg_temp.read(p_domain text, p_package text, p_revision bigint) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker(format(
    $q$ SELECT coalesce((SELECT revision || ':' || left(body, 1)
                          FROM app.worker_reconstruction_checkpoint(%s, %s, %s)), '-') $q$,
    coalesce(quote_literal(p_domain) || '::uuid', 'NULL::uuid'), coalesce(quote_literal(p_package), 'NULL::text'),
    coalesce(p_revision::text, 'NULL::bigint')))
$$;
CREATE FUNCTION pg_temp.own(p_actor text, p_document text, p_revision bigint) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce((SELECT revision || ':' || left(body, 1)
                          FROM app.read_own_reconstruction_checkpoint(%L, %s)), '-') $q$,
    p_document, p_revision))
$$;

-- C1: the catalogue. The table is the evidence role's, with RLS forced and no
-- privilege for any runtime role; the three RPCs are definers of the evidence
-- role with an empty search_path, the worker's two run by the worker alone and
-- the student's read by the web role alone.
SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
             FROM pg_class c WHERE c.oid = 'evidence.reconstruction_checkpoint'::regclass),
  'the checkpoint table forces RLS and belongs to the evidence role');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'evidence' AND tablename = 'reconstruction_checkpoint' $$,
  ARRAY['evidence_reconstruction_checkpoint_owner ALL to ductus_evidence'],
  'only the owner has a policy on the checkpoint table');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_identity', 'ductus_retention',
                                              'ductus_auth', 'public']) AS r
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      WHERE has_table_privilege(r, 'evidence.reconstruction_checkpoint', p) $$,
  'no runtime role holds a privilege on the checkpoint table');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('app.worker_record_reconstruction_checkpoint(uuid,text,bigint,text,text)'::regprocedure,
                      'app.worker_reconstruction_checkpoint(uuid,text,bigint)'::regprocedure,
                      'app.read_own_reconstruction_checkpoint(text,bigint)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_evidence'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the three checkpoint RPCs are SECURITY DEFINER functions of the evidence role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_identity', 'ductus_retention',
                                              'ductus_auth', 'ductus_app_local', 'ductus_auth_local', 'public']) AS r
       CROSS JOIN unnest(ARRAY['app.worker_record_reconstruction_checkpoint(uuid,text,bigint,text,text)',
                               'app.worker_reconstruction_checkpoint(uuid,text,bigint)',
                               'app.read_own_reconstruction_checkpoint(text,bigint)']) AS f
      WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE')
        AND NOT (r = 'ductus_app_local') $$,
  ARRAY['ductus_worker app.worker_record_reconstruction_checkpoint(uuid,text,bigint,text,text)',
        'ductus_worker app.worker_reconstruction_checkpoint(uuid,text,bigint)',
        'ductus_app app.read_own_reconstruction_checkpoint(text,bigint)'],
  'the worker runs its write and read, the web role the student''s read, nobody else any of them');
SELECT is(pg_get_function_arguments('app.read_own_reconstruction_checkpoint(text,bigint)'::regprocedure),
  'p_document_id text, p_revision bigint', 'the student''s read takes no person or institution');
SELECT ok(NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE'),
  'the migration leaves no schema right behind');

-- Fixture: Ana commits revisions 1 to 3 of doc-a (texts d, e, f; segments b,
-- c, 9) in d1; Tomo commits revision 1 of doc-b (text d, segment b) in d2.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
  repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-2',
    pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
                       p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64)), 'reserved', 'fixture: Ana commits revision 2');
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-3',
    pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
                       p_hash => repeat('9', 64), p_predecessor => repeat('c', 64)),
    2, repeat('e', 64), repeat('f', 64), repeat('9', 64)), 'reserved', 'fixture: Ana commits revision 3');
SELECT is(pg_temp.call('tomo', 'pkg-b', 'request-b1',
    pg_temp.descriptor(p_package => 'pkg-b', p_document => 'doc-b', p_segment => 'segment-b-1'),
    0, repeat('c', 64), repeat('d', 64), repeat('b', 64)), 'reserved', 'fixture: Tomo commits revision 1');

-- C2: the worker records a checkpoint only where the record vouches for it.
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 3), '-',
  'before any checkpoint the read gives no row');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('c', 64), repeat('e', 64)),
  'recorded', 'the worker records revision 2 of pkg-a after segment c');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('c', 64), repeat('e', 64)),
  'exists', 'the same checkpoint again is not a second row');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 3, repeat('9', 64), repeat('e', 64)),
  'mismatch', 'a text that is not the one revision 3 was committed with is refused');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 3, repeat('c', 64), repeat('f', 64)),
  'not_found', 'revision 3 under the segment of revision 2 is no position of the record');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 4, repeat('9', 64), repeat('f', 64)),
  'not_found', 'a revision no receipt issued gives not_found');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d2', 'pkg-a', 3, repeat('9', 64), repeat('f', 64)),
  'not_found', 'pkg-a of d1 written under d2 gives not_found');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-b', 1, repeat('b', 64), repeat('d', 64)),
  'not_found', 'pkg-b of d2 written under d1 gives not_found');
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-nema', 1, repeat('b', 64), repeat('d', 64)),
  'not_found', 'an unknown package gives not_found');
SELECT is((SELECT count(*)::int FROM evidence.reconstruction_checkpoint), 1, 'the refused calls wrote no row');
SELECT is((SELECT content_hash FROM evidence.reconstruction_checkpoint WHERE revision = 2), pg_temp.h('e'),
  'the database computed the hash from the stored bytes');
SELECT is((SELECT principal_id FROM evidence.reconstruction_checkpoint WHERE revision = 2), pg_temp.id('ana'),
  'the person comes from the package');

SELECT is(pg_temp.record(d.domain, d.package, d.revision, d.segment, d.body), '22023: invalid worker request',
  'refused: ' || d.label)
FROM (VALUES
  (NULL, 'pkg-a', 2::bigint, repeat('c', 64), repeat('e', 64), 'a NULL domain'),
  ('00000000-0000-4000-8000-0000000000d1', NULL, 2, repeat('c', 64), repeat('e', 64), 'a NULL package'),
  ('00000000-0000-4000-8000-0000000000d1', 'Pkg-a', 2, repeat('c', 64), repeat('e', 64), 'an upper-case package id'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg/../b', 2, repeat('c', 64), repeat('e', 64), 'a package id with a path'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', NULL, repeat('c', 64), repeat('e', 64), 'a NULL revision'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 0, repeat('c', 64), repeat('e', 64), 'revision 0'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', -1, repeat('c', 64), repeat('e', 64), 'a negative revision'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, NULL, repeat('e', 64), 'a NULL segment hash'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('C', 64), repeat('e', 64), 'an upper-case segment hash'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('c', 63), repeat('e', 64), 'a short segment hash'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('c', 64), NULL, 'a NULL text'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('c', 64), '', 'an empty text'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2, repeat('c', 64), repeat('e', 2097153), 'a text over 2 MiB'))
  AS d (domain, package, revision, segment, body, label);

-- C3: the worker reads the newest checkpoint at or before a revision, of its
-- own package and domain only.
SELECT is(pg_temp.record('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 3, repeat('9', 64), repeat('f', 64)),
  'recorded', 'the worker records revision 3 of pkg-a');
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 3), '3:f', 'revision 3 reads its own checkpoint');
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 9), '3:f',
  'a later revision reads the newest checkpoint');
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 2), '2:e', 'revision 2 never sees revision 3');
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 1), '-', 'revision 1 has none at or before it');
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d2', 'pkg-a', 3), '-', 'pkg-a asked under d2 gives no row');
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-nema', 3), '-', 'an unknown package gives no row');
SELECT is(pg_temp.read(d.domain, d.package, d.revision), '22023: invalid worker request', 'read refused: ' || d.label)
FROM (VALUES
  (NULL, 'pkg-a', 2::bigint, 'a NULL domain'),
  ('00000000-0000-4000-8000-0000000000d1', NULL, 2, 'a NULL package'),
  ('00000000-0000-4000-8000-0000000000d1', '', 2, 'an empty package id'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', NULL, 'a NULL revision'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 0, 'revision 0'))
  AS d (domain, package, revision, label);

-- C4: only appended. Not even the owner changes, removes or empties a row.
CREATE FUNCTION pg_temp.owner(p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'anon', p_sql)
$$;
SELECT is(pg_temp.owner($$ UPDATE evidence.reconstruction_checkpoint SET body = repeat('x', 64) WHERE revision = 2 $$),
  'ZD403: append-only row', 'the owner cannot change a checkpoint');
SELECT is(pg_temp.owner($$ DELETE FROM evidence.reconstruction_checkpoint WHERE revision = 2 $$),
  'ZD403: append-only row', 'the owner cannot remove a checkpoint');
SELECT is(pg_temp.owner($$ TRUNCATE evidence.reconstruction_checkpoint $$),
  'ZD403: append-only row', 'the owner cannot empty the table');
SELECT matches(pg_temp.owner(format($$ INSERT INTO evidence.reconstruction_checkpoint
    (evidence_package_id, institution_id, document_id, principal_id, revision, segment_hash, body)
  VALUES ('pkg-a', %L, 'doc-a', %L, 1, repeat('b', 64), repeat('x', 64)) $$, pg_temp.id('fak_a'), pg_temp.id('ana'))),
  '^23503: ', 'a text that is not the committed one breaks the key to the revision');
SELECT is((SELECT count(*)::int FROM evidence.reconstruction_checkpoint), 2, 'every checkpoint is still there');

-- C5: the owning student reads the own checkpoints; nobody else gets a row.
SELECT is(pg_temp.own('ana', 'doc-a', 3), '3:f', 'Ana reads the newest checkpoint of her document');
SELECT is(pg_temp.own('ana', 'doc-a', 2), '2:e', 'Ana reads the checkpoint at or before revision 2');
SELECT is(pg_temp.own('ana', 'doc-a', 1), '-', 'Ana gets no row before the first checkpoint');
SELECT is(pg_temp.own('dora', 'doc-a', 3), '-', 'Dora, in the same course, does not see Ana''s checkpoint');
SELECT is(pg_temp.own('vesna', 'doc-a', 3), '-', 'the teacher does not read it through the student''s read');
SELECT is(pg_temp.own('iva', 'doc-a', 3), '-', 'the administrator does not read it: the role gives no access');
SELECT is(pg_temp.own('tomo', 'doc-a', 3), '-', 'a student of another institution gets no row');
SELECT is(pg_temp.own('anon', 'doc-a', 3), '-', 'a request without a session gets no row');
SELECT is(pg_temp.own('expired', 'doc-a', 3), '-', 'an expired session of Ana gets no row');
SELECT is(pg_temp.own('ana', 'doc-b', 3), '-', 'Ana does not see Tomo''s document');
SELECT matches(pg_temp.ask('ana', 'SELECT count(*) FROM evidence.reconstruction_checkpoint'), '^42501: ',
  'the web role cannot read the checkpoint table directly');
SELECT matches(pg_temp.worker('SELECT count(*) FROM evidence.reconstruction_checkpoint'), '^42501: ',
  'the worker cannot read the checkpoint table directly');
SELECT is(pg_temp.ask('ana', format('SELECT app.worker_record_reconstruction_checkpoint(%L::uuid, %L, 1, %L, %L)',
    '00000000-0000-4000-8000-0000000000d1', 'pkg-a', repeat('b', 64), repeat('d', 64))),
  '42501: permission denied for function worker_record_reconstruction_checkpoint',
  'the web role cannot write a checkpoint');
SELECT is(pg_temp.ask('ana', format('SELECT count(*) FROM app.worker_reconstruction_checkpoint(%L::uuid, %L, 3)',
    '00000000-0000-4000-8000-0000000000d1', 'pkg-a')),
  '42501: permission denied for function worker_reconstruction_checkpoint',
  'the web role cannot use the worker''s read');
SELECT is(pg_temp.worker('SELECT count(*) FROM app.read_own_reconstruction_checkpoint(''doc-a'', 3)'),
  '42501: permission denied for function read_own_reconstruction_checkpoint',
  'the worker cannot use the student''s read');

-- C6: a checkpoint whose bytes no longer hash to its key is never returned:
-- both reads pass over it to the older one, and the reconstruction then
-- replays the rest of the record from there.
ALTER TABLE evidence.reconstruction_checkpoint DISABLE TRIGGER reconstruction_checkpoint_immutable;
UPDATE evidence.reconstruction_checkpoint SET body = repeat('z', 64) WHERE revision = 3;
ALTER TABLE evidence.reconstruction_checkpoint ENABLE TRIGGER reconstruction_checkpoint_immutable;
SELECT is(pg_temp.read('00000000-0000-4000-8000-0000000000d1', 'pkg-a', 3), '2:e',
  'the worker passes over a damaged checkpoint to the older one');
SELECT is(pg_temp.own('ana', 'doc-a', 3), '2:e', 'so does the student''s read');

SELECT * FROM finish();
ROLLBACK;
