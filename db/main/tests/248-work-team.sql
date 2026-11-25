-- SRV-V19-GRUPA-BAZA (val 19, docs/contracts/work-team-v1.md): teams of students
-- on an assignment. The teacher turns teams on per assignment; students form
-- teams or the teacher does; a student sees only their own team; a member
-- leaves (or is removed) only until their own part is submitted; every record
-- is only ever added; anything that is not the relation (another course,
-- another institution, an unknown id) is the same refusal. Personas of
-- institution.inc and evidence-acceptance.inc. Added here: Boris joins K1 (a
-- third student), Dora has a submitted part on Z1 (added late), Ana has an
-- opened work on Z1 (the fixture). Names are invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
SELECT pg_temp.id(n.who), pg_temp.id('fak_a'), n.given, n.family
  FROM (VALUES ('ana', 'Ana', 'Horvat'), ('dora', 'Dora', 'Babić'), ('boris', 'Boris', 'Anić')) AS n (who, given, family);

-- 'ok' or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.code(p_actor text, p_sql text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE 'ok' END FROM (SELECT pg_temp.ask(p_actor, p_sql) AS r) x
$$;
-- The team state of a student as one line: kind, then names or counts.
CREATE FUNCTION pg_temp.state(p_actor text, p_assignment text DEFAULT '{z1}') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT string_agg(concat_ws(' ', row_kind, formation, member_count, given_name, family_name), ' / ')
      FROM app.student_team(%s) $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.setting(p_actor text, p_assignment text DEFAULT '{z1}') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT concat_ws('|', enabled, min_size, max_size, formation) FROM app.assignment_team_setting(%s) $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.set_setting(p_actor text, p_enabled text, p_min text, p_max text, p_formation text,
                                    p_assignment text DEFAULT '{z1}') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.code(p_actor, format('SELECT 1 FROM app.set_assignment_team_setting(%s, %s, %s, %s, %s)',
                                      p_assignment, p_enabled, p_min, p_max, p_formation))
$$;
-- The team of a student by the owner's reading of the record.
CREATE FUNCTION pg_temp.team_of(p_student text) RETURNS uuid LANGUAGE sql AS $$
  SELECT team_id FROM institution.work_team_members_now(pg_temp.id('z1'))
   WHERE student_id = pg_temp.id(p_student)
$$;

-- Catalogue: forced RLS, no direct privilege, no runtime role on the record.
SELECT is((SELECT string_agg(format('%s|%s|%s', c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole), ',' ORDER BY c.relname)
             FROM pg_class c WHERE c.oid = ANY (ARRAY['institution.assignment_team_setting'::regclass,
                  'institution.work_team'::regclass, 'institution.work_team_member_event'::regclass])),
  't|t|ductus_identity,t|t|ductus_identity,t|t|ductus_identity', 'the tables belong to the identity role, with RLS forced');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  CROSS JOIN unnest(ARRAY['institution.assignment_team_setting', 'institution.work_team',
                          'institution.work_team_member_event']) AS t
  WHERE has_table_privilege(r, t, p)
), 'no runtime role reads or writes the teams directly');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.work_team $$), '42501: permission denied for table work_team',
  'the web role reads no team table');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.work_team_part_states({z1}::uuid, ARRAY[{ana}::uuid]) $$),
  '42501: permission denied for function work_team_part_states', 'the evidence helper is not callable by the web role');

-- Before any setting: teams are off for everybody, and only the teachers of K1 read the setting.
SELECT is(pg_temp.setting('vesna'), 'f|2|6|student_choice', 'an assignment with no setting reads as teams off');
SELECT is(pg_temp.code(a.name, 'SELECT 1 FROM app.assignment_team_setting({z1})'), 'ZD404', a.name || ' does not read the setting of Z1')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('lea'), ('tomo')) AS a (name);
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.assignment_team_setting({z1})'), 'ZD401', 'without a session nothing is read');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.assignment_team_setting({z3})'), 'ZD404', 'Vesna does not read another institution''s assignment');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.assignment_team_setting({nobody})'), 'ZD404', 'an unknown assignment reads 404');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.assignment_team_setting(NULL)'), 'ZD404', 'a missing assignment reads 404');
SELECT is(pg_temp.state('ana'), 'disabled student_choice', 'Ana sees teams are off');
SELECT is(pg_temp.code('ana', $$ SELECT 1 FROM app.team_action({z1}, 'create', NULL) $$), 'ZD409', 'a team cannot be created while teams are off');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.teacher_create_team({z1})'), 'ZD409', 'the teacher cannot create a team while teams are off');

