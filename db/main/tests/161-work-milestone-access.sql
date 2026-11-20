-- SRV-1103 (Ductus#2051; Val 11, E§3.5 mentor2 "Etape", PO-22): the
-- milestones of a student's work (20261121101000). The student of the work
-- and its teacher read the same milestones and due dates; only a teacher of
-- the work changes the due date of one, and nothing else of it; the student
-- writes nothing; another's work is one answer with an unknown one; a
-- submitted work has no change action. Every person, course, document and
-- title below is invented; the documents are those of 157.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), repeat('c', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- Milestones from the configured workflow, written as the owner role (no
-- caller writes one): three of Ana's, one of Tomo's.
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.work_milestone (id, institution_id, assignment_id, student_id, position, title, description, due_at, state) VALUES
  ('00000000-0000-4000-8000-000000000e01', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 1, 'Izmišljeni nacrt', 'Prvi nacrt rada.', '2027-01-10T12:00:00Z', 'done'),
  ('00000000-0000-4000-8000-000000000e02', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 2, 'Izmišljeno poglavlje', '', '2027-02-10T12:00:00Z', 'open'),
  ('00000000-0000-4000-8000-000000000e03', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 3, 'Izmišljena završnica', 'Posljednja etapa.', '2027-03-10T12:00:00Z', 'open'),
  ('00000000-0000-4000-8000-000000000e04', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'), 1, 'Izmišljena etapa B', '', '2027-01-15T12:00:00Z', 'open');
RESET ROLE;
INSERT INTO ref VALUES
  ('m1', '00000000-0000-4000-8000-000000000e01'),
  ('m2', '00000000-0000-4000-8000-000000000e02'),
  ('m3', '00000000-0000-4000-8000-000000000e03'),
  ('mb', '00000000-0000-4000-8000-000000000e04');

-- 'outcome|title:due:state;...' of the milestones read, or the SQLSTATE.
CREATE FUNCTION pg_temp.read(p_actor text, p_doc text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT string_agg(outcome || '|' || coalesce(title, '') || ':' || coalesce(to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '') || ':' || coalesce(state, ''), ';')
          FROM app.read_work_milestones(%L) $q$, p_doc))
$$;
-- 'outcome' or 'updated:<due>' or the SQLSTATE of the change.
CREATE FUNCTION pg_temp.setdue(p_actor text, p_doc text, p_milestone text, p_due text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT outcome || coalesce(':' || to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '')
          FROM app.set_work_milestone_due(%L, %s, %L) $q$, p_doc, p_milestone, p_due))
$$;

-- 1. Catalogue: the table, its RLS, and who may call what.
SELECT table_owner_is('institution', 'work_milestone', 'ductus_identity', 'the owner role owns the milestones');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.work_milestone'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'institution' AND tablename = 'work_milestone' $$,
  ARRAY['work_milestone_owner ALL to ductus_identity'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' has a privilege on the milestones'
       FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
                AND rolname NOT IN ('ductus_identity', 'ductus_migrator')
             UNION ALL SELECT 'ductus_app' UNION ALL SELECT 'public') AS r
      WHERE has_any_column_privilege(r.rolname, 'institution.work_milestone', 'SELECT,INSERT,UPDATE,REFERENCES') $$,
  'no role but the owner holds a privilege on the table, the web role and PUBLIC included');
SELECT bag_eq(
  $$ SELECT f FROM unnest(ARRAY['app.read_work_milestones(text)', 'app.set_work_milestone_due(text,uuid,timestamp with time zone)']) f
      WHERE has_function_privilege('ductus_app', f, 'EXECUTE') $$,
  $$ VALUES ('app.read_work_milestones(text)'), ('app.set_work_milestone_due(text,uuid,timestamp with time zone)') $$,
  'the web role executes both RPCs');
SELECT is_empty(
  $$ SELECT r || ' executes ' || f
       FROM unnest(ARRAY['ductus_worker', 'ductus_retention', 'ductus_auth', 'public']) r
      CROSS JOIN unnest(ARRAY['app.read_work_milestones(text)', 'app.set_work_milestone_due(text,uuid,timestamp with time zone)',
                              'app.work_milestone_submitted(uuid,uuid)']) f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  'no other role and no PUBLIC executes them');
