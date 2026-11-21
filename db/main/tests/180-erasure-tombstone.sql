-- SRV-1301 (M10.0-S1; D-272 MQ04, MQ05): the erasure contract. The tombstone
-- table evidence.erasure is append-only for its owner too, has forced RLS and
-- grants nothing to any other role; only ductus_retention executes
-- app.erasure_append and app.erasure_of; a row of audit.access_log is deleted
-- only through app.erasure_append, which leaves its tombstone in the same
-- transaction. Every person, course and document below is invented
-- (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

INSERT INTO ref VALUES
  ('log1', '00000000-0000-4000-8000-0000000001a1'),
  ('log2', '00000000-0000-4000-8000-0000000001a2'),
  ('log3', '00000000-0000-4000-8000-0000000001a3'),
  ('job1', '00000000-0000-4000-8000-0000000001b1');

CREATE FUNCTION pg_temp.retention(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_retention', 'anon', p_sql) $$;
CREATE FUNCTION pg_temp.as_role(p_role text, p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as(p_role, 'anon', p_sql) $$;
CREATE FUNCTION pg_temp.log_ids() RETURNS text[]
LANGUAGE sql STABLE AS $$ SELECT coalesce(array_agg(id::text ORDER BY id), '{}') FROM audit.access_log $$;
CREATE FUNCTION pg_temp.tombstones() RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT count(*) FROM evidence.erasure $$;
-- The hash access_log_hash takes, written out here, so the test does not
-- lean on the function it checks.
CREATE FUNCTION pg_temp.expected_hash(p_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'id', l.id, 'institution_id', l.institution_id, 'document_id', l.document_id,
    'assignment_id', l.assignment_id, 'owner_id', l.owner_id, 'reader_id', l.reader_id,
    'reader_role', l.reader_role, 'surface', l.surface,
    'opened_at', to_char(l.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))::text, 'UTF8')), 'hex')
  FROM audit.access_log l WHERE l.id = p_id
$$;

-- Three invented rows of the access log: Vesna, teacher of K1, opened the
-- works of Ana and Dora.
SET LOCAL ROLE ductus_identity;
INSERT INTO audit.access_log (id, institution_id, document_id, assignment_id, owner_id, reader_id, reader_role, surface, opened_at)
VALUES
  (pg_temp.id('log1'), pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'),
   'teacher', 'live_view', '2026-10-19 12:05:00+00'),
  (pg_temp.id('log2'), pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'),
   'teacher', 'process_summary', '2026-10-19 12:10:00+00'),
  (pg_temp.id('log3'), pg_temp.id('fak_a'), 'doc-d', pg_temp.id('z1'), pg_temp.id('dora'), pg_temp.id('vesna'),
   'teacher', 'live_view', '2026-10-19 12:15:00+00');
RESET ROLE;
CREATE TEMP TABLE hash_before AS SELECT pg_temp.expected_hash(pg_temp.id('log1')) AS v;
GRANT SELECT ON hash_before TO PUBLIC;

-- 1. Catalogue: the table, its owner, forced RLS, its only policy, its columns.
SELECT row_eq(
  $$ SELECT relowner::regrole::text, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'evidence.erasure'::regclass $$,
  ROW('ductus_evidence'::text, true, true), 'the evidence role owns erasure and RLS is enabled and forced');
SELECT bag_eq(
  $$ SELECT polname::text, polroles::regrole[]::text, polcmd::text FROM pg_policy WHERE polrelid = 'evidence.erasure'::regclass $$,
  $$ VALUES ('erasure_owner', '{ductus_evidence}', '*') $$, 'the only policy is the owner''s');
SELECT columns_are('evidence', 'erasure', ARRAY[
  'id', 'institution_id', 'data_class', 'subject_id', 'content_sha256', 'reason', 'job_id', 'erased_at'
], 'a tombstone holds institution, class, subject, hash, reason, job and time, and no content');
SELECT is_empty(
  $$ SELECT a.grantee::regrole::text FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'evidence.erasure'::regclass AND a.grantee <> c.relowner $$,
  'no role but the owner has any privilege on erasure');
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || p FROM pg_roles r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      WHERE r.rolname LIKE 'ductus\_%' AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, 'evidence.erasure', p) $$,
  'no other role reads, writes or empties erasure directly');