-- Writing the setting: the teachers of K1 only; closed input.
SELECT is(pg_temp.set_setting(a.name, 'true', '2', '3', '''student_choice'''), 'ZD404', a.name || ' does not set the setting of Z1')
FROM (VALUES ('ana'), ('marko'), ('iva'), ('boris'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.set_setting('anon', 'true', '2', '3', '''student_choice'''), 'ZD401', 'without a session nothing is set');
SELECT is(pg_temp.set_setting('vesna', 'true', '2', '3', '''student_choice''', '{z3}'), 'ZD404', 'another institution''s assignment is not set');
SELECT is(pg_temp.set_setting('vesna', v.e, v.mn, v.mx, v.f), 'ZD422', 'refused: ' || v.why)
FROM (VALUES ('true', '3', '2', '''student_choice''', 'minSize above maxSize'),
             ('true', '1', '3', '''student_choice''', 'minSize 1'),
             ('true', '2', '7', '''student_choice''', 'maxSize 7'),
             ('true', '2', '3', '''whoever''', 'unknown formation'),
             ('true', '2', '3', 'NULL', 'no formation'),
             ('NULL', '2', '3', '''student_choice''', 'no enabled'),
             ('true', 'NULL', '3', '''student_choice''', 'no minSize'),
             ('true', '2', 'NULL', '''student_choice''', 'no maxSize')) AS v (e, mn, mx, f, why);
SELECT is((SELECT count(*)::integer FROM institution.assignment_team_setting), 0, 'a refused setting leaves no version');
SELECT is(pg_temp.set_setting('vesna', 'true', '2', '2', '''student_choice'''), 'ok', 'Vesna turns teams on, two members at most');
SELECT is(pg_temp.setting('vesna'), 't|2|2|student_choice', 'the setting in force is the new one');
SELECT is(pg_temp.setting('vesna', '{z2}'), 'ZD404: not found', 'Vesna does not read the setting of Z2');
SELECT is(pg_temp.setting('marko', '{z2}'), 'f|2|6|student_choice', 'Z2 of Marko has its own (default) setting');

-- Students form teams: create, join, one team only, names only of the own team.
SELECT is(pg_temp.state('dora'), 'none student_choice', 'Dora has no team and sees no open team yet');
SELECT is(pg_temp.code('ana', $$ SELECT 1 FROM app.team_action({z1}, 'create', NULL) $$), 'ok', 'Ana creates a team');
SELECT is(pg_temp.state('ana'), 'member student_choice Ana Horvat', 'Ana is the first member of her team');
SELECT is(pg_temp.code('ana', $$ SELECT 1 FROM app.team_action({z1}, 'create', NULL) $$), 'ZD409', 'a second team of the same student is refused');
SELECT is(pg_temp.state('dora'), 'none student_choice / open student_choice 1',
  'Dora sees the open team as a count, without a name');
SELECT is(pg_temp.state('dora') !~ 'Horvat', true, 'no name of another team reaches Dora');
SELECT is(pg_temp.code('dora', format($$ SELECT 1 FROM app.team_action({z1}, 'join', %L) $$, pg_temp.team_of('ana'))), 'ok', 'Dora joins the open team');
SELECT is(pg_temp.state('dora'), 'member student_choice Dora Babić / member student_choice Ana Horvat',
  'members are in the order of family name, given name');
SELECT is(pg_temp.state('ana'), pg_temp.state('dora'), 'both members see the same team');
SELECT is(pg_temp.code('dora', format($$ SELECT 1 FROM app.team_action({z1}, 'join', %L) $$, pg_temp.team_of('ana'))), 'ZD409', 'a member does not join a second time');

INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('boris'), 'student');
SELECT is(pg_temp.state('boris'), 'none student_choice', 'a full team is not offered');
SELECT is(pg_temp.code('boris', format($$ SELECT 1 FROM app.team_action({z1}, 'join', %L) $$, pg_temp.team_of('ana'))), 'ZD409',
  'joining a team above the most members is refused');
