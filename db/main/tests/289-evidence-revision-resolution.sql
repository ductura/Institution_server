-- F4-EDI-R05-SRV (B1): the resolution of a revision committed over a conflict
-- (20261220870000). Acceptance: (1) the 11-argument app.commit_evidence_segment
-- takes NULL or exactly {kind: "keep_local", conflictBaseRevision: M} with
-- 0 <= M < the expected revision (20261220900000: M equal to it too is
-- refused); anything else is invalid and writes nothing; (2) a resolution is stored only with a reserved commit, never with
-- a refused one; (3) a retry must send the same resolution, absence included;
-- (4) the row is append only and no runtime role reaches the table;
-- (5) a row that cannot be written undoes the commit; (6) the owner and the
-- teacher read the resolutions through app.read_replay_resolutions, the
-- teacher's read is logged in audit.access_log, anyone else reads none, and
-- the submission cuts the read. Every person, document and text below is
-- invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- The 11-argument acceptance; p_resolution NULL sends SQL NULL.
CREATE FUNCTION pg_temp.call5(
  p_actor text, p_package text, p_request text, p_descriptor jsonb,
  p_revision bigint, p_initial text, p_final text, p_payload_hash text, p_resolution jsonb,
  p_column text DEFAULT 'outcome'
) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT %I::text FROM app.commit_evidence_segment(%L, %L, %s, %L, %L, %L::jsonb, %L, %L, %L, NULL::jsonb, %L::jsonb)',
    p_column, p_package, p_request, p_revision, pg_temp.sha(p_initial), pg_temp.sha(p_final),
    p_descriptor::text, p_payload_hash, 'synthetic://' || p_package || '/' || p_request, p_final,
    p_resolution::text
  ))
$$;
CREATE FUNCTION pg_temp.keep(p_base bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('kind', 'keep_local', 'conflictBaseRevision', p_base)
$$;
-- The descriptors of Ana's segments 2 and 3 of doc-a.
CREATE FUNCTION pg_temp.seg2() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
                            p_hash => repeat('c', 64), p_predecessor => repeat('b', 64))
$$;
CREATE FUNCTION pg_temp.seg3() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
                            p_hash => repeat('9', 64), p_predecessor => repeat('c', 64))
$$;
-- The stored rows, "revision:base", as the owner sees them.
CREATE FUNCTION pg_temp.stored() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', $q$ SELECT coalesce(string_agg(
      revision || ':' || conflict_base_revision, ',' ORDER BY revision), '') FROM evidence.revision_resolution $q$)
$$;
CREATE FUNCTION pg_temp.receipts(p_like text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', format($q$ SELECT count(*)::text FROM evidence.receipt
    WHERE client_request_id LIKE %L $q$, p_like))
$$;
-- What a reader gets: "first letter of the segment hash:base", or "-".
CREATE FUNCTION pg_temp.marks(p_actor text, p_document text DEFAULT 'doc-a') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT coalesce(string_agg(left(segment_hash, 1) || ':' || conflict_base_revision,
      ',' ORDER BY conflict_base_revision), '-') FROM app.read_replay_resolutions(%L) $q$, p_document))
$$;
CREATE FUNCTION pg_temp.replay_log() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(format('%s|%s|%s|%s', l.document_id, o.name, r.name, l.reader_role)
                             ORDER BY l.document_id, r.name), '{}')
    FROM audit.access_log l
    JOIN ref o ON o.val = l.owner_id::text
    JOIN ref r ON r.val = l.reader_id::text
   WHERE l.surface = 'replay'
$$;
CREATE FUNCTION pg_temp.req() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id::text FROM evidence.submission_request WHERE document_id = 'doc-a'
$$;

