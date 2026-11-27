-- RITAM-ROK-30D (20261220510000; Constitution v1.11 C-14, owner decision O1 of
-- 22. 11. 2026.): the rhythm of typing is kept for 30 days after the
-- submission. A burst of a work not yet submitted has no date of deletion and
-- the retention job keeps it; a submission gives every burst of its work the
-- submission's time + 30 days, never a later date than it had; a burst written
-- while a live submission stands gets that date, and none is written once the
-- date has passed; the rows recorded before the migration are shortened to the
-- same rule. All people are the invented ones of the shared fixture; no text
-- of a real work.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Revisions 1..3 of Ana's work, so that each attempt names its own revision.
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'doc-a', pg_temp.id('fak_a'), n, n - 1, pg_temp.id('ana'), pg_temp.h('a') FROM generate_series(1, 3) n;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;

-- A submission of Ana's work (attempt n) requested at p_at, recorded by the
-- evidence role as app.record_submission records it. The request is written
-- by the test's own role (no declaration is pinned for it).
CREATE FUNCTION pg_temp.submit(p_attempt integer, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_request uuid := gen_random_uuid();
  v_due timestamptz := (SELECT due_at FROM institution.assignment_version
                         WHERE assignment_id = pg_temp.id('z1') AND version_no = 1);
  v_id uuid;
BEGIN
  INSERT INTO evidence.submission_request (id, institution_id, assignment_id, assignment_version, project_id,
    document_id, principal_id, revision, content_hash, requested_at, attempt)
  VALUES (v_request, pg_temp.id('fak_a'), pg_temp.id('z1'), 1, 'project-a', 'doc-a', pg_temp.id('ana'),
          p_attempt, pg_temp.h('a'), p_at, p_attempt);
  SET LOCAL ROLE ductus_evidence;
  INSERT INTO evidence.submission (submission_request_id, institution_id, principal_id, assignment_id,
    assignment_version, revision, artifact_hash, requested_at, due_at, recorded_at)
  VALUES (v_request, pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 1, p_attempt, pg_temp.h('a'),
          p_at, v_due, p_at + interval '1 minute')
  RETURNING id INTO v_id;
  RESET ROLE;
  RETURN v_id;
END
$$;
-- A teacher's return of a submission for revision: it is no longer the live one.
CREATE FUNCTION pg_temp.give_back(p_submission uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL ROLE ductus_evidence;
  INSERT INTO evidence.submission_return (submission_id, institution_id, principal_id, assignment_id, document_id,
    returned_by, comment)
  VALUES (p_submission, pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 'doc-a', pg_temp.id('vesna'),
          'Izmišljeni komentar za doradu.');
  RESET ROLE;
END
$$;
-- A row as the table holds it, written by its owner (for the rows of another
-- student and the rows from before the migration).
CREATE FUNCTION pg_temp.row_of(p_student text, p_recorded timestamptz, p_due timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  SET LOCAL ROLE ductus_evidence;
  INSERT INTO evidence.input_rhythm (institution_id, assignment_id, student_id, gaps_ms, recorded_at, delete_after)
  VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id(p_student), ARRAY[100, 200], p_recorded, p_due)
  RETURNING id INTO v_id;
  RESET ROLE;
  RETURN v_id;
END
$$;
CREATE FUNCTION pg_temp.due_of(p_id uuid) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT delete_after FROM evidence.input_rhythm WHERE id = p_id
$$;
CREATE FUNCTION pg_temp.purge() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask_as('ductus_retention', 'anon', 'SELECT app.input_rhythm_purge()')
$$;

-- 1. Catalogue: days, not months; private helpers of the evidence role.
SELECT hasnt_function('app', 'input_rhythm_retention_months', 'the constant in months is gone');
SELECT is(app.input_rhythm_retention_days(), 30, 'the rhythm is kept 30 days after the submission');
SELECT col_is_null('evidence', 'input_rhythm', 'delete_after', 'a burst may wait for the submission for its date');
SELECT is_empty(
  $$ SELECT conname::text FROM pg_constraint WHERE conrelid = 'evidence.input_rhythm'::regclass AND conname = 'input_rhythm_check' $$,
  'the date no longer follows the record');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('evidence.input_rhythm_due(uuid,uuid,uuid)'::regprocedure,
                      'evidence.input_rhythm_due_on_submission()'::regprocedure,
                      'evidence.input_rhythm_shorten_due()'::regprocedure,
                      'evidence.input_rhythm_lock(uuid,uuid,uuid)'::regprocedure,
                      'app.input_rhythm_retention_days()'::regprocedure)
        AND (p.proowner <> 'ductus_evidence'::regrole OR p.prosecdef OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the helpers belong to the evidence role, are not SECURITY DEFINER and pin an empty search_path');
SELECT is_empty(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['public', 'ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                            'ductus_identity']) AS r
      CROSS JOIN unnest(ARRAY['evidence.input_rhythm_due(uuid,uuid,uuid)', 'evidence.input_rhythm_due_on_submission()',
                              'evidence.input_rhythm_shorten_due()', 'evidence.input_rhythm_lock(uuid,uuid,uuid)',
                              'app.input_rhythm_retention_days()']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  'no runtime role executes the helpers');
SELECT is(
  (SELECT t.tgtype::text || ' ' || t.tgenabled::text || ' ' || t.tgdeferrable::text FROM pg_trigger t
    WHERE t.tgrelid = 'evidence.submission'::regclass AND t.tgname = 'evidence_submission_sets_rhythm_due'),
  '5 O false', 'after each inserted submission row; enabled, not deferrable');
SELECT ok(NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE')
          AND NOT has_schema_privilege('ductus_evidence', 'evidence', 'CREATE'),
  'after the migration the evidence role keeps no CREATE on the schemas');

-- 1a. A burst and a submission of the same work take one transaction lock of
-- that work before they read or set the date (Codex review on #909): with READ
-- COMMITTED neither would otherwise see the other's uncommitted row, and the
-- burst would keep no date for good. Each path is seen holding the lock inside
-- a savepoint; rolling it back releases the lock again.
CREATE FUNCTION pg_temp.rhythm_lock_held() RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_locks l,
      LATERAL (SELECT hashtextextended('evidence.input_rhythm:' || pg_temp.id('fak_a') || ':' || pg_temp.id('z1')
                                       || ':' || pg_temp.id('ana'), 0) AS k) h
     WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 1
       AND l.classid::bigint = (h.k >> 32) & 4294967295 AND l.objid::bigint = h.k & 4294967295)
$$;
SELECT ok(NOT pg_temp.rhythm_lock_held(), 'no lock of Ana''s rhythm is held before anything');
SAVEPOINT lock_burst;
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[1]) $$), 'true', 'a burst is recorded');
SELECT ok(pg_temp.rhythm_lock_held(), 'recording a burst holds the lock of the work');
ROLLBACK TO SAVEPOINT lock_burst;
SELECT ok(NOT pg_temp.rhythm_lock_held(), 'released with the savepoint');
SAVEPOINT lock_submission;
DO $$ BEGIN PERFORM pg_temp.submit(1, now()); END $$;
SELECT ok(pg_temp.rhythm_lock_held(), 'recording a submission holds the same lock');
ROLLBACK TO SAVEPOINT lock_submission;
SELECT ok(NOT pg_temp.rhythm_lock_held() AND NOT EXISTS (SELECT 1 FROM evidence.submission),
  'released with the savepoint, and no submission is left');

-- 2. Before the submission: no date, and the job keeps the burst.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[120, 80]) $$), 'true', 'a burst is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm WHERE delete_after IS NULL), 1::bigint,
  'a burst of a work not yet submitted has no date of deletion');