SELECT is(pg_temp.code('boris', $$ SELECT 1 FROM app.team_action({z1}, 'join', gen_random_uuid()) $$), 'ZD404', 'an unknown team reads 404');
SELECT is(pg_temp.code(a.name, format($$ SELECT 1 FROM app.team_action({z1}, 'join', %L) $$, pg_temp.team_of('ana'))), 'ZD404',
  a.name || ' is no student of Z1')
FROM (VALUES ('vesna'), ('marko'), ('iva'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.code('anon', $$ SELECT 1 FROM app.team_action({z1}, 'create', NULL) $$), 'ZD401', 'without a session nothing is changed');
SELECT is(pg_temp.code('boris', $$ SELECT 1 FROM app.team_action({z3}, 'create', NULL) $$), 'ZD404', 'a student of another course creates nothing on Z3');
SELECT is(pg_temp.code('boris', format($$ SELECT 1 FROM app.team_action({z1}, %s, %s) $$, v.a, v.t)), 'ZD422', 'refused: ' || v.why)
FROM (VALUES ('NULL', 'NULL', 'no action'), ('''dissolve''', 'NULL', 'unknown action'), ('''join''', 'NULL', 'join without a team'),
             ('''create''', 'gen_random_uuid()', 'create with a team'), ('''leave''', 'gen_random_uuid()', 'leave with a team')) AS v (a, t, why);
SELECT is(pg_temp.code('boris', $$ SELECT 1 FROM app.team_action({z1}, 'leave', NULL) $$), 'ZD409', 'leaving without a team is refused');

-- A setting that would leave a team above the most members is refused.
SELECT is(pg_temp.set_setting('vesna', 'true', '2', '3', '''student_choice'''), 'ok', 'Vesna widens the team to three');
SELECT is(pg_temp.code('boris', format($$ SELECT 1 FROM app.team_action({z1}, 'join', %L) $$, pg_temp.team_of('ana'))), 'ok', 'Boris joins as the third member');
SELECT is(pg_temp.set_setting('vesna', 'true', '2', '2', '''student_choice'''), 'ZD409', 'narrowing below an existing team is refused');
SELECT is(pg_temp.code('boris', $$ SELECT 1 FROM app.team_action({z1}, 'leave', NULL) $$), 'ok', 'Boris leaves the team');
SELECT is(pg_temp.team_of('boris') IS NULL, true, 'Boris is in no team afterwards');
SELECT is(pg_temp.set_setting('vesna', 'true', '2', '2', '''student_choice'''), 'ok', 'the setting can be narrowed now');
SELECT is((SELECT count(*)::integer FROM institution.assignment_team_setting), 3, 'every accepted setting is a version');

-- The teacher: the teams as facts (the own part: opened, submitted, not started), the unassigned.
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(family_name || ' ' || work_state, ', ' )
                                      FROM app.teacher_teams({z1}) $$),
  'Babić not_started, Horvat in_progress, Anić not_started',
  'before any submission: members in alphabetical order, then the unassigned');