-- 0. Catalogue.
SELECT is((SELECT format('%s|%s|%s|%s', proowner::regrole, prosecdef, provolatile, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb,jsonb)'::regprocedure),
  'ductus_evidence|t|v|t', 'the 11-argument acceptance: evidence owner, SECURITY DEFINER, VOLATILE, empty search_path');
SELECT is(pg_get_function_result('app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb,jsonb)'::regprocedure),
  replace(pg_get_function_result('app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb)'::regprocedure),
          'last_sequence_to bigint)', 'last_sequence_to bigint, resolution jsonb)'),
  'it returns what the 10-argument acceptance returns, and the resolution');
SELECT is((SELECT pronargdefaults FROM pg_proc
    WHERE oid = 'app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb,jsonb)'::regprocedure),
  0::smallint, 'no argument has a default, so no call reaches it by accident');
SELECT is((SELECT format('%s|%s|%s|%s', proowner::regrole, prosecdef, provolatile, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'app.replay_resolution_marks(text,text[])'::regprocedure),
  'ductus_evidence|t|s|t', 'the helper: evidence owner, SECURITY DEFINER, STABLE, empty search_path');
SELECT is((SELECT format('%s|%s|%s|%s', proowner::regrole, prosecdef, provolatile, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'app.read_replay_resolutions(text)'::regprocedure),
  'ductus_identity|t|v|t', 'the read: identity owner, SECURITY DEFINER, VOLATILE, empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                            'ductus_identity', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      CROSS JOIN unnest(ARRAY['app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb,jsonb)',
                              'app.read_replay_resolutions(text)', 'app.replay_resolution_marks(text,text[])']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb,jsonb)'),
            ('ductus_evidence app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb,jsonb)'),
            ('ductus_app app.read_replay_resolutions(text)'), ('ductus_identity app.read_replay_resolutions(text)'),
            ('ductus_identity app.replay_resolution_marks(text,text[])'),
            ('ductus_evidence app.replay_resolution_marks(text,text[])') $$,
  'the web role executes the acceptance and the read, never the helper; the owners besides');
SELECT is((SELECT concat_ws(' ', pg_get_userbyid(c.relowner), c.relrowsecurity::text, c.relforcerowsecurity::text)
             FROM pg_class c WHERE c.oid = 'evidence.revision_resolution'::regclass),
  'ductus_evidence true true', 'the resolution table: evidence owner and forced RLS');
SELECT bag_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polroles::regrole[]::text
       FROM pg_policy WHERE polrelid = 'evidence.revision_resolution'::regclass $$,
  ARRAY['evidence_revision_resolution_owner * {ductus_evidence}'], 'only the owner''s policy');
SELECT is_empty(
  $$ SELECT r || ' ' || p
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      WHERE has_table_privilege(r, 'evidence.revision_resolution', p) $$,
  'besides the owner nobody reads or writes the resolution table directly; the client only through the RPC');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'evidence', 'USAGE')
  AND NOT has_schema_privilege('ductus_identity', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE'),
  'the migration leaves no schema right behind');

-- 1. Revision 1 without a resolution; revision 2 over a conflict with revision 0.
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
    repeat('b', 64), NULL), 'reserved', 'a commit without a resolution is accepted');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
    repeat('b', 64), NULL, 'resolution'), NULL, 'its retry answers no resolution');
SELECT is(pg_temp.stored(), '', 'and none is stored');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
    repeat('b', 64), pg_temp.keep(0)), 'invalid', 'its retry with a resolution is invalid: no base lies below revision 0');
-- A commit without a resolution on a later base: Tomo's revisions 1 and 2 of
-- doc-b. A base below revision 1 exists (0), so its retry with a resolution
-- reaches the idempotency check.
SELECT is(pg_temp.call5('tomo', 'pkg-b', 'tb-1',
    pg_temp.descriptor(p_package => 'pkg-b', p_document => 'doc-b', p_segment => 'segment-b-1'),
    0, repeat('c', 64), repeat('d', 64), repeat('b', 64), NULL), 'reserved', 'fixture: Tomo commits revision 1');
