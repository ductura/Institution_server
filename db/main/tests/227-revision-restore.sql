-- INT-21 C: the server records that a revision restored an earlier one. Only
-- the owning student records, and only against a later revision of her own
-- whose committed hash is that of the revision restored from; every other
-- caller gets not_found. The answer names the revision the record is against
-- (outcome@revision below). The versions list shows the revision restored from.
-- Every person, document, text and hash below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.restore(p_actor text, p_from bigint, p_document text DEFAULT 'doc-a')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT string_agg(outcome || coalesce('@' || revision, ''), ',')
          FROM app.record_revision_restore(%L, %L::bigint) $q$,
    p_document, p_from))
$$;
-- The versions as one line, newest first: c<revision> for a saved point,
-- with <N when it restored revision N; the outcome itself otherwise.
CREATE FUNCTION pg_temp.versions(p_actor text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT string_agg(CASE WHEN outcome = 'found'
                           THEN left(kind, 1) || revision || coalesce('<' || restored_from_revision, '')
                           ELSE outcome END, ',' ORDER BY n)
      FROM app.read_work_versions('doc-a')
           WITH ORDINALITY AS v (outcome, kind, revision, saved_minute, after_deadline, restored_from_revision, n) $q$)
$$;
CREATE FUNCTION pg_temp.records() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(revision || '<' || restored_from_revision, ',' ORDER BY revision), '')
    FROM evidence.revision_restore
$$;
-- Ana commits revision p_revision from text p_from to text p_to (letters).
CREATE FUNCTION pg_temp.commit(p_revision bigint, p_from text, p_to text, p_segment_hash text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.call('ana', 'pkg-a', 'request-' || p_revision,
    pg_temp.descriptor(p_segment => 'segment-a-' || p_revision, p_sequence_from => p_revision,
                       p_sequence_to => p_revision, p_hash => repeat(p_segment_hash, 64),
                       p_predecessor => CASE WHEN p_revision > 1 THEN repeat(
                         (ARRAY['b', 'c', '7', '8', '9'])[(p_revision - 1)::int], 64) END),
    p_revision - 1, repeat(p_from, 64), repeat(p_to, 64), repeat(p_segment_hash, 64))
$$;

-- Shape: the table belongs to the evidence role, with forced RLS and no
-- right for any runtime role; the entry is the identity role's, for the web
-- role; the helper is the evidence role's, for the identity role alone.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole,
  'the record of a restore has forced RLS and belongs to the evidence role')
  FROM pg_class c WHERE c.oid = 'evidence.revision_restore'::regclass;
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                            'ductus_identity', 'ductus_test_stranger', 'public']) AS r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
      WHERE has_table_privilege(r, 'evidence.revision_restore', p) $$,
  'no runtime role reads or writes the record directly');
SELECT is(
  (SELECT string_agg(format('%s %s %s', policyname, cmd, roles::text), ';')
     FROM pg_policies WHERE schemaname = 'evidence' AND tablename = 'revision_restore'),
  'evidence_revision_restore_owner ALL {ductus_evidence}',
  'the one policy is the owner''s');
SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'app.record_revision_restore(text,bigint)'::regprocedure),
  'ductus_identity v t t', 'the entry is a VOLATILE SECURITY DEFINER function of the identity role');
SELECT is(
  (SELECT format('%s %s %s %s', proowner::regrole, provolatile, prosecdef, 'search_path=""' = ANY (proconfig))
     FROM pg_proc WHERE oid = 'app.revision_restore_record(text,bigint)'::regprocedure),
  'ductus_evidence v t t', 'the helper that writes is the evidence role''s');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                            'ductus_identity', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['app.record_revision_restore(text,bigint)', 'app.revision_restore_record(text,bigint)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app app.record_revision_restore(text,bigint)'),
            ('ductus_identity app.record_revision_restore(text,bigint)'),
            ('ductus_identity app.revision_restore_record(text,bigint)'),
            ('ductus_evidence app.revision_restore_record(text,bigint)') $$,
  'the web role executes the entry, never the helper');
SELECT ok(NOT has_function_privilege('public', 'app.record_revision_restore(text,bigint)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'app.revision_restore_record(text,bigint)', 'EXECUTE'),
  'PUBLIC executes neither');
SELECT is(pg_get_function_arguments('app.record_revision_restore(text,bigint)'::regprocedure),
  'p_document_id text, p_from_revision bigint',
  'the client names the document and the revision restored from, never the new revision');
SELECT is(pg_get_function_result('app.record_revision_restore(text,bigint)'::regprocedure),
  'TABLE(outcome text, revision bigint)', 'the answer is one outcome and the revision it is against');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
  AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE')
  AND NOT has_schema_privilege('ductus_identity', 'evidence', 'USAGE'),
  'the migration leaves no schema right behind');

-- Ana writes d (revision 1) and e (revision 2).
SELECT is(pg_temp.commit(1, 'a', 'd', 'b'), 'reserved', 'fixture: revision 1 is d');
SELECT is(pg_temp.commit(2, 'd', 'e', 'c'), 'reserved', 'fixture: revision 2 is e');

-- A restore not yet saved, or saved after typing, is not recorded.
SELECT is(pg_temp.restore('ana', 1), 'no_matching_revision', 'no later revision of Ana''s holds the text of 1');
SELECT is(pg_temp.restore('ana', 2), 'no_matching_revision', 'revision 2 is the newest, nothing follows it');
SELECT is(pg_temp.restore('ana', 9), 'no_matching_revision', 'a revision that does not exist restores nothing');
SELECT is(pg_temp.records(), '', 'nothing is recorded');

