-- migrate:up
-- SRV-V21-KOD-TESTOVI-DB (Ductus#2058, val 21, WEB docs/nalazi/val21-razlika.md 10): the code
-- tests of an assignment, written by a teacher of its course and read by its teachers and by the
-- students enrolled in the course. The student's browser runs them (WEB-V21-KOD-POKRETANJE); the
-- server never runs a student's code and stores no result.
--
-- A revision holds a language (the closed list is only 'javascript'; other languages are open in
-- val21-razlika.md 7) and a JSON array of 0 to 10 tests, at most 16 KiB as the jsonb text that is
-- stored (not the bytes of a request). An empty list is a revision too: it is how a teacher
-- removes every test. The shape of one test ({id, title, input, expected}) belongs to the route
-- (SRV-V21-KOD-TESTOVI-RUTA); here a test only has to be a JSON object.
--
-- Revisions are added only: a stored revision never changes and never goes (ZD409 for every
-- role). A write numbers the next revision under the lock of the assignment row, so two writes at
-- the same time get two revisions without a gap; the last one is read.
--
-- Who may (C-23, from the relation, never from the role alone; only an assignment of a course,
-- a mentored assignment has no code tests and is the same ZD404):
--   read and write  a teacher of the assignment's course: its open teacher member with a
--                   confirmed, unrevoked teacher role
--   read            a student of the assignment's course: its open student member
--   write as one    such a student is ZD403 (they see the assignment; the route answers 403)
-- Anyone else, another institution and an unknown assignment are the same ZD404.
--
-- Errors carry no input: ZD401 no session, ZD403 a student writes, ZD404 not there or no part in
-- the assignment, ZD409 a stored revision changed, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.assignment_code_tests (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no >= 1),
  language text NOT NULL CHECK (language IN ('javascript')),
  tests jsonb NOT NULL CHECK (
    jsonb_typeof(tests) = 'array' AND jsonb_array_length(tests) <= 10 AND octet_length(tests::text) <= 16384
  ),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (assignment_id, revision_no),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE institution.assignment_code_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.assignment_code_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_code_tests_owner ON institution.assignment_code_tests
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.assignment_code_tests FROM PUBLIC, ductus_app;

-- Append only, for every role.
CREATE FUNCTION institution.reject_assignment_code_tests_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'assignment code tests revision is immutable' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER assignment_code_tests_immutable BEFORE UPDATE OR DELETE ON institution.assignment_code_tests
  FOR EACH ROW EXECUTE FUNCTION institution.reject_assignment_code_tests_change();
CREATE TRIGGER assignment_code_tests_no_truncate BEFORE TRUNCATE ON institution.assignment_code_tests
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_assignment_code_tests_change();

-- The list of tests: an array of 0 to 10 JSON objects, at most 16 KiB as stored.
CREATE FUNCTION institution.is_code_tests(p_tests jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_tests IS NOT NULL
    AND pg_catalog.jsonb_typeof(p_tests) = 'array'
    AND pg_catalog.jsonb_array_length(p_tests) <= 10
    AND pg_catalog.octet_length(p_tests::text) <= 16384
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_tests) e
                     WHERE pg_catalog.jsonb_typeof(e) <> 'object')
$$;

-- What the caller is to an assignment of a course now: 'teacher', 'student' or null (not there,
-- another institution, a mentored assignment, no part in it). The relation rules are those of the
-- rubric (assignment_rubric_role), narrowed to an assignment of a course.
CREATE FUNCTION institution.assignment_code_tests_role(p_assignment_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM institution.assignment a, app.current_actor() c
                            WHERE a.id = p_assignment_id AND a.institution_id = c.institution_id
                              AND a.course_id IS NOT NULL)
              THEN institution.assignment_rubric_role(p_assignment_id) END
$$;

-- The latest revision of the code tests of an assignment, for a teacher or a student of its
-- course. No row: none yet.
CREATE FUNCTION app.get_assignment_code_tests(p_assignment_id uuid)
RETURNS TABLE (revision_no integer, language text, tests jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (SELECT a.user_id FROM app.current_actor() a) IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF institution.assignment_code_tests_role(p_assignment_id) IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN QUERY
    SELECT t.revision_no, t.language, t.tests FROM institution.assignment_code_tests t
     WHERE t.assignment_id = p_assignment_id ORDER BY t.revision_no DESC LIMIT 1;
END
$$;

-- A teacher of the assignment's course adds the next revision. The assignment row is locked first
-- (then the role and the membership, as lock_assignment_teacher), so revisions are numbered
-- without gaps and a revocation in progress is waited for. The writer is current_actor(), never a
-- parameter.
CREATE FUNCTION app.set_assignment_code_tests(p_assignment_id uuid, p_language text, p_tests jsonb)
RETURNS TABLE (revision_no integer, language text, tests jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_course uuid;
  v_latest integer;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  SELECT a.course_id INTO v_course FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id FOR UPDATE;
  IF v_course IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF NOT institution.lock_assignment_teacher(p_assignment_id) THEN
    IF institution.assignment_code_tests_role(p_assignment_id) = 'student' THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
    END IF;
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_language IS DISTINCT FROM 'javascript' OR NOT institution.is_code_tests(p_tests) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT coalesce(max(t.revision_no), 0) INTO v_latest
    FROM institution.assignment_code_tests t WHERE t.assignment_id = p_assignment_id;
  INSERT INTO institution.assignment_code_tests
    (institution_id, assignment_id, revision_no, language, tests, created_by)
  VALUES (v_actor.institution_id, p_assignment_id, v_latest + 1, p_language, p_tests, v_actor.user_id);
  RETURN QUERY SELECT v_latest + 1, p_language, p_tests;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_assignment_code_tests_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_code_tests(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.assignment_code_tests_role(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_assignment_code_tests(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_assignment_code_tests(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_assignment_code_tests(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_assignment_code_tests(uuid, text, jsonb) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.set_assignment_code_tests(uuid, text, jsonb);
DROP FUNCTION app.get_assignment_code_tests(uuid);
DROP FUNCTION institution.assignment_code_tests_role(uuid);
DROP FUNCTION institution.is_code_tests(jsonb);
DROP TABLE institution.assignment_code_tests;
DROP FUNCTION institution.reject_assignment_code_tests_change();
SET LOCAL ROLE ductus_migrator;
