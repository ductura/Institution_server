-- F4-PM2-R02 (plan M3.3, B-12): the two reads of the reconstruction worker,
-- the list of packages due a checkpoint and the accepted chain of one package.
-- Both run for the worker's own evidence domain only, read and write nothing,
-- and give no person. The texts are stand-ins such as repeat('a', 64); every
-- person, document and package below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.worker(p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask_as('ductus_worker', 'anon', p_sql)
$$;
-- 'package:count' pairs in id order, '-' for no row, or 'CODE: message'.
CREATE FUNCTION pg_temp.due(p_domain text, p_interval integer, p_after text, p_limit integer)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker(format(
    $q$ SELECT coalesce((SELECT string_agg(evidence_package_id || ':' || segment_count, ',' ORDER BY evidence_package_id)
                           FROM app.worker_packages_due_checkpoints(%s, %s, %s, %s)), '-') $q$,
    coalesce(quote_literal(p_domain) || '::uuid', 'NULL::uuid'), coalesce(p_interval::text, 'NULL::integer'),
    coalesce(quote_literal(p_after), 'NULL::text'), coalesce(p_limit::text, 'NULL::integer')))
$$;
-- 'position:first letter of the hash' in order, then '/head letter/' and
-- '/first letter of the starting text or -/', '-' for no row, or 'CODE: message'.
CREATE FUNCTION pg_temp.chain(p_domain text, p_package text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker(format(
    $q$ SELECT coalesce((SELECT string_agg(chain_position || ':' || left(segment_hash, 1), ',' ORDER BY chain_position)
                                || '/' || min(left(head_segment_hash, 1)) || '/' || coalesce(min(left(initial_document, 1)), '-')
                           FROM app.worker_package_chain(%s, %s)), '-') $q$,
    coalesce(quote_literal(p_domain) || '::uuid', 'NULL::uuid'), coalesce(quote_literal(p_package), 'NULL::text')))
$$;

-- C1: the catalogue: read-only definers of the evidence role with an empty
-- search_path, executed by the worker alone.
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('app.worker_packages_due_checkpoints(uuid,integer,text,integer)'::regprocedure,
                      'app.worker_package_chain(uuid,text)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_evidence'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)
             OR p.provolatile <> 's') $$,
  'both reads are STABLE SECURITY DEFINER functions of the evidence role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_identity', 'ductus_retention',
                                              'ductus_auth', 'public']) AS r
       CROSS JOIN unnest(ARRAY['app.worker_packages_due_checkpoints(uuid,integer,text,integer)',
                               'app.worker_package_chain(uuid,text)']) AS f
      WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE') $$,
  ARRAY['ductus_worker app.worker_packages_due_checkpoints(uuid,integer,text,integer)',
        'ductus_worker app.worker_package_chain(uuid,text)'],
  'the worker runs both reads, nobody else, nor PUBLIC');
SELECT is(pg_get_function_result('app.worker_packages_due_checkpoints(uuid,integer,text,integer)'::regprocedure),
  'TABLE(evidence_package_id text, institution_id uuid, segment_count bigint)',
  'the list carries a package id, its institution and its segment count: no person, document or text');
SELECT is(pg_get_function_result('app.worker_package_chain(uuid,text)'::regprocedure),
  'TABLE(chain_position bigint, segment_hash text, head_segment_hash text, initial_document text)',
  'the chain carries positions, hashes and the starting text: no person, document id or institution');
SELECT ok(NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'), 'the migration leaves no schema right behind');

-- Fixture: Ana commits revisions 1 to 3 of doc-a (segments b, c, 9) in d1;
-- Tomo commits revision 1 of doc-b (segment b) in d2. Revision 0 of doc-a has
-- its stored text (repeat('a', 64)), doc-b has none.
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
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
  VALUES ('doc-a', pg_temp.id('fak_a'), 0, repeat('a', 64));
RESET ROLE;

-- C2: the packages due a checkpoint: at least one interval of segments and no
-- checkpoint at the newest due revision, of the worker's own domain only.
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 2, NULL, 10), 'pkg-a:3',
  'pkg-a has 3 segments, so with an interval of 2 it is due');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 3, NULL, 10), 'pkg-a:3',
  'with an interval of 3 it is still due, at revision 3');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 4, NULL, 10), '-',
  'with an interval of 4 it has not grown enough');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d2', 1, NULL, 10), 'pkg-b:1',
  'the domain of Tomo sees only its own package');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d2', 2, NULL, 10), '-',
  'pkg-b has one segment, not two');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 1, 'pkg-a', 10), '-',
  'the cursor excludes the package it names');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 1, '0-before', 10), 'pkg-a:3',
  'a cursor before the package keeps it');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000ff', 1, NULL, 10), '-',
  'an unknown domain gives no row');
SELECT is(pg_temp.worker($$ SELECT app.worker_record_reconstruction_checkpoint(
    '00000000-0000-4000-8000-0000000000d1'::uuid, 'pkg-a', 2, repeat('c', 64), repeat('e', 64)) $$), 'recorded',
  'the worker records the checkpoint at revision 2');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 2, NULL, 10), '-',
  'with the checkpoint at revision 2 written, an interval of 2 has nothing due');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 1, NULL, 10), 'pkg-a:3',
  'an interval of 1 wants the checkpoint at revision 3, which is still missing');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 3, NULL, 10), 'pkg-a:3',
  'an interval of 3 wants revision 3, which is still missing');
