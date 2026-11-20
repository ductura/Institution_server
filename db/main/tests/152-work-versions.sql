-- SRV-9A (Ductus#2028, c.7041207655): the versions of a work, its saved
-- points and its submission, for its owner and the teacher of its assignment.
-- Every person, document, text and hash below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- The versions as one line, in the order returned: c<revision> for a saved
-- point, s<revision> for the submission (with ! after the deadline); the
-- outcome itself for not_found and empty; "SQLSTATE: message" for an error.
CREATE FUNCTION pg_temp.versions(p_actor text, p_document text DEFAULT 'doc-a', p_before bigint DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT string_agg(CASE WHEN outcome = 'found'
                               THEN left(kind, 1) || revision || CASE WHEN after_deadline THEN '!' ELSE '' END
                               ELSE outcome END, ',' ORDER BY n)
          FROM app.read_work_versions(%L, %L::bigint)
               WITH ORDINALITY AS v (outcome, kind, revision, saved_minute, after_deadline, n) $q$,
    p_document, p_before))
$$;
-- The row count and the first and last version of one page.
CREATE FUNCTION pg_temp.page(p_actor text, p_before bigint DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT count(*) || ' ' || (array_agg(left(kind, 1) || revision ORDER BY n))[1] || ' '
               || (array_agg(left(kind, 1) || revision ORDER BY n DESC))[1]
          FROM app.read_work_versions('doc-a', %L::bigint)
               WITH ORDINALITY AS v (outcome, kind, revision, saved_minute, after_deadline, n) $q$, p_before))
$$;
CREATE FUNCTION pg_temp.req() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id::text FROM evidence.submission_request WHERE document_id = 'doc-a'
$$;
-- The replay rows of the access log, one line each, with names in place of ids.
CREATE FUNCTION pg_temp.replay_log() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(format('%s|%s|%s|%s', l.document_id, o.name, r.name, l.reader_role)
                             ORDER BY l.document_id, r.name), '{}')
    FROM audit.access_log l
    JOIN ref o ON o.val = l.owner_id::text
    JOIN ref r ON r.val = l.reader_id::text
   WHERE l.surface = 'replay'
$$;

-- Shape: one read of the identity role for the web role, one helper of the
-- evidence role for the identity role alone, both with an empty search_path.
SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'app.read_work_versions(text,bigint)'::regprocedure),
  'ductus_identity v t t', 'the read is a VOLATILE SECURITY DEFINER function of the identity role');
SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'app.work_version_rows(text,bigint)'::regprocedure),
  'ductus_evidence s t t', 'the evidence role owns the one helper that reads checkpoints and submissions');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                            'ductus_identity', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['app.read_work_versions(text,bigint)', 'app.work_version_rows(text,bigint)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app app.read_work_versions(text,bigint)'),
            ('ductus_identity app.read_work_versions(text,bigint)'),
            ('ductus_identity app.work_version_rows(text,bigint)'),
            ('ductus_evidence app.work_version_rows(text,bigint)') $$,
  'the web role executes the read, never the helper; only the identity role and the owner execute the helper');
SELECT is(pg_get_function_arguments('app.read_work_versions(text,bigint)'::regprocedure),
  'p_document_id text, p_before_revision bigint DEFAULT NULL::bigint',
  'the read takes only the document and the cursor: no role, institution or time');
SELECT is(pg_get_function_result('app.read_work_versions(text,bigint)'::regprocedure),
  'TABLE(outcome text, kind text, revision bigint, saved_minute timestamp with time zone, after_deadline boolean)',
  'a version is a kind, a revision, a minute and the deadline flag: no text, hash or id');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'evidence', 'USAGE')
  AND NOT has_schema_privilege('ductus_identity', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'the migration leaves no schema right behind');

-- A work with revision 0 only has no version.
SELECT is(pg_temp.versions(a.name), 'empty', a.name || ' reads an empty list before the first commit')
FROM (VALUES ('ana'), ('vesna')) AS a (name);

-- Ana commits revision 1 (text d...d) and requests it, then revisions 2 and 3.
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

-- The same list for the owner and the teacher (rule 5); a request is no submission.
SELECT is(pg_temp.versions(a.name), 'c3,c2,c1', a.name || ' reads the three saved points, newest first')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT bool_and(saved_minute = date_trunc('minute', saved_minute, 'UTC'))::text
                                     FROM app.read_work_versions('doc-a') $$), 'true',
  'every time is a whole minute (D-24)');