SELECT ok(NOT has_function_privilege('ductus_app', 'app.work_milestone_submitted(uuid,uuid)', 'EXECUTE'),
  'the web role does not execute the submitted helper');

-- 2. Reading: Ana and her teacher read the same milestones, in order.
SELECT is(pg_temp.read('ana', 'doc-a'),
  'found|Izmišljeni nacrt:2027-01-10T12:00:done;found|Izmišljeno poglavlje:2027-02-10T12:00:open;found|Izmišljena završnica:2027-03-10T12:00:open',
  'Ana reads her three milestones in order');
SELECT is(pg_temp.read('vesna', 'doc-a'), pg_temp.read('ana', 'doc-a'),
  'the teacher of K1 reads the same milestones and the same due dates as Ana');
SELECT is(pg_temp.read(a.name, 'doc-a'), 'not_found|::', a.name || ' gets nothing of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris'), ('nina')) AS a (name);
SELECT is(pg_temp.read('vesna', 'doc-b'), 'not_found|::', 'a teacher of fak-a gets nothing of a work of fak-b');
SELECT is(pg_temp.read('vesna', 'doc-nema'), 'not_found|::', 'an unknown work reads as another''s work');
SELECT is(pg_temp.read('vesna', ' doc-a'), 'not_found|::', 'a work id with a space at its start is not one');
SELECT is(pg_temp.read('tomo', 'doc-b'), 'found|Izmišljena etapa B:2027-01-15T12:00:open', 'Tomo reads his own');
SELECT matches(pg_temp.read(t.name, 'doc-a'), '^ZD401', 'a read with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 3. Changing a due date: the teacher only, the due date only.
SELECT is(pg_temp.setdue('vesna', 'doc-a', '{m2}', '2027-02-20T09:30:00Z'), 'updated:2027-02-20T09:30',
  'the teacher of K1 moves the due date of one milestone and gets it back');
SELECT is(pg_temp.read('ana', 'doc-a'),
  'found|Izmišljeni nacrt:2027-01-10T12:00:done;found|Izmišljeno poglavlje:2027-02-20T09:30:open;found|Izmišljena završnica:2027-03-10T12:00:open',
  'Ana reads the new due date; the other milestones, titles and states are as they were');
SELECT is(pg_temp.read('vesna', 'doc-a'), pg_temp.read('ana', 'doc-a'), 'the teacher reads the same after the change');
SELECT row_eq($$ SELECT title, description, state, position, created_at < updated_at FROM institution.work_milestone WHERE id = pg_temp.id('m2') $$,
  ROW('Izmišljeno poglavlje'::text, ''::text, 'open'::text, 2, true), 'only the due date and the time of the change differ');
SELECT is(pg_temp.setdue('ana', 'doc-a', '{m2}', '2027-02-25T09:30:00Z'), 'forbidden',
  'the student of the work may not change a due date, her own included');
SELECT is(pg_temp.setdue(a.name, 'doc-a', '{m2}', '2027-02-25T09:30:00Z'), 'not_found', a.name || ' changes nothing of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris'), ('nina')) AS a (name);
SELECT is(pg_temp.setdue('vesna', 'doc-b', '{mb}', '2027-02-25T09:30:00Z'), 'not_found',
  'a teacher of fak-a changes nothing of a work of fak-b');
SELECT is(pg_temp.setdue('vesna', 'doc-a', '{mb}', '2027-02-25T09:30:00Z'), 'not_found',
  'a milestone of another work is not found through Ana''s document');