SELECT is(pg_temp.call5('tomo', 'pkg-b', 'tb-2',
    pg_temp.descriptor(p_package => 'pkg-b', p_document => 'doc-b', p_segment => 'segment-b-2', p_sequence_from => 2,
                       p_sequence_to => 2, p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), NULL), 'reserved',
  'fixture: Tomo commits revision 2 without a resolution');
SELECT is(pg_temp.call5('tomo', 'pkg-b', 'tb-2',
    pg_temp.descriptor(p_package => 'pkg-b', p_document => 'doc-b', p_segment => 'segment-b-2', p_sequence_from => 2,
                       p_sequence_to => 2, p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), pg_temp.keep(0)), 'idempotency_conflict',
  'its retry with a resolution is an idempotency conflict');
SELECT is(pg_temp.stored(), '', 'and none is stored');

SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), pg_temp.keep(0)), 'reserved', 'revision 2 committed over a conflict with revision 0 is accepted');
SELECT is(pg_temp.stored(), '2:0', 'the resolution is stored with revision 2');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$
    SELECT (x.created_at = d.created_at AND x.receipt_id = r.id AND x.principal_id = r.principal_id
            AND x.evidence_package_id = 'pkg-a' AND x.document_id = 'doc-a' AND x.kind = 'keep_local')::text
      FROM evidence.revision_resolution x
      JOIN evidence.document_revision d ON d.document_id = x.document_id AND d.institution_id = x.institution_id
                                       AND d.revision = x.revision
      JOIN evidence.receipt r ON r.client_request_id = 'r-2' $$),
  'true', 'the row names the receipt, package, document and student of the commit and the time of its revision');

-- 2. Retries.
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), pg_temp.keep(0)), 'duplicate_pending', 'a retry with the same resolution returns the receipt');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), pg_temp.keep(0), 'resolution'), '{"kind": "keep_local", "conflictBaseRevision": 0}',
  'and the stored resolution');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), '{"conflictBaseRevision": 0.0, "kind": "keep_local"}'::jsonb), 'duplicate_pending',
  'the same resolution written otherwise is the same');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), NULL), 'idempotency_conflict', 'a retry without the resolution is an idempotency conflict');
-- Revision 2 sits on base 1, so 0 is its only valid base; a retry with another
-- base is in section 6, on revision 3.
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), pg_temp.keep(1)), 'invalid', 'a retry with the base equal to the expected revision is invalid');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-2', pg_temp.seg2(), 1, repeat('d', 64), repeat('e', 64),
    repeat('c', 64), pg_temp.keep(1), 'receipt_id'), NULL, 'and returns no receipt');
SELECT is(pg_temp.stored(), '2:0', 'no retry changes the row');

