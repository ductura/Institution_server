-- SRV-2003 (Ductus#2052): app.teacher_work_get (20261212100000), the teacher's
-- read of one work by its document id. The access matrix: a reader of the work
-- gets one row; the student of the work, a stranger, a teacher of another
-- course, another institution and an unknown document get none; no session is
-- ZD401. The read writes nothing in the evidence schema or the access log. All
-- people and documents are the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Marko teaches K1 too, so a second teacher of the same course is there.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');

-- A second work in the same assignment (Dora's), so the neighbours exist.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
VALUES ('project-dora', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
VALUES ('doc-dora', pg_temp.id('fak_a'), 'project-dora', pg_temp.id('dora'), pg_temp.h('d'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
VALUES ('doc-dora', pg_temp.id('fak_a'), 0, pg_temp.id('dora'), pg_temp.h('d'));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

CREATE TEMP TABLE print_before AS
SELECT (SELECT count(*) FROM evidence.document) AS documents, (SELECT count(*) FROM audit.access_log) AS log_rows;

-- 1. Catalogue.
SELECT ok(p.prosecdef AND p.proowner = 'ductus_identity'::regrole AND 'search_path=""' = ANY (p.proconfig),
  'app.teacher_work_get is a SECURITY DEFINER function of the identity role with an empty search_path')
FROM pg_proc p WHERE p.oid = 'app.teacher_work_get(text)'::regprocedure;
SELECT bag_eq(
  $$ SELECT r::text FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_function_privilege(r, 'app.teacher_work_get(text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role executes it');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

-- 2. A teacher of the course reads the work and its neighbour.
SELECT is(pg_temp.ask('vesna', $$ SELECT student_id = pg_temp.id('ana') AND assignment_id = pg_temp.id('z1') AND document_id = 'doc-a' FROM app.teacher_work_get('doc-a') $$),
  'true', 'Vesna reads Ana''s work with its student and assignment');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM app.teacher_work_get('doc-a') $$), 'nije_predano',
  'a work nobody submitted is nije_predano');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM (
    SELECT prev_document_id, next_document_id FROM app.teacher_work_get('doc-a')
    UNION ALL SELECT prev_document_id, next_document_id FROM app.teacher_work_get('doc-dora')) x
    WHERE (prev_document_id IS NULL) <> (next_document_id IS NULL) $$),
  '2', 'the two works of the assignment are each other''s only neighbour, one before and one after');
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(prev_document_id, next_document_id) FROM app.teacher_work_get('doc-a') $$), 'doc-dora',
  'Ana''s neighbour is Dora''s work');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM app.teacher_work_get('doc-a') $$), '1',
  'a second teacher of the course reads it too');

-- 3. Nobody else gets a row.
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.teacher_work_get('doc-a') $$), '0',
  a.name || ' reads nothing of Ana''s work')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.teacher_work_get('doc-nema') $$), '0',
  'an unknown document gives nothing');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.teacher_work_get('doc-b') $$), '0',
  'another institution''s document gives nothing');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM app.teacher_work_get('doc-a') $$), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 4. Nothing is written.
SELECT is((SELECT documents FROM print_before), (SELECT count(*) FROM evidence.document),
  'the read wrote no document');
SELECT is((SELECT log_rows FROM print_before), (SELECT count(*) FROM audit.access_log),
  'the read left no row in the access log');

SELECT * FROM finish();
ROLLBACK;
