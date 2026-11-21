BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/work-reach.inc
SELECT no_plan();

INSERT INTO ref VALUES
  ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 190 A') $$)),
  ('g2', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 190 B') $$)),
  ('other_group', pg_temp.ask('marko', $$ SELECT institution.create_seminar_group({k2}, 'Grupa 190 C') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.set_course_holder({k1}, {vesna}) $$),
  'ok', 'the confirmed course teacher is its holder');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');
SELECT is(pg_temp.ask('marko', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$),
  'ZD403: forbidden', 'even a full course teacher who is not its holder cannot change the team');
UPDATE institution.course_member SET member_to = now()
WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('marko') AND role = 'teacher';
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{marko}]::uuid[]) $$),
  'ok', 'the holder can add a confirmed assistant');
SELECT is(pg_temp.ask('marko', $$ SELECT assistant_ids::text FROM institution.read_teaching_team({k1}) $$),
  ARRAY[pg_temp.id('marko')]::text, 'the assistant can read the roster before receiving any group');
GRANT SELECT ON institution.course_assistant TO ductus_app;
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.course_assistant $$), '0',
  'forced RLS hides the populated roster table even with a temporary web grant');
REVOKE SELECT ON institution.course_assistant FROM ductus_app;
SELECT is(pg_temp.ask('marko', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$),
  'ZD403: forbidden', 'a roster member cannot change the team');
SELECT is(pg_temp.ask('iva', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$),
  'ZD403: forbidden', 'the administrator cannot change the team through this RPC');
SELECT is(pg_temp.ask('ana', $$ SELECT holder_id FROM institution.read_teaching_team({k1}) $$),
  'ZD403: forbidden', 'a student cannot read the roster');
SELECT is(pg_temp.ask('anon', $$ SELECT holder_id FROM institution.read_teaching_team({k1}) $$),
  'ZD401: not authenticated', 'the roster requires a live session');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{petra}]::uuid[]) $$),
  'ZD422: invalid input', 'a teacher from another institution cannot join the team');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{vesna}]::uuid[]) $$),
  'ZD422: invalid input', 'the holder cannot add herself as a group-scoped assistant');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{marko},{marko}]::uuid[]) $$),
  'ZD422: invalid input', 'duplicate assistants are refused even at the RPC boundary');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {other_group}, '{}'::uuid[], '{}'::uuid[]) $$),
  'ZD403: forbidden', 'the group must belong to the specified course');
SELECT is(pg_temp.ask('marko', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g1}, '{}'::uuid[], '{}'::uuid[]) $$),
  'ZD403: forbidden', 'the assistant cannot change group membership');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g1}, ARRAY[{marko}]::uuid[], ARRAY[{ana}]::uuid[]) $$),
  'ok', 'the holder puts the assistant and the first student in group A');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g2}, '{}'::uuid[], ARRAY[{dora}]::uuid[]) $$),
  'ok', 'the second student is in group B');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g1}, '{}'::uuid[], ARRAY[{dora}]::uuid[]) $$),
  'ZD409: conflict', 'a student cannot be assigned to two groups and the replacement rolls back');

CREATE TEMP TABLE work (id text PRIMARY KEY, owner text);
INSERT INTO work VALUES ('doc-team190-a', 'ana'), ('doc-team190-b', 'dora');
GRANT SELECT ON work TO PUBLIC;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
SELECT 'project-' || w.id, pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id(w.owner) FROM work w;
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
SELECT w.id, pg_temp.id('fak_a'), 'project-' || w.id, pg_temp.id(w.owner), pg_temp.text_hash() FROM work w;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
SELECT w.id, pg_temp.id('fak_a'), 0, pg_temp.id(w.owner), pg_temp.text_hash() FROM work w;
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body, content_hash, created_at)
SELECT w.id, pg_temp.id('fak_a'), 0, 'Prvi odlomak.', pg_temp.text_hash(), now() FROM work w;
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

SELECT is(pg_temp.reach('marko', 'doc-team190-a'), 'text,comments,summary,replay,checkpoints,fast_path,comment',
  'the assistant reaches only the work started in his own group, which survived the failed PUT');
SELECT is(pg_temp.reach('marko', 'doc-team190-b'), '-', 'no surface opens the work of the other group');
SELECT is(pg_temp.can('marko', 'doc-team190-b'), '-', 'the shared decision refuses the other group by document id');
SELECT is(pg_temp.lists('marko'), pg_temp.all_lists('ana', 'doc-team190-a'),
  'rosters and assignment lists respect the same boundary');
SELECT is(pg_temp.can('vesna', 'doc-team190-b'), 'read,comment,open_fast_path,propose',
  'the holder retains course-wide access');

SELECT pg_temp.tick();
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$),
  'ok', 'omitting the assistant revokes the roster role and closes his group places');
SELECT is(pg_temp.reach('marko', 'doc-team190-a'), '-', 'the existing session immediately loses the work');
SELECT is(pg_temp.lists('marko'), pg_temp.all_lists('-', '-'), 'the existing session loses the lists');
SELECT is(pg_temp.ask('marko', $$ SELECT holder_id FROM institution.read_teaching_team({k1}) $$),
  'ZD403: forbidden', 'the existing session loses the roster');
SELECT is(pg_temp.ask('iva', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$),
  'ok', 'the pre-existing group management RPC can still record a group place');
SELECT is(pg_temp.can('marko', 'doc-team190-a'), '-', 'a group place alone cannot override the roster revocation');
SELECT is(pg_temp.lists('marko'), pg_temp.all_lists('-', '-'), 'a legacy reassign does not restore the lists');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{marko}]::uuid[]) $$),
  'ok', 'the holder may re-add the assistant');
SELECT is(pg_temp.lists('marko'), pg_temp.all_lists('-', '-'), 're-adding the assistant does not restore old group places');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g1}, ARRAY[{marko}]::uuid[], ARRAY[{ana}]::uuid[]) $$),
  'ok', 'a new assignment requires a new PUT');
SELECT is(pg_temp.can('marko', 'doc-team190-a'), '-', 'a new place does not reopen earlier work');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g1}, '{}'::uuid[], ARRAY[{ana}]::uuid[]) $$),
  'ok', 'the holder can remove the assistant from the group while keeping him on the team');
SELECT is(pg_temp.lists('marko'), pg_temp.all_lists('-', '-'), 'group removal immediately closes even the student list');

SELECT * FROM finish();
ROLLBACK;
