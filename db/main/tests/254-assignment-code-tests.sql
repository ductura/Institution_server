-- SRV-V21-KOD-TESTOVI-DB (Ductus#2058, val 21): the code tests of an assignment (20261219400000).
-- Personas of institution.inc and mentorship.inc, all invented: Vesna teaches K1 (assignment z1)
-- whose students are Ana and Dora; Marko teaches K2 (z2) and mentors Ana's master thesis (zm1);
-- Petra teaches K3 of fak-b, Tomo studies there; Iva administers fak-a; Boris studies in no course;
-- Nina's teacher role is not confirmed. The access matrix: a teacher of the course writes and
-- reads; a student of the course reads and is ZD403 when writing; everyone else, another
-- institution, a mentored assignment and an unknown one read the same ZD404; no session is ZD401.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid = 'institution.assignment_code_tests'::regclass;
SELECT ok(NOT has_table_privilege(r, 'institution.assignment_code_tests', 'SELECT,INSERT,UPDATE,DELETE'),
  r || ' has only RPC access to the code tests')
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS t(r);
SELECT ok(has_function_privilege('ductus_app', f, 'EXECUTE'), 'ductus_app calls ' || f)
  FROM unnest(ARRAY['app.get_assignment_code_tests(uuid)', 'app.set_assignment_code_tests(uuid,text,jsonb)']) AS f;
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.get_assignment_code_tests(uuid)', 'app.set_assignment_code_tests(uuid,text,jsonb)']) AS f;
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['institution.is_code_tests(jsonb)', 'institution.assignment_code_tests_role(uuid)',
    'institution.reject_assignment_code_tests_change()']) AS f;

CREATE FUNCTION pg_temp.case_(p_id text, p_expected jsonb DEFAULT '3') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', p_id, 'title', 'Izmišljeni test ' || p_id, 'input', jsonb_build_array(1, 2),
    'expected', p_expected)
$$;
-- revision:id,id or "none" or "SQLSTATE: message".
CREATE FUNCTION pg_temp.get(p_actor text, p_assignment text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(revision_no || %L || language || %L || coalesce((SELECT string_agg(c ->> %L, %L) FROM jsonb_array_elements(tests) c), %L), %L), %L) FROM app.get_assignment_code_tests(%L::uuid)',
    ':', ':', 'id', ',', '-', ';', 'none', coalesce(pg_temp.id(p_assignment)::text, p_assignment)))
$$;
CREATE FUNCTION pg_temp.put(p_actor text, p_assignment text, p_tests text, p_language text DEFAULT 'javascript') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT revision_no::text FROM app.set_assignment_code_tests(%L::uuid, %L, %L::jsonb)',
    coalesce(pg_temp.id(p_assignment)::text, p_assignment), p_language, p_tests))
$$;

-- Nothing before the teacher writes.
SELECT is(pg_temp.get('vesna', 'z1'), 'none', 'a teacher reads no code tests at first');
SELECT is(pg_temp.get('ana', 'z1'), 'none', 'a student reads none at first');

