-- INT-31 (Ductus#2055): institution.student_mentored_assignments and
-- app.student_mentored_workspace. A mentorship's assignment has no course, so
-- the course lists never name it; these two give it to the student of the
-- open mentorship, under the predicate of app.lock_student_assignment: the
-- mentorship is open and the mentor holds a confirmed, not revoked teacher
-- role. Personas of institution.inc and mentorship.inc: Ana writes zm1 under
-- Marko (ms1, open), Dora's zm2 under Vesna has ended (ms2), Boris's zm3 under
-- Nina, whose teacher role nobody confirmed (ms3). Everything is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT plan(24);

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
VALUES (pg_temp.id('marko'), pg_temp.id('fak_a'), 'Marko', 'Izmišljeni');

CREATE FUNCTION pg_temp.mentored(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT coalesce(string_agg((SELECT name FROM ref WHERE val = s.assignment_id::text), ' | '
                               ORDER BY s.assignment_id), '-')
      FROM institution.student_mentored_assignments() s $q$)
$$;
CREATE FUNCTION pg_temp.workspace(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT coalesce(string_agg(coalesce((SELECT name FROM ref WHERE val = w.assignment_id::text), '?')
                               || ':' || coalesce(w.document_id, 'none'), ' | ' ORDER BY w.assignment_id), '-')
      FROM app.student_mentored_workspace() w $q$)
$$;
CREATE FUNCTION pg_temp.doc(p_student text, p_assignment text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id(p_student) AND p.assignment_id = pg_temp.id(p_assignment)
$$;

-- 1. Who reads which mentored assignment (7 tests and 2).
SELECT is(pg_temp.mentored(v.actor), v.seen, v.actor || ' ' || v.what)
FROM (VALUES
  (1, 'ana', 'zm1', 'reads zm1 of her open mentorship under Marko'),
  (2, 'dora', '-', 'reads nothing: her mentorship has ended'),
  (3, 'boris', '-', 'reads nothing: the teacher role of his mentor is not confirmed'),
  (4, 'marko', '-', 'the mentor is no student of the work: reads nothing'),
  (5, 'vesna', '-', 'a teacher of the institution reads nothing'),
  (6, 'iva', '-', 'the administrator reads nothing'),
  (7, 'tomo', '-', 'a student of fak-b reads nothing')
) AS v (n, actor, seen, what)
ORDER BY v.n;
SELECT is(pg_temp.mentored('anon'), 'ZD401: not authenticated', 'without a session the read is refused');
SELECT is(pg_temp.mentored('expired'), 'ZD401: not authenticated', 'with an expired session as well');

-- 2. The fields: the current version, the acknowledgment and the mentor.
SELECT is(
  pg_temp.ask('ana', $q$
    SELECT string_agg(concat_ws(' ',
             s.mentorship_id = '00000000-0000-4000-8000-0000000000d1', s.title, s.work_type, s.acknowledged,
             s.extended_due_at IS NULL, s.mentor_id = '00000000-0000-4000-8000-000000000102',
             s.mentor_given_name, s.mentor_family_name,
             s.due_at = (SELECT v.due_at FROM institution.assignment_version v
                          WHERE v.assignment_id = s.assignment_id AND v.version_no = 1)), ' | ')
      FROM institution.student_mentored_assignments() s $q$),
  't ZM1 master_thesis t t t Marko Izmišljeni t',
  'the row of Ana carries the mentorship, the title, type and due time of the version, her acknowledgment and the name of the mentor'
);

-- 3. The course lists stay as they were: no mentored assignment, no NULL course.
SELECT is(
  pg_temp.ask('ana', $q$ SELECT count(*)::text FROM institution.student_assignments() s
                          WHERE s.assignment_id = '00000000-0000-4000-8000-0000000000b1' OR s.course_id IS NULL $q$),
  '0', 'student_assignments() still lists no mentored assignment');
SELECT is(pg_temp.workspace('ana'), 'zm1:none',
          'before the work is opened, the mentored workspace has zm1 without a document');

-- 4. Opening the work through the gate puts its document beside it.
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))),
          'opened', 'Ana opens zm1 through app.open_student_work');
SELECT is(pg_temp.workspace('ana'), 'zm1:' || pg_temp.doc('ana', 'zm1'),
          'the mentored workspace names her document of zm1');
SELECT is(
  pg_temp.ask('ana', $q$ SELECT count(*)::text FROM app.student_workspace() w
                          WHERE w.assignment_id = '00000000-0000-4000-8000-0000000000b1' $q$),
  '0', 'student_workspace() still leaves zm1 out');
SELECT is(pg_temp.workspace(v.actor), '-', 'the mentored workspace of ' || v.actor || ' is empty')
FROM (VALUES (1, 'dora'), (2, 'boris'), (3, 'marko')) AS v (n, actor) ORDER BY v.n;
SELECT is(pg_temp.workspace('anon'), 'ZD401: not authenticated',
          'the mentored workspace without a session is refused');

-- 5. A revoked mentor role closes the list exactly as it closes the gate.
UPDATE institution.institution_role SET revoked_at = now()
 WHERE user_id = pg_temp.id('marko') AND institution_id = pg_temp.id('fak_a') AND role = 'teacher';
SELECT is(pg_temp.mentored('ana'), '-', 'with the teacher role of Marko revoked Ana reads no mentored assignment');
SELECT is(pg_temp.workspace('ana'), '-', 'nor a mentored work');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))),
          'not_found', 'and the gate refuses zm1 the same way');

-- 6. Owners, rights and search_path.
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::text
                     || ' ' || coalesce('search_path=""' = ANY (p.proconfig), false)::text, ', '
                     ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.oid IN ('institution.student_mentored_assignments()'::regprocedure,
                    'app.student_mentored_workspace()'::regprocedure)),
  'app.student_mentored_workspace() ductus_evidence false true, '
  || 'institution.student_mentored_assignments() ductus_identity true true',
  'the list is a definer of the identity role, the workspace an invoker of the evidence role; both with an empty search_path'
);
SELECT ok(
  has_function_privilege('ductus_app', 'institution.student_mentored_assignments()', 'EXECUTE')
  AND has_function_privilege('ductus_app', 'app.student_mentored_workspace()', 'EXECUTE')
  AND NOT has_function_privilege('ductus_test_stranger', 'institution.student_mentored_assignments()', 'EXECUTE')
  AND NOT has_function_privilege('ductus_test_stranger', 'app.student_mentored_workspace()', 'EXECUTE'),
  'only the web role executes them, not PUBLIC'
);

SELECT * FROM finish();
ROLLBACK;