SELECT bag_eq(
  $$ SELECT tgname::text, tgtype::int, tgfoid::regprocedure::text FROM pg_trigger
      WHERE tgrelid = 'evidence.erasure'::regclass AND NOT tgisinternal $$,
  $$ VALUES ('erasure_append_only', 26, 'evidence.reject_append_only_change()'),
            ('erasure_no_truncate', 34, 'evidence.reject_append_only_change()') $$,
  'statement triggers refuse UPDATE, DELETE and TRUNCATE');

-- 2. The functions: owners, definers with an empty path, and who executes them.
SELECT bag_eq(
  $$ SELECT p.oid::regprocedure::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
       FROM pg_proc p
      WHERE p.oid IN ('app.erasure_append(text,text,text,uuid)'::regprocedure, 'app.erasure_of(text,text)'::regprocedure,
                      'app.erasure_recorded(text,text)'::regprocedure, 'app.access_log_hash(uuid)'::regprocedure,
                      'app.access_log_erase(uuid)'::regprocedure) $$,
  $$ VALUES ('app.erasure_append(text,text,text,uuid)', 'ductus_evidence', true, '{"search_path=\"\""}'::text[]),
            ('app.erasure_of(text,text)', 'ductus_evidence', true, '{"search_path=\"\""}'),
            ('app.erasure_recorded(text,text)', 'ductus_evidence', true, '{"search_path=\"\""}'),
            ('app.access_log_hash(uuid)', 'ductus_identity', true, '{"search_path=\"\""}'),
            ('app.access_log_erase(uuid)', 'ductus_identity', true, '{"search_path=\"\""}') $$,
  'the erasure functions are definers with an empty path, owned by the owner of the table each touches');
CREATE FUNCTION pg_temp.executors(p_signature text) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(r ORDER BY r), '{}') FROM (
    SELECT rolname::text AS r FROM pg_roles
     WHERE rolname LIKE 'ductus\_%' AND has_function_privilege(oid, p_signature::regprocedure, 'EXECUTE')
    UNION ALL SELECT 'public' WHERE has_function_privilege('public', p_signature::regprocedure, 'EXECUTE')) x
$$;
SELECT is(pg_temp.executors('app.erasure_append(text,text,text,uuid)'), ARRAY['ductus_evidence', 'ductus_retention'],
  'only the retention role (and the owner) executes erasure_append');
SELECT is(pg_temp.executors('app.erasure_of(text,text)'), ARRAY['ductus_evidence', 'ductus_retention'],
  'only the retention role (and the owner) executes erasure_of');
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot execute ' || f)
  FROM unnest(ARRAY['ductus_app', 'ductus_identity', 'ductus_worker', 'ductus_auth']) AS r
 CROSS JOIN unnest(ARRAY['app.erasure_append(text,text,text,uuid)', 'app.erasure_of(text,text)']) AS f;
SELECT is(pg_temp.executors('app.erasure_recorded(text,text)'), ARRAY['ductus_evidence', 'ductus_identity'],
  'only the owner of the access log asks whether a tombstone exists');
SELECT is(pg_temp.executors('app.access_log_hash(uuid)'), ARRAY['ductus_evidence', 'ductus_identity'],
  'only the evidence role (and the owner) executes access_log_hash');
SELECT is(pg_temp.executors('app.access_log_erase(uuid)'), ARRAY['ductus_evidence', 'ductus_identity'],
  'only the evidence role (and the owner) executes access_log_erase');
SELECT ok(has_schema_privilege('ductus_retention', 'app', 'USAGE')
    AND NOT has_schema_privilege('ductus_retention', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_retention', 'evidence', 'USAGE')
    AND NOT has_schema_privilege('ductus_retention', 'audit', 'USAGE'),
  'the retention role names functions of app and reaches neither evidence nor audit');
SELECT ok(NOT has_schema_privilege(r, s, 'CREATE'), r || ' keeps no CREATE on ' || s)
  FROM unnest(ARRAY['ductus_identity', 'ductus_evidence']) AS r
 CROSS JOIN unnest(ARRAY['app', 'evidence', 'audit']) AS s;
SELECT bag_eq(
  $$ SELECT tgname::text, tgfoid::regprocedure::text FROM pg_trigger
      WHERE tgrelid = 'audit.access_log'::regclass AND NOT tgisinternal $$,
  $$ VALUES ('access_log_append_only', 'audit.access_log_guard()'),
            ('access_log_no_truncate', 'audit.reject_change()') $$,
  'the access log keeps its two guards; only the row guard is narrowed');

-- 3. Roles other than retention reach nothing.
SELECT is(pg_temp.ask('vesna', $$ SELECT app.erasure_append('access_log', {log1}, 'retention_expired') $$),
  '42501: permission denied for function erasure_append', 'the web role cannot erase');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.erasure_of('access_log', {log1}) $$),
  '42501: permission denied for function erasure_of', 'the web role cannot read a tombstone');