-- No session; no part; another institution; unknown; mentored.
SELECT is(pg_temp.get('anon', 'z1'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.put('anon', 'z1', '[]'), 'ZD401: not authenticated', 'writing needs a session');
SELECT is(pg_temp.get(a, 'z1'), 'ZD404: not found', a || ' has no part in z1 and reads the same 404')
  FROM (VALUES ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS t(a);
SELECT is(pg_temp.put(a, 'z1', jsonb_build_array(pg_temp.case_('a'))::text), 'ZD404: not found', a || ' cannot write for z1')
  FROM (VALUES ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS t(a);
SELECT is(pg_temp.get(a, 'z2'), 'ZD404: not found', a || ', a student of another course, reads 404 for z2')
  FROM (VALUES ('ana'), ('dora')) AS t(a);
SELECT is(pg_temp.get('vesna', '00000000-0000-4000-8000-00000000dead'), 'ZD404: not found', 'an unknown assignment is the same 404');
SELECT is(pg_temp.put('vesna', '00000000-0000-4000-8000-00000000dead', '[]'), 'ZD404: not found', 'and writing to it');
SELECT is(pg_temp.get('marko', 'zm1'), 'ZD404: not found', 'a mentored assignment has no code tests: the mentor reads 404');
SELECT is(pg_temp.get('ana', 'zm1'), 'ZD404: not found', 'and so does its student');
SELECT is(pg_temp.put('marko', 'zm1', '[]'), 'ZD404: not found', 'and the mentor cannot write');

-- A student of the course does not write, whatever the input.
SELECT is(pg_temp.put(a, 'z1', jsonb_build_array(pg_temp.case_('a'))::text), 'ZD403: forbidden', a || ', a student of z1, cannot write')
  FROM (VALUES ('ana'), ('dora')) AS t(a);
SELECT is(pg_temp.put('ana', 'z1', '{}'), 'ZD403: forbidden', 'a student is told 403 before the input is judged');
SELECT is(pg_temp.put('tomo', 'z1', '{}'), 'ZD404: not found', 'a stranger is told 404 before the input is judged');

-- Invalid input.
SELECT is(pg_temp.put('vesna', 'z1', l, lang), 'ZD422: invalid input', what)
  FROM (VALUES
    ('{}', 'javascript', 'an object is not a list'),
    ('"x"', 'javascript', 'a string is not a list'),
    ('null', 'javascript', 'a JSON null is not a list'),
    ((SELECT jsonb_agg(pg_temp.case_('t' || n))::text FROM generate_series(1, 11) n), 'javascript', 'more than 10 tests'),
    (jsonb_build_array(pg_temp.case_('a', to_jsonb(repeat('x', 16400))))::text, 'javascript', 'more than 16 KiB'),
    ('[1]', 'javascript', 'a test that is not an object'),
    ('[[]]', 'javascript', 'a test that is a list'),
    ('[]', 'python', 'a language outside the closed list'),
    ('[]', 'JavaScript', 'the language is told exactly'),
    ('[]', '', 'an empty language')
  ) AS t(l, lang, what);
SELECT is(pg_temp.ask('vesna', format('SELECT revision_no::text FROM app.set_assignment_code_tests(%L::uuid, NULL, %L::jsonb)', pg_temp.id('z1'), '[]')), 'ZD422: invalid input', 'the language is not null');
SELECT is(pg_temp.ask('vesna', format('SELECT revision_no::text FROM app.set_assignment_code_tests(%L::uuid, %L, NULL)', pg_temp.id('z1'), 'javascript')), 'ZD422: invalid input', 'the tests are not null');
SELECT is((SELECT count(*)::int FROM institution.assignment_code_tests), 0, 'nothing invalid was stored');

-- Write, read, add.
SELECT is(pg_temp.put('vesna', 'z1', (SELECT jsonb_agg(pg_temp.case_('t' || n))::text FROM generate_series(1, 10) n)), '1', 'ten tests are the limit');
SELECT is(pg_temp.get('vesna', 'z1'), '1:javascript:t1,t2,t3,t4,t5,t6,t7,t8,t9,t10', 'the teacher reads the revision');
SELECT is(pg_temp.get('ana', 'z1'), '1:javascript:t1,t2,t3,t4,t5,t6,t7,t8,t9,t10', 'the student reads the same');
SELECT is(pg_temp.get('dora', 'z1'), '1:javascript:t1,t2,t3,t4,t5,t6,t7,t8,t9,t10', 'and so does the other student of the course');
SELECT is(pg_temp.put('vesna', 'z1', jsonb_build_array(pg_temp.case_('zbroj'), pg_temp.case_('razlika', '-1'))::text), '2', 'the teacher adds the next revision');
SELECT is(pg_temp.get('ana', 'z1'), '2:javascript:zbroj,razlika', 'the latest one is read');
SELECT is((SELECT tests -> 1 -> 'expected' FROM institution.assignment_code_tests WHERE revision_no = 2), '-1'::jsonb, 'a test is stored as written');
SELECT is(pg_temp.put('vesna', 'z1', '[]'), '3', 'an empty list removes every test as a new revision');
SELECT is(pg_temp.get('ana', 'z1'), '3:javascript:-', 'and the student reads no test');
SELECT is((SELECT string_agg(revision_no::text, ',' ORDER BY revision_no) FROM institution.assignment_code_tests WHERE assignment_id = pg_temp.id('z1')), '1,2,3', 'every revision is kept');
SELECT is((SELECT jsonb_array_length(tests) FROM institution.assignment_code_tests WHERE assignment_id = pg_temp.id('z1') AND revision_no = 1), 10, 'adding did not change revision 1');
SELECT is((SELECT created_by FROM institution.assignment_code_tests WHERE assignment_id = pg_temp.id('z1') AND revision_no = 2), pg_temp.id('vesna'), 'the writer is the caller');
SELECT is(pg_temp.get('vesna', 'z2'), 'ZD404: not found', 'the tests of z1 are no part of z2');
SELECT is(pg_temp.get('marko', 'z2'), 'none', 'Marko teaches z2 and it has none');
SELECT is(pg_temp.put('marko', 'z2', jsonb_build_array(pg_temp.case_('a'))::text), '1', 'and has revisions of its own');
SELECT is(pg_temp.get('petra', 'z3'), 'none', 'the teacher of another institution reads her own assignment');
SELECT is(pg_temp.get('tomo', 'z1'), 'ZD404: not found', 'a student of another institution still reads 404');

-- A student who left the course reads 404.
SET LOCAL ROLE ductus_identity;
UPDATE institution.course_member SET member_to = now()
 WHERE user_id = pg_temp.id('dora') AND course_id = pg_temp.id('k1') AND role = 'student';
RESET ROLE;
SELECT is(pg_temp.get('dora', 'z1'), 'ZD404: not found', 'a student whose membership ended reads 404');
SELECT is(pg_temp.put('dora', 'z1', '[]'), 'ZD404: not found', 'and is no longer told 403');

-- A revoked teacher role ends the right to read and write.
SET LOCAL ROLE ductus_identity;
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('vesna') AND role = 'teacher';
RESET ROLE;
SELECT is(pg_temp.get('vesna', 'z1'), 'ZD404: not found', 'a revoked teacher reads 404');
SELECT is(pg_temp.put('vesna', 'z1', '[]'), 'ZD404: not found', 'and cannot write');

-- Append only for every role.
SELECT is(pg_temp.ask_as('ductus_identity', 'vesna', stmt), 'ZD409: assignment code tests revision is immutable', what)
  FROM (VALUES ('UPDATE institution.assignment_code_tests SET tests = ''[]''', 'a revision cannot be updated'),
               ('DELETE FROM institution.assignment_code_tests', 'a revision cannot be deleted'),
               ('TRUNCATE institution.assignment_code_tests', 'a revision cannot be truncated')) AS t(stmt, what);

SELECT * FROM finish();
ROLLBACK;
