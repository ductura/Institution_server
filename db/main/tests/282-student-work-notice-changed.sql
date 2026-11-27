-- F4 val 2 #4 (1.6): noticeChangedSinceSeen of student-work.works.get. No new
-- table: institution.notice_acknowledgment already keeps the version_no of
-- every notice a student confirmed. The notice changed when the newest
-- version the caller confirmed is older than the assignment's current one;
-- never confirmed is false. This is the expression of WORKS_SQL
-- (server/database/student-work/works.ts) over app.student_workspace(), run
-- as ductus_app with the student's own session: a student reads only their
-- own confirmations (FORCE RLS), never another student's.
-- Every person, course and assignment below is invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(12);

-- Z4 of K1: one version, confirmed by nobody.
INSERT INTO ref VALUES ('z4', '00000000-0000-4000-8000-0000000000a4');
INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
VALUES (pg_temp.id('z4'), pg_temp.id('k1'), pg_temp.id('fak_a'), 1, pg_temp.id('vesna'));
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
)
VALUES (pg_temp.id('z4'), 1, 'Z4', 'Upute za izmišljeni zadatak.', 'essay', now(), now() + interval '30 days',
        'partially_allowed', '{proofreading}', 'basic', false, pg_temp.id('vesna'));

CREATE FUNCTION pg_temp.changed(p_actor text, p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT coalesce((SELECT max(n.version_no) FROM institution.notice_acknowledgment n
                      WHERE n.assignment_id = w.assignment_id AND n.student_id = app.current_user_id())
                    < w.current_version, false)::text
      FROM app.student_workspace() w WHERE w.assignment_id = %s $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.confirmed(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT coalesce(string_agg(p.name || ':' || n.version_no, ' ' ORDER BY p.name, n.version_no), '-')
      FROM institution.notice_acknowledgment n JOIN person p ON p.id = n.student_id
     WHERE n.assignment_id = {z1} $q$)
$$;

-- 1. Before any change: Z1 is at version 2; Ana confirmed 1 and 2, Dora only 1.
SELECT is(pg_temp.changed('ana', '{z1}'), 'false', 'Ana confirmed the current notice of Z1: not changed');
SELECT is(pg_temp.changed('dora', '{z1}'), 'true', 'Dora confirmed only version 1 of Z1: changed since seen');
SELECT is(pg_temp.changed('ana', '{z4}'), 'false', 'a notice Ana never confirmed is not changed since seen');
SELECT is(pg_temp.changed('dora', '{z4}'), 'false', 'nor for Dora');
SELECT is(pg_temp.changed('tomo', '{z1}'), NULL, 'a student of another institution gets no row of Z1');
SELECT is(pg_temp.changed('anon', '{z1}'), 'ZD401: not authenticated', 'without a session the read is refused');

-- 2. Each student reads only their own confirmations, so Ana's version 2
-- never counts for Dora.
SELECT is(pg_temp.confirmed('dora'), 'dora:1', 'Dora reads only her own confirmation of Z1');
SELECT is(pg_temp.confirmed('ana'), 'ana:1 ana:2', 'Ana reads only her own two');

-- 3. Version 3 of Z1 is written as the fixture writes versions (owner role,
-- as publish_assignment_version would): now Ana's notice changed too.
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
)
SELECT assignment_id, 3, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
       evidence_profile, import_allowed, created_by
  FROM institution.assignment_version WHERE assignment_id = pg_temp.id('z1') AND version_no = 2;
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
SELECT is(pg_temp.changed('ana', '{z1}'), 'true', 'after version 3, Ana''s confirmed version 2 is older: changed');
SELECT is(pg_temp.changed('dora', '{z1}'), 'true', 'and Dora''s stays changed');

-- 4. The table the flag reads keeps forced RLS, and the client never writes it.
SELECT is(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = 'institution.notice_acknowledgment'::regclass),
  true, 'notice_acknowledgment has forced row level security'
);
SELECT matches(
  pg_temp.ask('ana', $$ INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
                        VALUES ({z1}, 3, {ana}, {fak_a}) RETURNING 'x' $$),
  '^42501: permission denied for table notice_acknowledgment',
  'Ana cannot confirm a version by writing the table directly'
);

SELECT * FROM finish();
ROLLBACK;