SELECT is(pg_temp.setdue('vesna', 'doc-a', '{nobody}', '2027-02-25T09:30:00Z'), 'not_found', 'an unknown milestone is not found');
SELECT is(pg_temp.setdue('vesna', 'doc-nema', '{m2}', '2027-02-25T09:30:00Z'), 'not_found', 'an unknown work is not found');
SELECT matches(pg_temp.setdue(t.name, 'doc-a', '{m2}', '2027-02-25T09:30:00Z'), '^ZD401',
  'a change with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.setdue('vesna', 'doc-a', '{m2}', t.due), 'ZD422: invalid input', 'the due date ' || coalesce(t.due, 'null') || ' is refused')
FROM (VALUES ('infinity'), ('-infinity'), ('1999-12-31T23:59:00Z'), ('2100-01-02T00:00:00Z')) AS t (due);
SELECT is(pg_temp.ask('vesna', $$ SELECT outcome FROM app.set_work_milestone_due('doc-a', NULL, now()) $$), 'ZD422: invalid input',
  'no milestone is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT outcome FROM app.set_work_milestone_due('doc-a', gen_random_uuid(), NULL) $$), 'ZD422: invalid input',
  'no due date is refused');
SELECT is(pg_temp.read('ana', 'doc-a') LIKE '%2027-02-20T09:30%', true, 'no refused change left a trace');

-- 4. The table itself: no write by the web role; nothing but the due date by the owner.
SELECT matches(pg_temp.ask('vesna', $$ UPDATE institution.work_milestone SET due_at = now() WHERE true RETURNING 1 $$), '^42501',
  'the web role cannot update the table');
SELECT matches(pg_temp.ask('ana', $$ INSERT INTO institution.work_milestone (institution_id, assignment_id, student_id, position, title, due_at)
  VALUES ({fak_a}, {z1}, {ana}, 9, 'Moja etapa', now()) RETURNING 1 $$), '^42501', 'a student cannot add a milestone to her work');
SELECT matches(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.work_milestone $$), '^42501', 'a student cannot read the table');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ UPDATE institution.work_milestone SET title = 'Drugo' WHERE id = {m2} RETURNING 1 $$),
  'ZD403: only the due date of a milestone changes', 'not even the owner role changes a title');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ UPDATE institution.work_milestone SET state = 'done' WHERE id = {m2} RETURNING 1 $$),
  'ZD403: only the due date of a milestone changes', 'nor a state');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ DELETE FROM institution.work_milestone WHERE id = {m2} RETURNING 1 $$),
  'ZD403: only the due date of a milestone changes', 'nor removes one');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ TRUNCATE institution.work_milestone $$),
  'ZD403: only the due date of a milestone changes', 'nor truncates the table');
SELECT matches(pg_temp.ask_as('ductus_identity', 'anon', $$ INSERT INTO institution.work_milestone (institution_id, assignment_id, student_id, position, title, due_at)
  VALUES ({fak_b}, {z1}, {ana}, 9, 'Preko ustanova', now()) RETURNING 1 $$), '^23503',
  'a milestone cannot combine an assignment and a student of another institution');

-- 5. A submitted work has no change action; it still reads as it was.
INSERT INTO ref SELECT 'z1_due', due_at::text FROM institution.assignment_version
 WHERE assignment_id = pg_temp.id('z1') AND version_no = 1;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('a', 64));
INSERT INTO evidence.submission_request (id, institution_id, assignment_id, assignment_version, project_id, document_id,
                                         principal_id, revision, content_hash, requested_at)
VALUES ('00000000-0000-4000-8000-000000000f01', pg_temp.id('fak_a'), pg_temp.id('z1'), 1, 'project-a', 'doc-a',
        pg_temp.id('ana'), 1, repeat('a', 64), now());
INSERT INTO evidence.submission (submission_request_id, institution_id, principal_id, assignment_id, assignment_version,
                                 revision, artifact_hash, requested_at, due_at, recorded_at)
VALUES ('00000000-0000-4000-8000-000000000f01', pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 1, 1, repeat('a', 64), now(),
        (SELECT val::timestamptz FROM ref WHERE name = 'z1_due'), now());
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
SELECT is(pg_temp.setdue('vesna', 'doc-a', '{m3}', '2027-03-20T09:30:00Z'), 'locked',
  'once Ana''s work is submitted the teacher has no change action');
SELECT is(pg_temp.setdue('ana', 'doc-a', '{m3}', '2027-03-20T09:30:00Z'), 'forbidden', 'and the student still has none');
SELECT is(pg_temp.read('vesna', 'doc-a') LIKE '%Izmišljena završnica:2027-03-10T12:00:open', true,
  'the submitted work''s milestones read as they were');
SELECT is(pg_temp.read('ana', 'doc-a'), pg_temp.read('vesna', 'doc-a'), 'for the student and the teacher alike');
SELECT is(pg_temp.setdue('vesna', 'doc-a', '{mb}', '2027-03-20T09:30:00Z'), 'not_found',
  'another work''s milestone is still not found through it');

SELECT * FROM finish();
ROLLBACK;