-- 3. A malformed resolution is invalid and writes nothing.
SELECT is(pg_temp.call5('ana', 'pkg-a', 'bad-' || v.n, pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), v.resolution), 'invalid', 'refused: ' || v.why)
FROM (VALUES
  (1, '[]'::jsonb, 'an array'),
  (2, '"keep_local"'::jsonb, 'a string'),
  (3, 'null'::jsonb, 'a JSON null'),
  (4, '{}'::jsonb, 'an empty object'),
  (5, '{"kind": "keep_local"}'::jsonb, 'no base'),
  (6, '{"conflictBaseRevision": 1}'::jsonb, 'no kind'),
  (7, '{"kind": "keep_remote", "conflictBaseRevision": 1}'::jsonb, 'another kind'),
  (8, '{"kind": "KEEP_LOCAL", "conflictBaseRevision": 1}'::jsonb, 'the kind in capitals'),
  (9, '{"kind": "keep_local", "conflictBaseRevision": 1, "note": "x"}'::jsonb, 'a third key'),
  (10, '{"kind": "keep_local", "conflictBaseRevision": "1"}'::jsonb, 'the base as a string'),
  (11, '{"kind": "keep_local", "conflictBaseRevision": null}'::jsonb, 'a null base'),
  (12, '{"kind": "keep_local", "conflictBaseRevision": 1.5}'::jsonb, 'a fractional base'),
  (13, '{"kind": "keep_local", "conflictBaseRevision": -1}'::jsonb, 'a negative base'),
  (14, '{"kind": "keep_local", "conflictBaseRevision": 3}'::jsonb, 'the base of the revision being made'),
  (15, '{"kind": "keep_local", "conflictBaseRevision": 9}'::jsonb, 'a base in the future'),
  (16, '{"kind": "keep_local", "conflictBaseRevision": 1e30}'::jsonb, 'a base beyond any revision'),
  (17, '{"kind": "keep_local", "conflictBaseRevision": [1]}'::jsonb, 'the base in an array'),
  (18, '{"kind": "keep_local", "conflictBaseRevision": 2}'::jsonb, 'the base equal to the expected revision'),
  (19, '{"kind": "keep_local", "conflictBaseRevision": 2.0}'::jsonb, 'the base equal to the expected revision, written as 2.0')
) AS v (n, resolution, why)
ORDER BY v.n;
SELECT is(pg_temp.receipts('bad-%'), '0', 'the refused commits leave no receipt');
SELECT is(pg_temp.stored(), '2:0', 'and no resolution');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT current_revision::text FROM evidence.document WHERE id = 'doc-a' $$),
  '2', 'nor a revision');

-- 4. A refused commit stores no resolution.
SELECT is(pg_temp.call5('tomo', 'pkg-a', 'no-foreign', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(1)), 'unauthorized', 'another student cannot commit into Ana''s package');
SELECT is(pg_temp.call5('anon', 'pkg-a', 'no-anon', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), '[]'::jsonb), 'unauthorized', 'no session is unauthorized before the resolution is looked at');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'no-stale', pg_temp.seg3(), 1, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(0)), 'stale_base', 'a resolution on an old base is still stale');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'no-stale', pg_temp.seg3(), 1, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(0), 'current_revision'), '2', 'and answers the current revision');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'no-stale', pg_temp.seg3(), 1, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(0), 'resolution'), NULL, 'and no resolution');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'no-chain',
    pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
                       p_hash => repeat('9', 64), p_predecessor => repeat('b', 64)),
    2, repeat('e', 64), repeat('f', 64), repeat('9', 64), pg_temp.keep(1)), 'chain_conflict',
  'a resolution on another chain head is a chain conflict');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'no-gap', pg_temp.seg3(), 2, repeat('x', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(1)), 'not_continuous', 'a resolution on another text is not continuous');
SELECT is(pg_temp.receipts('no-%'), '0', 'the refused commits leave no receipt');
SELECT is(pg_temp.stored(), '2:0', 'and no resolution');

-- 5. A row that cannot be written undoes the commit (one savepoint).
ALTER TABLE evidence.revision_resolution ADD CONSTRAINT revision_resolution_test_refuse CHECK (conflict_base_revision > 100) NOT VALID;
SELECT is(pg_temp.call5('ana', 'pkg-a', 'undo-3', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(1)), 'invalid', 'when the resolution cannot be stored, the commit is invalid');
SELECT is(pg_temp.receipts('undo-%'), '0', 'and leaves no receipt');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT current_revision::text FROM evidence.document WHERE id = 'doc-a' $$),
  '2', 'nor a revision');
ALTER TABLE evidence.revision_resolution DROP CONSTRAINT revision_resolution_test_refuse;

-- 6. Ana requests revision 2, then commits revision 3 over a conflict with revision 1.
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 2) $$), 'requested',
  'fixture: Ana requests revision 2');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-3', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(1)), 'reserved', 'revision 3 committed over a conflict with revision 1 is accepted');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-3', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(2)), 'invalid',
  'its retry with the base equal to the expected revision is refused before the retry is looked at');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-3', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(1)), 'duplicate_pending', 'and its retry with the same base still returns the receipt');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-3', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(0)), 'idempotency_conflict', 'a retry with another base is an idempotency conflict');
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-3', pg_temp.seg3(), 2, repeat('e', 64), repeat('f', 64),
    repeat('9', 64), pg_temp.keep(0), 'receipt_id'), NULL, 'and returns no receipt');