-- Dora's part is submitted (the record is written by the evidence owner, as the submission is in the real flow).
CREATE TEMP TABLE due AS
SELECT due_at AS z1_due FROM institution.assignment_version WHERE assignment_id = pg_temp.id('z1') AND version_no = 2;
GRANT SELECT ON due TO PUBLIC;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
VALUES ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
VALUES ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), pg_temp.h('d'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-d', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('dora'), pg_temp.h('d')),
       ('doc-d', pg_temp.id('fak_a'), 1, 0, pg_temp.id('dora'), pg_temp.h('e'));
INSERT INTO evidence.submission_request (id, institution_id, assignment_id, assignment_version, project_id, document_id,
                                         principal_id, revision, content_hash, requested_at)
SELECT '00000000-0000-4000-8000-0000000000e2', pg_temp.id('fak_a'), pg_temp.id('z1'), 2, 'project-d', 'doc-d',
       pg_temp.id('dora'), 1, pg_temp.h('e'), now() - interval '1 hour';
INSERT INTO evidence.submission (submission_request_id, institution_id, principal_id, assignment_id, assignment_version,
                                 revision, artifact_hash, requested_at, due_at, recorded_at)
SELECT q.id, q.institution_id, q.principal_id, q.assignment_id, q.assignment_version, q.revision, q.content_hash,
       q.requested_at, (SELECT z1_due FROM due),
       q.requested_at + interval '2 seconds'
  FROM evidence.submission_request q WHERE q.principal_id = pg_temp.id('dora');
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(concat_ws(' ', family_name, work_state), ', ') FROM app.teacher_teams({z1}) $$),
  'Babić submitted, Horvat in_progress, Anić not_started', 'a submitted part is a fact on the member');
SELECT is(pg_temp.code('dora', $$ SELECT 1 FROM app.team_action({z1}, 'leave', NULL) $$), 'ZD409', 'a member cannot leave after their part was submitted');
SELECT is(pg_temp.code('ana', $$ SELECT 1 FROM app.team_action({z1}, 'leave', NULL) $$), 'ok', 'a member whose part is not submitted can leave');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(coalesce(family_name, '-') || ':' || (team_id IS NOT NULL), ', ') FROM app.teacher_teams({z1}) $$),
  'Babić:true, Anić:false, Horvat:false', 'a leaver is unassigned; the team stays with its remaining member');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {dora}, 'remove') $$, pg_temp.team_of('dora'))), 'ZD409',
  'the teacher cannot remove a member whose part was submitted');

-- The teacher forms teams: create an empty team, add and remove.
CREATE TEMP TABLE made (team uuid);
INSERT INTO made SELECT t FROM (SELECT x::uuid AS t FROM (SELECT pg_temp.ask('vesna', 'SELECT app.teacher_create_team({z1})::text') AS x) y) z;
GRANT SELECT ON made TO PUBLIC;
SELECT is((SELECT count(*)::integer FROM institution.work_team), 2, 'the teacher made a second team, empty');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.teacher_teams({z1}) WHERE student_id IS NULL AND team_id IS NOT NULL $$), '1',
  'an empty team is listed');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {ana}, 'add') $$, (SELECT team FROM made))), 'ok', 'Vesna adds Ana to the empty team');
SELECT is(pg_temp.state('ana'), 'member student_choice Ana Horvat', 'Ana sees her new team');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {ana}, 'add') $$, (SELECT team FROM made))), 'ZD409', 'a student already in a team is not added again');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, pg_temp.team_of('dora'))), 'ok', 'Vesna fills the other team to two');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'remove') $$, pg_temp.team_of('dora'))), 'ok', 'Vesna removes Boris again');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {ana}, 'remove') $$, pg_temp.team_of('dora'))), 'ZD404', 'removing a student who is not in that team reads 404');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made))), 'ok', 'a second member fits the team');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'remove') $$, (SELECT team FROM made))), 'ok', 'and is removed again');

-- A student who withdrew from the course stays a member of the team until removed:
-- the teacher can remove them (20261219330000), and then they are gone from the
-- list and from the places of the team.
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made))), 'ok', 'Boris joins the teacher''s team');
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('boris');
SELECT is(pg_temp.ask('vesna', format($$ SELECT count(*) FROM app.teacher_teams({z1}) WHERE team_id = %L AND student_id = {boris} $$, (SELECT team FROM made))), '1',
  'a withdrawn student is still listed as a member of the team');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, pg_temp.team_of('dora'))), 'ZD404',
  'a withdrawn student is not added to a team');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'remove') $$, pg_temp.team_of('dora'))), 'ZD404',
  'removing a withdrawn student from a team they are not in reads 404');
SELECT is(pg_temp.code('tomo', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'remove') $$, (SELECT team FROM made))), 'ZD404',
  'a teacher of another course cannot remove them');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'remove') $$, (SELECT team FROM made))), 'ok',
  'the teacher removes a member who withdrew from the course');
