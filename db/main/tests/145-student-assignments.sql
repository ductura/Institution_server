-- SRV-08 (Ductus#2028, c.7008147932; owner answer A-3): institution.student_assignments.
-- A student reads the assignments of their own courses only, with the course's
-- academic year, the work type, their own seminar groups and the teachers of
-- those groups, and the confirmed teachers of the course as holder or
-- collaborator. No other student is named; a teacher, a user in no course, a
-- removed student and another institution read nothing of K1.
-- Every person, course and group below is invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(28);

-- K1: Vesna holds it, Marko collaborates, Nina is a member whose teacher role
-- nobody confirmed. Group A: Ana, taught by Marko; group B: Dora, by Vesna.
INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
SELECT pg_temp.id(n.name), pg_temp.id('fak_a'), n.given_name, 'Izmišljena'
FROM (VALUES ('vesna', 'Vesna'), ('marko', 'Marko'), ('nina', 'Nina'), ('ana', 'Ana'), ('dora', 'Dora')) AS n (name, given_name);
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher'),
       (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('nina'), 'teacher');
INSERT INTO institution.course_holder (course_id, institution_id, user_id, assigned_by)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.id('iva'));
INSERT INTO ref VALUES ('ga', '00000000-0000-4000-8000-0000000000e1'), ('gb', '00000000-0000-4000-8000-0000000000e2');
INSERT INTO institution.seminar_group (id, course_id, institution_id, name, created_by)
VALUES (pg_temp.id('ga'), pg_temp.id('k1'), pg_temp.id('fak_a'), 'Grupa A', pg_temp.id('vesna')),
       (pg_temp.id('gb'), pg_temp.id('k1'), pg_temp.id('fak_a'), 'Grupa B', pg_temp.id('vesna'));
INSERT INTO institution.seminar_group_member (group_id, course_id, institution_id, user_id, assigned_by)
VALUES (pg_temp.id('ga'), pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('vesna')),
       (pg_temp.id('gb'), pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('vesna'));
INSERT INTO institution.seminar_group_teacher (group_id, course_id, institution_id, user_id, assigned_by)
VALUES (pg_temp.id('ga'), pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), pg_temp.id('vesna')),
       (pg_temp.id('gb'), pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.id('vesna'));

CREATE FUNCTION pg_temp.read(p_actor text, p_columns text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(string_agg(%s, ' | ' ORDER BY s.assignment_id), '-') FROM institution.student_assignments() s $q$,
    p_columns))
$$;
CREATE FUNCTION pg_temp.person(p_name text, p_full text, p_role text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', pg_temp.id(p_name), 'name', p_full, 'role', p_role))
$$;

-- 1. Who reads which assignments.
SELECT is(pg_temp.read(v.actor, $$ (SELECT name FROM ref WHERE val = s.assignment_id::text) $$), v.seen, v.actor || ' ' || v.what)
FROM (VALUES
  (1, 'ana', 'z1', 'reads Z1 of her course K1, not Z2 of K2 or Z3 of fak-b'),
  (2, 'dora', 'z1', 'reads Z1 as well'),
  (3, 'tomo', 'z3', 'of fak-b reads Z3 of his course only'),
  (4, 'boris', '-', 'in no course reads nothing'),
  (5, 'vesna', '-', 'teaches K1 and is no student: reads nothing'),
  (6, 'iva', '-', 'the administrator, without a membership, reads nothing')
) AS v (n, actor, seen, what)
ORDER BY v.n;
SELECT is(pg_temp.read('anon', 's.title'), 'ZD401: not authenticated', 'without a session the read is refused');
SELECT is(pg_temp.read('expired', 's.title'), 'ZD401: not authenticated', 'with an expired session as well');

-- 2. The fields of A-3.
SELECT is(
  pg_temp.read('ana', $$ concat_ws(' ', s.course_name, s.academic_year, s.title, s.work_type, s.current_version,
                                    coalesce(s.extended_due_at::text, 'none'), s.due_at = (SELECT due_at FROM institution.assignment_version WHERE assignment_id = {z1} AND version_no = 2)) $$),
  'K1 2026/2027 Z1 essay 2 none t',
  'Ana: course, academic year, title, work type and current version; no extended deadline is stored'
);
-- F4-STU-R02: whether the assignment is a practice one (20261220210000).
SELECT is(pg_temp.read('ana', 's.is_practice::text'), 'false', 'Ana: Z1 is no practice assignment');
-- The fixture's Z3 becomes a practice assignment; the status is immutable
-- (assignment_practice_immutable), so only for this setup, as in 031.
SET LOCAL session_replication_role = replica;
UPDATE institution.assignment SET is_practice = true WHERE id = pg_temp.id('z3');
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.read('tomo', 's.is_practice::text'), 'true', 'Tomo: Z3 of his course is a practice assignment');
SELECT is(pg_temp.read('ana', 's.groups::text'), '{"Grupa A"}', 'Ana: her own group only');
SELECT is(pg_temp.read('dora', 's.groups::text'), '{"Grupa B"}', 'Dora: her own group only');
SELECT is(pg_temp.read('ana', 's.mentors::text'), jsonb_build_array(pg_temp.person('marko', 'Marko Izmišljena'))::text,
          'Ana: the teacher of her group is Marko');