SELECT is(pg_temp.as_role('ductus_identity', $$ SELECT app.erasure_append('access_log', {log1}, 'retention_expired') $$),
  '42501: permission denied for function erasure_append', 'the identity role cannot erase');
SELECT is(pg_temp.as_role('ductus_worker', $$ SELECT app.erasure_append('access_log', {log1}, 'retention_expired') $$),
  '42501: permission denied for function erasure_append', 'the worker cannot erase');
SELECT is(pg_temp.ask('vesna', 'SELECT count(*) FROM evidence.erasure'),
  '42501: permission denied for table erasure', 'the web role cannot read the tombstones');
SELECT is(pg_temp.retention('SELECT count(*) FROM evidence.erasure'),
  '42501: permission denied for schema evidence', 'the retention role reads tombstones only through erasure_of');
SELECT is(pg_temp.retention('DELETE FROM audit.access_log'),
  '42501: permission denied for schema audit', 'the retention role cannot delete from the access log directly');
SELECT is(pg_temp.retention($$ SELECT app.access_log_erase({log1}) $$),
  '42501: permission denied for function access_log_erase', 'the retention role cannot skip the tombstone step');
SELECT is(pg_temp.retention($$ SELECT count(*) FROM app.access_log_hash({log1}) $$),
  '42501: permission denied for function access_log_hash', 'nor call the hash step');

-- 4. The owner of the access log deletes nothing without a tombstone, and
-- changes nothing at all.
SELECT is(pg_temp.as_role('ductus_identity', $$ DELETE FROM audit.access_log WHERE id = {log1} RETURNING 'deleted' $$),
  'ZD403: append-only row', 'the owner cannot delete a row of the access log');
SELECT is(pg_temp.as_role('ductus_identity', $$ SELECT app.access_log_erase({log1})::text $$),
  'ZD403: append-only row', 'the delete step alone, without a tombstone, is refused');
SELECT is(pg_temp.as_role('ductus_identity', $$ UPDATE audit.access_log SET surface = 'replay' WHERE id = {log1} RETURNING 'changed' $$),
  'ZD403: append-only row', 'the owner cannot change a row');
SELECT is(pg_temp.as_role('ductus_identity', 'TRUNCATE audit.access_log'),
  'ZD403: append-only row', 'the owner cannot empty the access log');
SELECT is(pg_temp.log_ids(), ARRAY[pg_temp.id('log1')::text, pg_temp.id('log2')::text, pg_temp.id('log3')::text],
  'all three rows are still there');

-- 5. Invalid input and missing subjects write nothing.
SELECT is(pg_temp.retention($$ SELECT app.erasure_append('live_state', {log1}, 'retention_expired') $$),
  'ZD422: invalid input', 'a data class outside the list is refused');
SELECT is(pg_temp.retention($$ SELECT app.erasure_append('access_log', {log1}, 'because') $$),
  'ZD422: invalid input', 'a reason outside the list is refused');
SELECT is(pg_temp.retention($$ SELECT app.erasure_append('access_log', 'not-a-uuid', 'retention_expired') $$),
  'ZD422: invalid input', 'a subject that is not an access log id is refused');
SELECT is(pg_temp.retention($$ SELECT app.erasure_append('access_log', NULL, 'retention_expired') $$),
  'ZD422: invalid input', 'a missing subject is refused');
SELECT is(pg_temp.retention($$ SELECT app.erasure_append('access_log', {nobody}, 'retention_expired') $$),
  'ZD404: not found', 'a row that does not exist is not found');
SELECT is(pg_temp.tombstones(), 0::bigint, 'no refused call wrote a tombstone');