SELECT is(pg_temp.ask('vesna', format($$ SELECT count(*) FROM app.teacher_teams({z1}) WHERE student_id = {boris} $$)), '0',
  'the withdrawn student is gone from the teams and is not listed as unassigned');
UPDATE institution.course_member SET member_to = NULL WHERE user_id = pg_temp.id('boris');

-- Who may add: not a student, not the other teachers, not another institution; closed input.
SELECT is(pg_temp.code(a.name, format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made))), 'ZD404',
  a.name || ' does not add to a team of Z1')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('marko'), ('iva'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.code('anon', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made))), 'ZD401', 'without a session nothing is added');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, %s, 'add') $$, (SELECT team FROM made), s.who)), 'ZD404',
  'not a student of Z1: ' || s.who)
FROM (VALUES ('{vesna}'), ('{tomo}'), ('{iva}'), ('{nina}'), ('{nobody}'), ('NULL')) AS s (who);
SELECT is(pg_temp.code('vesna', $$ SELECT 1 FROM app.teacher_team_member({z1}, gen_random_uuid(), {boris}, 'add') $$), 'ZD404', 'an unknown team reads 404');
SELECT is(pg_temp.code('vesna', $$ SELECT 1 FROM app.teacher_team_member({z1}, NULL, {boris}, 'add') $$), 'ZD404', 'a missing team reads 404');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, %s) $$, (SELECT team FROM made), v.a)), 'ZD422', 'refused action ' || v.a)
FROM (VALUES ('NULL'), ('''move'''), ('''ADD''')) AS v (a);

-- The team of another assignment is not a team of this one (404 both ways), and another teacher reads none of ours.
SELECT is(pg_temp.set_setting('marko', 'true', '2', '3', '''teacher_assigned''', '{z2}'), 'ok', 'Marko turns teams on for Z2');
CREATE TEMP TABLE made2 (team uuid);
INSERT INTO made2 SELECT x::uuid FROM (SELECT pg_temp.ask('marko', 'SELECT app.teacher_create_team({z2})::text') AS x) y;
GRANT SELECT ON made2 TO PUBLIC;
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made2))), 'ZD404',
  'a team of Z2 is not a team of Z1');
SELECT is(pg_temp.code('marko', format($$ SELECT 1 FROM app.teacher_team_member({z2}, %L, {boris}, 'add') $$, (SELECT team FROM made2))), 'ZD404',
  'Boris is no student of Z2');
SELECT is(pg_temp.code('marko', 'SELECT 1 FROM app.teacher_teams({z1})'), 'ZD404', 'Marko does not read the teams of Z1');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.teacher_teams({z2})'), 'ZD404', 'Vesna does not read the teams of Z2');
SELECT is(pg_temp.code(a.name, 'SELECT 1 FROM app.teacher_teams({z1})'), 'ZD404', a.name || ' does not list the teams of Z1')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('iva'), ('nina'), ('petra'), ('lea'), ('tomo')) AS a (name);
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.teacher_teams({z1})'), 'ZD401', 'without a session nothing is listed');
SELECT is(pg_temp.code(a.name, 'SELECT 1 FROM app.student_team({z1})'), 'ZD404', a.name || ' has no team state on Z1')
FROM (VALUES ('vesna'), ('marko'), ('iva'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.student_team({z1})'), 'ZD401', 'without a session no team state');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.teacher_create_team({z3})'), 'ZD404', 'no team on another institution''s assignment');
SELECT is(pg_temp.code('ana', 'SELECT 1 FROM app.teacher_create_team({z1})'), 'ZD404', 'a student creates no teacher team');