SELECT is(pg_temp.worker($$ SELECT app.worker_record_reconstruction_checkpoint(
    '00000000-0000-4000-8000-0000000000d1'::uuid, 'pkg-a', 3, repeat('9', 64), repeat('f', 64)) $$), 'recorded',
  'the worker records the checkpoint at revision 3');
SELECT is(pg_temp.due('00000000-0000-4000-8000-0000000000d1', 1, NULL, 10), '-',
  'with revision 3 written nothing is due at an interval of 1 either');

SELECT is(pg_temp.due(d.domain, d.interval, d.after, d.lim), '22023: invalid worker request',
  'list refused: ' || d.label)
FROM (VALUES
  (NULL, 2, NULL, 10, 'a NULL domain'),
  ('00000000-0000-4000-8000-0000000000d1', NULL, NULL, 10, 'a NULL interval'),
  ('00000000-0000-4000-8000-0000000000d1', 0, NULL, 10, 'an interval of 0'),
  ('00000000-0000-4000-8000-0000000000d1', 100001, NULL, 10, 'an interval over 100000'),
  ('00000000-0000-4000-8000-0000000000d1', 2, NULL, NULL, 'a NULL limit'),
  ('00000000-0000-4000-8000-0000000000d1', 2, NULL, 0, 'a limit of 0'),
  ('00000000-0000-4000-8000-0000000000d1', 2, NULL, 501, 'a limit over 500'),
  ('00000000-0000-4000-8000-0000000000d1', 2, 'Pkg-a', 10, 'an upper-case cursor'),
  ('00000000-0000-4000-8000-0000000000d1', 2, 'pkg/../a', 10, 'a cursor with a path'))
  AS d (domain, interval, after, lim, label);

-- C3: the accepted chain of one package, in order, with its head and its
-- starting text; nothing of another domain, and the same answer for a package
-- that does not exist.
SELECT is(pg_temp.chain('00000000-0000-4000-8000-0000000000d1', 'pkg-a'), '1:b,2:c,3:9/9/a',
  'pkg-a gives its three segments in order, its head and the first letter of its starting text');
SELECT is(pg_temp.chain('00000000-0000-4000-8000-0000000000d2', 'pkg-b'), '1:b/b/-',
  'a package whose revision 0 has no stored text gives NULL for it');
SELECT is(pg_temp.chain('00000000-0000-4000-8000-0000000000d2', 'pkg-a'), '-', 'pkg-a of d1 asked under d2 gives no row');
SELECT is(pg_temp.chain('00000000-0000-4000-8000-0000000000d1', 'pkg-b'), '-', 'pkg-b of d2 asked under d1 gives no row');
SELECT is(pg_temp.chain('00000000-0000-4000-8000-0000000000d1', 'pkg-nema'), '-', 'an unknown package gives no row');
SELECT is(pg_temp.chain(d.domain, d.package), '22023: invalid worker request', 'chain refused: ' || d.label)
FROM (VALUES
  (NULL, 'pkg-a', 'a NULL domain'),
  ('00000000-0000-4000-8000-0000000000d1', NULL, 'a NULL package'),
  ('00000000-0000-4000-8000-0000000000d1', '', 'an empty package id'),
  ('00000000-0000-4000-8000-0000000000d1', 'Pkg-a', 'an upper-case package id'),
  ('00000000-0000-4000-8000-0000000000d1', 'pkg/../b', 'a package id with a path'))
  AS d (domain, package, label);

-- A starting text that no longer hashes to its key is never returned.
ALTER TABLE evidence.document_checkpoint DISABLE TRIGGER evidence_checkpoint_immutable;
UPDATE evidence.document_checkpoint SET body = repeat('z', 64) WHERE document_id = 'doc-a' AND revision = 0;
ALTER TABLE evidence.document_checkpoint ENABLE TRIGGER evidence_checkpoint_immutable;
SELECT is(pg_temp.chain('00000000-0000-4000-8000-0000000000d1', 'pkg-a'), '1:b,2:c,3:9/9/-',
  'a damaged starting text is passed over: the chain comes without it');

-- C4: nobody else reads them, and neither reads or writes anything.
SELECT is(pg_temp.ask('ana', format('SELECT count(*) FROM app.worker_packages_due_checkpoints(%L::uuid, 2, NULL, 10)',
    '00000000-0000-4000-8000-0000000000d1')),
  '42501: permission denied for function worker_packages_due_checkpoints', 'the web role cannot list the due packages');
SELECT is(pg_temp.ask('ana', format('SELECT count(*) FROM app.worker_package_chain(%L::uuid, %L)',
    '00000000-0000-4000-8000-0000000000d1', 'pkg-a')),
  '42501: permission denied for function worker_package_chain', 'the web role cannot read a chain');
SELECT is(pg_temp.ask('anon', format('SELECT count(*) FROM app.worker_package_chain(%L::uuid, %L)',
    '00000000-0000-4000-8000-0000000000d1', 'pkg-a')),
  '42501: permission denied for function worker_package_chain', 'a request without a session cannot read a chain either');
SELECT matches(pg_temp.worker('SELECT count(*) FROM evidence.segment'), '^42501: ',
  'the worker has no way into the segment table itself');

SELECT * FROM finish();
ROLLBACK;