SELECT is(pg_temp.read('dora', 's.mentors::text'), jsonb_build_array(pg_temp.person('vesna', 'Vesna Izmišljena'))::text,
          'Dora: the teacher of her group is Vesna');
SELECT is(
  pg_temp.read('ana', 's.teachers::text'),
  jsonb_build_array(pg_temp.person('vesna', 'Vesna Izmišljena', 'holder'),
                    pg_temp.person('marko', 'Marko Izmišljena', 'collaborator'))::text,
  'the teachers of K1: Vesna the holder, Marko a collaborator, never Nina whose role nobody confirmed'
);
SELECT is(pg_temp.read('dora', 's.teachers::text'), pg_temp.read('ana', 's.teachers::text'), 'Dora reads the same teachers');
SELECT is(
  pg_temp.read('tomo', 'concat_ws('' '', s.groups::text, s.mentors::text, s.teachers::text)'),
  format('{} [] [{"id": "%s", "name": null, "role": "collaborator"}]', pg_temp.id('petra')),
  'Tomo: no group, no group teacher; Petra without a stored name and without a holder row is a collaborator'
);
SELECT is(pg_temp.read('ana', 's.acknowledged::text') || ' ' || pg_temp.read('dora', 's.acknowledged::text'), 'true false',
          'Ana acknowledged the current version, Dora only the first');
SELECT is(pg_temp.read('ana', 's.notice_read::text'), 'false', 'Ana has not marked the notice as read');
SELECT isnt(pg_temp.ask('ana', 'SELECT institution.mark_notice_read({z1})::text'), NULL, 'Ana marks it');
SELECT is(pg_temp.read('ana', 's.notice_read::text') || ' ' || pg_temp.read('dora', 's.notice_read::text'), 'true false',
          'and reads it as read; Dora''s stays unread');

-- 3. No other student is named, and the end of a place or membership counts.
SELECT unalike(pg_temp.read('ana', 's::text'), '%Dora%', 'nothing Ana reads names Dora');
-- Codex finding on #359: a revoked teacher role ends the group teacher too.
SELECT is(pg_temp.ask('iva', 'SELECT institution.revoke_teacher_role({marko})::text'), 'true', 'Iva revokes Marko''s teacher role');
SELECT is(pg_temp.read('ana', 's.mentors::text') || ' ' || pg_temp.read('ana', 's.teachers::text'),
          '[] ' || jsonb_build_array(pg_temp.person('vesna', 'Vesna Izmišljena', 'holder'))::text,
          'Marko is no longer Ana''s group teacher, nor a teacher of K1');
UPDATE institution.seminar_group_member SET valid_to = now() WHERE user_id = pg_temp.id('ana');
SELECT is(pg_temp.read('ana', 's.groups::text || s.mentors::text'), '{}[]', 'an ended group place is no longer shown');
SELECT is(pg_temp.ask('vesna', 'SELECT institution.remove_student({k1}, {dora})::text'), 'true', 'Vesna removes Dora from K1');
SELECT is(pg_temp.read('dora', 's.title'), '-', 'and Dora reads nothing of K1 any more');

SELECT * FROM finish();
ROLLBACK;