-- Teacher formation: students create and join nothing, but a member can still leave.
SELECT is(pg_temp.set_setting('vesna', 'true', '2', '3', '''teacher_assigned'''), 'ok', 'Vesna lets herself form the teams');
SELECT is(pg_temp.state('dora') ~ '^member teacher_assigned', true, 'a member still sees the team');
SELECT is(pg_temp.state('boris'), 'none teacher_assigned', 'Boris sees no open team when the teacher forms them');
SELECT is(pg_temp.code('boris', $$ SELECT 1 FROM app.team_action({z1}, 'create', NULL) $$), 'ZD409', 'a student creates no team when the teacher forms them');
SELECT is(pg_temp.code('boris', format($$ SELECT 1 FROM app.team_action({z1}, 'join', %L) $$, pg_temp.team_of('dora'))), 'ZD409', 'a student joins no team when the teacher forms them');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made))), 'ok', 'the teacher adds Boris');
SELECT is(pg_temp.code('boris', $$ SELECT 1 FROM app.team_action({z1}, 'leave', NULL) $$), 'ok', 'a member of a teacher-formed team can leave');
SELECT is(pg_temp.set_setting('vesna', 'false', '2', '3', '''teacher_assigned'''), 'ok', 'Vesna turns teams off again');
SELECT is(pg_temp.state('dora'), 'disabled teacher_assigned', 'with teams off the students see no teams');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {boris}, 'add') $$, (SELECT team FROM made))), 'ZD409', 'nobody is added while teams are off');
SELECT is(pg_temp.code('vesna', format($$ SELECT 1 FROM app.teacher_team_member({z1}, %L, {ana}, 'remove') $$, (SELECT team FROM made))), 'ZD409', 'nobody is removed while teams are off');
SELECT is(pg_temp.team_of('ana') = (SELECT team FROM made), true, 'Ana is still in her team');

-- The record: only added. The owner cannot change or remove it either.
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', format($$ UPDATE %s SET created_at = now() RETURNING 1 $$, 'institution.work_team')),
  'ZD409: conflict', 'a team is never changed');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ UPDATE institution.work_team_member_event SET action = 'join' RETURNING 1 $$),
  'ZD409: conflict', 'a membership event is never changed');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ DELETE FROM institution.work_team_member_event RETURNING 1 $$),
  'ZD409: conflict', 'a membership event is never removed');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ DELETE FROM institution.work_team RETURNING 1 $$), 'ZD409: conflict', 'a team is never deleted');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ UPDATE institution.assignment_team_setting SET enabled = true RETURNING 1 $$),
  'ZD409: conflict', 'a setting version is never changed');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ DELETE FROM institution.assignment_team_setting RETURNING 1 $$),
  'ZD409: conflict', 'a setting version is never removed');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ TRUNCATE institution.work_team_member_event $$), 'ZD409: conflict', 'no truncate of the events');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ TRUNCATE institution.work_team CASCADE $$), 'ZD409: conflict', 'no truncate of the teams');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ TRUNCATE institution.assignment_team_setting $$), 'ZD409: conflict', 'no truncate of the settings');

-- The events carry the author and the part (student on themselves, teacher on a student); a student cannot act for another.
SELECT is((SELECT count(*)::integer FROM institution.work_team_member_event e
            WHERE e.actor_role = 'student' AND e.actor_id <> e.student_id), 0, 'a student acted only on themselves');
SELECT is((SELECT count(*)::integer FROM institution.work_team_member_event e
            WHERE e.actor_role = 'teacher' AND e.actor_id = pg_temp.id('vesna')), 8, 'the teacher''s events carry the teacher');
SELECT throws_ok(
  format($$ INSERT INTO institution.work_team_member_event (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
            VALUES (%L, %L, %L, %L, 'join', %L, 'student') $$,
    pg_temp.id('fak_a'), pg_temp.id('z1'), (SELECT team FROM made), pg_temp.id('boris'), pg_temp.id('ana')),
  '23514', NULL, 'a student event written for another student is refused by the table');
SELECT throws_ok(
  format($$ INSERT INTO institution.work_team_member_event (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
            VALUES (%L, %L, %L, %L, 'join', %L, 'teacher') $$,
    pg_temp.id('fak_a'), pg_temp.id('z1'), (SELECT team FROM made2), pg_temp.id('boris'), pg_temp.id('vesna')),
  '23503', NULL, 'an event cannot name the team of another assignment');

SELECT * FROM finish();
ROLLBACK;