SELECT is(pg_temp.versions('ana', 'doc-a', b.before), b.list, 'below revision ' || b.before || ': ' || b.list)
FROM (VALUES (3::bigint, 'c2,c1'), (2, 'c1'), (4, 'c3,c2,c1'), (9007199254740991, 'c3,c2,c1')) AS b (before, list);

-- Every other caller gets the answer for a missing document (C-23).
SELECT is(pg_temp.versions(a.name), 'not_found', a.name || ' gets the answer for a missing document')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.versions(a.name, 'doc-b'), 'not_found', a.name || ' gets not_found for Tomo''s work')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.versions(a.name, 'doc-b'), 'empty', a.name || ' reads Tomo''s work, which has no version')
FROM (VALUES ('tomo'), ('petra')) AS a (name);
SELECT is(pg_temp.versions(a.name), 'ZD401: not authenticated', a.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS a (name);
SELECT is(pg_temp.versions('anon', 'doc-a', 1), 'ZD401: not authenticated', 'the session is checked before the cursor');
SELECT is(pg_temp.versions('ana', 'doc-a', b.before), 'ZD422: invalid input', 'Ana is refused the cursor ' || b.before)
FROM (VALUES (1::bigint), (0), (-5)) AS b (before);
SELECT is(pg_temp.versions('vesna', d.id), 'not_found', 'Vesna gets not_found for ' || d.label)
FROM (VALUES ('doc-nema', 'a missing document'), ('', 'an empty id'), (' doc-a', 'an id with a blank at its edge'),
             ('doc-a' || chr(1), 'an id with a control character'), (repeat('x', 257), 'an id over 256 characters'))
  AS d (id, label);

-- The teacher's reads are logged as replay reads, one row per interval; the
-- owner's and the refused ones are not.
SELECT is(pg_temp.replay_log(), ARRAY['doc-a|ana|vesna|teacher', 'doc-b|tomo|petra|teacher'],
  'one row for Vesna on doc-a and one for Petra on doc-b; no row for an owner or a refused read');
CREATE TRIGGER access_log_refuse_insert BEFORE INSERT ON audit.access_log
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
SELECT is(pg_temp.versions('vesna'), 'ZD403: append-only row', 'when the row cannot be written, Vesna gets no list');
SELECT is(pg_temp.versions('ana'), 'c3,c2,c1', 'the owner''s read writes no row, so it is not affected');
DROP TRIGGER access_log_refuse_insert ON audit.access_log;

-- Pages: 202 saved points give 201 rows, the last only telling that more follow.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'doc-a', pg_temp.id('fak_a'), r, r - 1, pg_temp.id('ana'), pg_temp.sha('izmisljeno-' || r)
  FROM generate_series(4, 202) AS r;
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
SELECT 'doc-a', pg_temp.id('fak_a'), r, 'izmisljeno-' || r FROM generate_series(4, 202) AS r;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT is(pg_temp.page('vesna'), '201 c202 c2', 'the first page is 201 rows, from revision 202 to 2');
SELECT is(pg_temp.page('vesna', 3), '2 c2 c1', 'the next page below revision 3');

-- The submission of revision 1 cuts the saved points there, for both readers.
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)', pg_temp.req(),
  pg_temp.h('d'))), 'recorded', 'fixture: the submission of revision 1 is recorded');
SELECT is(pg_temp.versions(a.name), 's1,c1', a.name || ' reads the submission before its saved point, nothing after')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.versions('vesna', 'doc-a', 2), 's1,c1', 'below revision 2: the submission and its saved point');
SELECT is(
  pg_temp.ask('vesna', $$ SELECT saved_minute::text FROM app.read_work_versions('doc-a') WHERE kind = 'submission' $$),
  pg_temp.ask('ana', $$ SELECT date_trunc('minute', requested_at, 'UTC')::text FROM evidence.submission $$),
  'the submission''s minute is its request instant on the minute');

-- Revocation is immediate: a teacher who left the course reads nothing.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna');
SELECT is(pg_temp.versions('vesna'), 'not_found', 'Vesna, gone from K1, gets no list');
SELECT is(pg_temp.versions('ana'), 's1,c1', 'Ana still reads her list');

SELECT * FROM finish();
ROLLBACK;