CREATE TEMP TABLE dora_row AS SELECT pg_temp.row_of('dora', now() - interval '1 day', NULL) AS id;
SELECT is(pg_temp.purge(), '0', 'the job deletes no burst that waits for the submission');

-- 3. The submission sets the date: requested_at + 30 days; another student's work keeps waiting.
CREATE TEMP TABLE s1 AS SELECT pg_temp.submit(1, now() - interval '2 days') AS id;
SELECT is((SELECT count(*) FROM evidence.input_rhythm
            WHERE student_id = pg_temp.id('ana') AND delete_after = now() - interval '2 days' + interval '30 days'),
  1::bigint, 'the submission gives Ana''s burst its time + 30 days');
SELECT is(pg_temp.due_of((SELECT id FROM dora_row)), NULL, 'Dora''s burst on the same assignment still waits');
SELECT is(pg_temp.purge(), '0', 'not yet due 28 days before the date');

-- 4. Written while the submission is live: the same date.
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[5]) $$), 'true',
  'a burst after the submission is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm
            WHERE student_id = pg_temp.id('ana') AND delete_after = now() - interval '2 days' + interval '30 days'),
  2::bigint, 'and gets the date of the live submission');

-- 5. Returned for revision: the next bursts wait for the next submission; the dates already set stay.
DO $$ BEGIN PERFORM pg_temp.give_back((SELECT id FROM s1)); END $$;
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[7, 8]) $$), 'true',
  'a burst of the revision is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm WHERE student_id = pg_temp.id('ana') AND delete_after IS NULL),
  1::bigint, 'it waits for the next submission');