-- Ana restores revision 1: revision 3 is d again.
SELECT is(pg_temp.commit(3, 'e', 'd', '7'), 'reserved', 'fixture: revision 3 is d, the text of 1');
SELECT is(pg_temp.restore('ana', 1), 'recorded@3', 'Ana records that revision 3 restored revision 1');
SELECT is(pg_temp.records(), '3<1', 'the record is against revision 3');
SELECT is(pg_temp.restore('ana', 1), 'already_recorded@3', 'the same restore again changes nothing and names revision 3');
SELECT is(pg_temp.records(), '3<1', 'still one record');
SELECT is(pg_temp.restore('ana', 3), 'no_matching_revision', 'revision 3 is restored by nothing after it');

-- Everyone else gets the answer for a missing document and records nothing (C-23).
SELECT is(pg_temp.restore(a.name, 2), 'not_found', a.name || ' gets not_found and records nothing')
FROM (VALUES ('vesna'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.restore('ana', 1, 'doc-b'), 'not_found', 'Ana gets not_found for Tomo''s work');
SELECT is(pg_temp.restore('tomo', 1, 'doc-b'), 'no_matching_revision',
  'Tomo, the owner of doc-b, is answered for his own work');
SELECT is(pg_temp.restore('ana', 1, d.id), 'not_found', 'Ana gets not_found for ' || d.label)
FROM (VALUES ('doc-nema', 'a missing document'), ('', 'an empty id'), (' doc-a', 'an id with a blank at its edge'),
             ('doc-a' || chr(1), 'an id with a control character'), (repeat('x', 257), 'an id over 256 characters'),
             (NULL, 'no id'))
  AS d (id, label);
SELECT is(pg_temp.restore(a.name, 1), 'ZD401: not authenticated', a.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS a (name);
SELECT is(pg_temp.restore('anon', 0), 'ZD401: not authenticated', 'the session is checked before the revision');
SELECT is(pg_temp.restore('ana', b.from_revision), 'ZD422: invalid input', 'Ana is refused revision ' || coalesce(b.from_revision::text, 'NULL'))
FROM (VALUES (0::bigint), (-1), (NULL), (9007199254740991), (9223372036854775807)) AS b (from_revision);
SELECT is(pg_temp.restore('vesna', 0), 'ZD422: invalid input', 'the revision is checked before the access');
SELECT is(pg_temp.records(), '3<1', 'no refused call wrote a record');

-- Revisions 4 (e) and 5 (d): a second restore of 1 lands on the lowest revision left.
SELECT is(pg_temp.commit(4, 'd', 'e', '8'), 'reserved', 'fixture: revision 4 is e, the text of 2');
SELECT is(pg_temp.commit(5, 'e', 'd', '9'), 'reserved', 'fixture: revision 5 is d again');
SELECT is(pg_temp.restore('ana', 2), 'recorded@4', 'revision 4 restored revision 2');
SELECT is(pg_temp.restore('ana', 1), 'recorded@5', 'revision 5 restored revision 1 once more');
SELECT is(pg_temp.restore('ana', 1), 'already_recorded@5', 'no unrecorded d is left; the latest record is named');
SELECT is(pg_temp.restore('ana', 2), 'already_recorded@4', 'a retry of the restore of 2 names revision 4, not 5');
SELECT is(pg_temp.restore('ana', 3), 'no_matching_revision', 'revision 5 is taken, so 3 has no match');
SELECT is(pg_temp.records(), '3<1,4<2,5<1', 'three records, each against its own revision');

-- The owner and the teacher read the revision restored from in the list.
SELECT is(pg_temp.versions(a.name), 'c5<1,c4<2,c3<1,c2,c1', a.name || ' reads which saved point restored which')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.versions('dora'), 'not_found', 'another student still reads no list');

-- A revision of Ana's work written by someone else cannot exist: the key to
-- the document refuses it, so the restore never meets one (it also asks for
-- the actor as the author of the later revision).
SET CONSTRAINTS ALL IMMEDIATE;
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', format($$ INSERT INTO evidence.document_revision
  (document_id, institution_id, revision, base_revision, principal_id, content_hash)
  VALUES ('doc-a', %L, 6, 5, %L, %L) $$, pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.h('e'))),
  '^23503:', 'a revision of Ana''s work by Vesna is refused');
SET CONSTRAINTS ALL DEFERRED;
SELECT is(pg_temp.records(), '3<1,4<2,5<1', 'still three records');

-- The record is append-only, even for its owner.
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', $$ UPDATE evidence.revision_restore
  SET restored_from_revision = 2 WHERE revision = 3 $$), '^ZD403:', 'a record cannot be changed');
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', $$ DELETE FROM evidence.revision_restore $$),
  '^ZD403:', 'a record cannot be deleted');
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', $$ TRUNCATE evidence.revision_restore $$),
  '^ZD403:', 'the records cannot be truncated');
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', format($$ INSERT INTO evidence.revision_restore
  (document_id, institution_id, revision, restored_from_revision, principal_id)
  VALUES ('doc-a', %L, 2, 2, %L) $$, pg_temp.id('fak_a'), pg_temp.id('ana'))),
  '^23514:', 'a revision cannot restore itself');
SELECT matches(pg_temp.ask('ana', $$ SELECT count(*)::text FROM evidence.revision_restore $$),
  '^42501:', 'the web role cannot read the table directly');

SELECT * FROM finish();
ROLLBACK;
