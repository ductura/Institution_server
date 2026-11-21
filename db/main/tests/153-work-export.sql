-- SRV-1310 (plan M8.4): the source of the DOCX export of a work, one saved
-- version with the exact bytes of its text, for its owner and the teacher of
-- its assignment. Every person, document, text and hash below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- The export source as one line: found:<revision>:<kind>:<body>, or the
-- outcome itself, or "SQLSTATE: message" for an error.
CREATE FUNCTION pg_temp.export(p_actor text, p_document text DEFAULT 'doc-a', p_revision bigint DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT CASE WHEN outcome = 'found' THEN outcome || ':' || revision || ':' || kind || ':' || body ELSE outcome END
          FROM app.read_work_export(%L, %L::bigint) $q$, p_document, p_revision))
$$;
CREATE FUNCTION pg_temp.req() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id::text FROM evidence.submission_request WHERE document_id = 'doc-a'
$$;
CREATE FUNCTION pg_temp.replay_log() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(format('%s|%s|%s|%s', l.document_id, o.name, r.name, l.reader_role)
                             ORDER BY l.document_id, r.name), '{}')
    FROM audit.access_log l
    JOIN ref o ON o.val = l.owner_id::text
    JOIN ref r ON r.val = l.reader_id::text
   WHERE l.surface = 'replay'
$$;

SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'app.read_work_export(text,bigint)'::regprocedure),
  'ductus_identity v t t', 'the read is a VOLATILE SECURITY DEFINER function of the identity role');
SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'app.work_export_rows(text,bigint)'::regprocedure),
  'ductus_evidence s t t', 'the evidence role owns the one helper that reads checkpoints');
SELECT is(pg_get_function_arguments('app.read_work_export(text,bigint)'::regprocedure),
  'p_document_id text, p_revision bigint DEFAULT NULL::bigint',
  'the read takes only the document and the revision: no role, institution or time');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'evidence', 'USAGE')
  AND NOT has_schema_privilege('ductus_identity', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'the migration leaves no schema right behind');

-- A work with revision 0 only has nothing to export.
SELECT is(pg_temp.export(a.name), 'not_found', a.name || ' gets not_found before the first commit')
FROM (VALUES ('ana'), ('vesna')) AS a (name);

-- Ana commits revisions 1 to 3.
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

-- Without a revision the newest saved version, the same for the owner and the teacher.
SELECT is(left(pg_temp.export(a.name), 14), 'found:3:saved:', a.name || ' reads revision 3 as the newest saved version')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(left(pg_temp.export('ana', 'doc-a', c.revision), 14), c.line, 'Ana reads revision ' || c.revision)
FROM (VALUES (1::bigint, 'found:1:saved:'), (2, 'found:2:saved:')) AS c (revision, line);
SELECT is(pg_temp.export('vesna', 'doc-a', 9), 'not_found', 'a revision that does not exist is not_found');

-- Every other caller gets the answer for a missing document (C-23).
SELECT is(pg_temp.export(a.name), 'not_found', a.name || ' gets the answer for a missing document')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.export(a.name, 'doc-b'), 'not_found', a.name || ' gets not_found for Tomo''s work')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.export(a.name), 'ZD401: not authenticated', a.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS a (name);
SELECT is(pg_temp.export('ana', 'doc-a', b.revision), 'ZD422: invalid input', 'Ana is refused the revision ' || b.revision)
FROM (VALUES (0::bigint), (-5)) AS b (revision);
SELECT is(pg_temp.export('vesna', d.id), 'not_found', 'Vesna gets not_found for ' || d.label)
FROM (VALUES ('doc-nema', 'a missing document'), ('', 'an empty id'), (' doc-a', 'an id with a blank at its edge'),
             ('doc-a' || chr(1), 'an id with a control character'), (repeat('x', 257), 'an id over 256 characters'))
  AS d (id, label);

-- The teacher's successful reads are logged as replay reads; the owner's and the refused ones are not.
SELECT is(pg_temp.replay_log(), ARRAY['doc-a|ana|vesna|teacher'],
  'one row for Vesna on doc-a; no row for an owner or a refused read');

-- The submission of revision 1 cuts the versions there, for both readers.
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)', pg_temp.req(),
  pg_temp.h('d'))), 'recorded', 'fixture: the submission of revision 1 is recorded');
SELECT is(left(pg_temp.export(a.name), 18), 'found:1:submitted:', a.name || ' reads the submitted revision, nothing after')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.export('vesna', 'doc-a', 2), 'not_found', 'a revision after the submission is not_found');

-- Revocation is immediate: a teacher who left the course reads nothing.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna');
SELECT is(pg_temp.export('vesna'), 'not_found', 'Vesna, gone from K1, gets not_found');
SELECT is(left(pg_temp.export('ana'), 18), 'found:1:submitted:', 'Ana still reads her work');

SELECT * FROM finish();
ROLLBACK;