SELECT is(pg_temp.stored(), '2:0,3:1', 'both resolutions are stored');

-- 7. Append only, for the owner too; no runtime role writes directly.
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ UPDATE evidence.revision_resolution
    SET conflict_base_revision = 1 RETURNING 'changed' $$),
  'ZD403: append-only row', 'the owner cannot change a resolution');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ DELETE FROM evidence.revision_resolution RETURNING 'deleted' $$),
  'ZD403: append-only row', 'the owner cannot delete a resolution');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', 'TRUNCATE evidence.revision_resolution'),
  'ZD403: append-only row', 'the owner cannot empty the resolution table');
SELECT is(left(pg_temp.ask_as(r.role, 'ana', s.stmt), 6), '42501:', r.role || ' is refused: ' || s.label)
FROM (VALUES ('ductus_app'), ('ductus_worker'), ('ductus_retention'), ('ductus_identity'), ('ductus_auth'))
  AS r (role)
CROSS JOIN (VALUES
  ('SELECT count(*)::text FROM evidence.revision_resolution', 'a read'),
  ($$ INSERT INTO evidence.revision_resolution SELECT * FROM evidence.revision_resolution LIMIT 0 RETURNING 'x' $$, 'a write'),
  ($$ UPDATE evidence.revision_resolution SET conflict_base_revision = 0 RETURNING 'x' $$, 'a change'),
  ($$ DELETE FROM evidence.revision_resolution RETURNING 'x' $$, 'a delete')
) AS s (stmt, label);
SELECT is(pg_temp.stored(), '2:0,3:1', 'nothing changed');

-- 8. The read: the owner and the teacher, nobody else.
SELECT is(pg_temp.marks(a.name), 'c:0,9:1', a.name || ' reads both resolutions with their segments')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.marks(a.name), '-', a.name || ' reads no resolution of doc-a, as for a missing document')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.marks('tomo', 'doc-b'), '-', 'Tomo''s own work has no resolution');
SELECT is(pg_temp.marks(a.name), 'ZD401: not authenticated', a.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired')) AS a (name);
SELECT is(pg_temp.marks('vesna', d.id), '-', 'Vesna reads nothing for ' || d.label)
FROM (VALUES ('doc-nema', 'a missing document'), ('', 'an empty id'), (' doc-a', 'an id with a blank at its edge'),
             ('doc-a' || chr(1), 'an id with a control character'), (repeat('x', 257), 'an id over 256 characters'))
  AS d (id, label);
SELECT is(pg_temp.replay_log(), ARRAY['doc-a|ana|vesna|teacher'],
  'the teacher''s read is logged in audit.access_log as replay; the owner''s and every refused read are not');

-- 9. The submission of revision 2 cuts the read and closes the package.
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)', pg_temp.req(),
  pg_temp.h('e'))), 'recorded', 'fixture: the submission of revision 2 is recorded');
SELECT is(pg_temp.marks(a.name), 'c:0', a.name || ' reads only the resolution up to the submitted revision')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.call5('ana', 'pkg-a', 'r-4',
    pg_temp.descriptor(p_segment => 'segment-a-4', p_sequence_from => 4, p_sequence_to => 4,
                       p_hash => repeat('8', 64), p_predecessor => repeat('9', 64)),
    3, repeat('f', 64), repeat('1', 64), repeat('8', 64), pg_temp.keep(2)), 'not_accepting',
  'after the submission a commit with a resolution is not accepted');
SELECT is(pg_temp.stored(), '2:0,3:1', 'and stores nothing');

SELECT * FROM finish();
ROLLBACK;