SELECT is((SELECT count(*) FROM evidence.input_rhythm
            WHERE student_id = pg_temp.id('ana') AND delete_after = now() - interval '2 days' + interval '30 days'),
  2::bigint, 'the return does not bring the earlier bursts back');

-- 6. The next submission, 31 days ago: every burst is due, never later than it was; the job deletes them.
CREATE TEMP TABLE s2 AS SELECT pg_temp.submit(2, now() - interval '31 days') AS id;
SELECT is((SELECT count(*) FROM evidence.input_rhythm
            WHERE student_id = pg_temp.id('ana') AND delete_after = now() - interval '1 day'),
  3::bigint, 'the earlier submission time shortens every date of the work to its + 30 days');
SELECT is(pg_temp.ask('ana', $$ SELECT app.input_rhythm_record('doc-a', ARRAY[9]) $$), 'false',
  'more than 30 days after the live submission nothing is recorded');
SELECT is((SELECT count(*) FROM evidence.input_rhythm WHERE student_id = pg_temp.id('ana')), 3::bigint,
  'and no row was added');
SELECT is(pg_temp.purge(), '3', 'the job deletes the bursts 30 days after the submission');
SELECT is((SELECT count(*) FROM evidence.input_rhythm WHERE student_id = pg_temp.id('ana')), 0::bigint,
  'nothing of Ana''s rhythm is left');
SELECT is((SELECT count(*) FROM evidence.input_rhythm WHERE id = (SELECT id FROM dora_row)), 1::bigint,
  'Dora''s burst, never submitted, is kept');

-- 7. A later submission never lengthens a date.
DO $$ BEGIN PERFORM pg_temp.give_back((SELECT id FROM s2)); END $$;
CREATE TEMP TABLE early AS SELECT pg_temp.row_of('ana', now() - interval '3 days', now() + interval '5 days') AS id;
CREATE TEMP TABLE s3 AS SELECT pg_temp.submit(3, now() - interval '1 hour') AS id;
SELECT is(pg_temp.due_of((SELECT id FROM early)), now() + interval '5 days', 'an earlier date stays');

-- 8. The rows from before the migration (12 months after the record) are shortened by the same rule.
DO $$ BEGIN PERFORM pg_temp.give_back((SELECT id FROM s3)); END $$;
CREATE TEMP TABLE old AS SELECT * FROM (VALUES
  -- recorded before the first submission still on record (s1, 2 days ago)
  ('before', pg_temp.row_of('ana', now() - interval '10 days', now() + interval '12 months')),
  -- recorded after every submission, none of them live (all returned): keeps its date
  ('after', pg_temp.row_of('ana', now() - interval '10 minutes', now() + interval '12 months')),
  -- another student's work, never submitted: keeps its date
  ('dora', pg_temp.row_of('dora', now() - interval '10 days', now() + interval '12 months'))
) AS o (name, id);
-- The migration's own statement, run by the owner as the migration runs it.
CREATE FUNCTION pg_temp.shorten() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_n integer;
BEGIN
  SET LOCAL ROLE ductus_evidence;
  v_n := evidence.input_rhythm_shorten_due();
  RESET ROLE;
  RETURN v_n;
END
$$;
SELECT is(pg_temp.shorten(), 1, 'the backfill shortens only the row a submission covers');
SELECT is(pg_temp.shorten(), 0, 'running it again changes nothing');
-- s2 was recorded 31 days ago, before the row; the first one recorded after it is s1.
SELECT is(pg_temp.due_of((SELECT id FROM old WHERE name = 'before')), now() - interval '2 days' + interval '30 days',
  'a row recorded before a submission gets that submission''s time + 30 days');
SELECT is(pg_temp.due_of((SELECT id FROM old WHERE name = 'after')), now() + interval '12 months',
  'a row recorded after a returned submission keeps its date until the next submission');
SELECT is(pg_temp.due_of((SELECT id FROM old WHERE name = 'dora')), now() + interval '12 months',
  'a row of a work never submitted keeps its date');
SELECT is(pg_temp.due_of((SELECT id FROM early)), now() + interval '5 days', 'an earlier date is never lengthened');

SELECT * FROM finish();
ROLLBACK;