-- 6. Erasure through erasure_append: the row goes, its tombstone stays, in
-- one call and one transaction.
SELECT matches(pg_temp.retention($$ SELECT app.erasure_append('access_log', {log1}, 'retention_expired', {job1}) $$),
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'the retention role erases one row and gets the tombstone id');
SELECT is(pg_temp.log_ids(), ARRAY[pg_temp.id('log2')::text, pg_temp.id('log3')::text], 'only that row is gone');
SELECT results_eq(
  $$ SELECT institution_id, data_class, subject_id, content_sha256, reason, job_id, erased_at = now() FROM evidence.erasure $$,
  $$ SELECT pg_temp.id('fak_a'), 'access_log'::text, pg_temp.id('log1')::text, (SELECT v FROM hash_before), 'retention_expired'::text,
            pg_temp.id('job1'), true $$,
  'the tombstone names the institution of the row, class, row, the SHA-256 of the erased row, reason and job, written in the same transaction');
SELECT is(pg_temp.retention($$ SELECT string_agg(subject_id || ' ' || content_sha256 || ' ' || reason, ',')
                               FROM app.erasure_of('access_log', {log1}) $$),
  pg_temp.id('log1')::text || ' ' || (SELECT v FROM hash_before) || ' retention_expired',
  'the retention role reads the tombstone through erasure_of');
SELECT is(pg_temp.retention($$ SELECT count(*) FROM app.erasure_of('access_log', {log2}) $$), '0',
  'a row that was not erased has no tombstone');
SELECT is(pg_temp.retention($$ SELECT app.erasure_append('access_log', {log1}, 'retention_expired') $$),
  'ZD409: already erased', 'a row is erased once');
SELECT matches(pg_temp.retention($$ SELECT app.erasure_append('access_log', {log3}, 'erasure_request') $$),
  '^[0-9a-f-]{36}$', 'a second row is erased without a job');
SELECT is(pg_temp.tombstones(), 2::bigint, 'two erasures, two tombstones');
SELECT is(pg_temp.log_ids(), ARRAY[pg_temp.id('log2')::text], 'one row of the access log is left');

-- 7. The tombstones are append-only for their owner too, even when no row
-- would be touched.
SELECT is(pg_temp.as_role('ductus_evidence', $$ UPDATE evidence.erasure SET reason = 'erasure_request' RETURNING 'changed' $$),
  'ZD403: append-only row', 'the owner cannot change a tombstone');
SELECT is(pg_temp.as_role('ductus_evidence', $$ UPDATE evidence.erasure SET reason = 'erasure_request' WHERE false RETURNING 'changed' $$),
  'ZD403: append-only row', 'an UPDATE that matches no row fails as well');
SELECT is(pg_temp.as_role('ductus_evidence', $$ DELETE FROM evidence.erasure RETURNING 'deleted' $$),
  'ZD403: append-only row', 'the owner cannot delete a tombstone');
SELECT is(pg_temp.as_role('ductus_evidence', $$ DELETE FROM evidence.erasure WHERE false RETURNING 'deleted' $$),
  'ZD403: append-only row', 'a DELETE that matches no row fails as well');
SELECT is(pg_temp.as_role('ductus_evidence', 'TRUNCATE evidence.erasure'),
  'ZD403: append-only row', 'the owner cannot empty the tombstones');
SELECT is(pg_temp.tombstones(), 2::bigint, 'both tombstones are still there');

-- 8. A tombstone written for a row that is still there opens no other row:
-- the guard asks for the tombstone of the very row being deleted.
SELECT is(pg_temp.as_role('ductus_identity', $$ DELETE FROM audit.access_log RETURNING 'deleted' $$),
  'ZD403: append-only row', 'with other rows erased, the owner still deletes no remaining row');

-- 9. Forced RLS is the protection, not only the missing grants: with every
-- privilege granted by mistake, the web role still sees and writes no
-- tombstone and deletes no row of the access log.
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence.erasure TO ductus_app;
SELECT is(pg_temp.ask('vesna', 'SELECT count(*) FROM evidence.erasure'), '0',
  'with a mistaken grant the web role still reads no tombstone');
SELECT is(left(pg_temp.ask('vesna', $$ INSERT INTO evidence.erasure (institution_id, data_class, subject_id, content_sha256, reason)
    VALUES ({fak_a}, 'access_log', {log2}, repeat('a', 64), 'retention_expired') RETURNING 'written' $$), 6),
  '42501:', 'with a mistaken grant the web role still writes no tombstone');
REVOKE SELECT, INSERT, UPDATE, DELETE ON evidence.erasure FROM ductus_app;
SELECT is(pg_temp.log_ids(), ARRAY[pg_temp.id('log2')::text], 'the access log is unchanged');

SELECT * FROM finish();
ROLLBACK;
