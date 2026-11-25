-- migrate:up
-- SRV-V17-RUBRIC-DEF (Ductus#2055, val 17, docs/nalazi/val17-razlika.md 2): the rubric of an
-- assignment, defined by its teacher and read by its students before they submit.
--
-- A rubric is a list of 1 to 12 criteria, each {id, title, levels}: id 1 to 32 characters of
-- a-z, 0-9, "_" and "-", unique in the list; title 1 to 120 characters; levels exactly three
-- {label 1..80, descriptor 0..400}, from the lowest to the highest. There is no number,
-- weight, sum or grade anywhere in it (D-130, PRODUCT 5): the levels are words. It is separate
-- from the private six working criteria of a mentor (SRV-1107), which stay as they are.
--
-- Versioned by adding only: a stored version never changes and never goes (ZD409 for every
-- role). The teacher of the assignment replaces the rubric with the next version, naming the
-- latest version they saw (0 when there was none); another version added in between is ZD409.
-- A later version never rewrites an earlier one, so a mark that names a version (the next
-- step, SRV-V17-RUBRIC-LEVEL) keeps its meaning.
--
-- Who may (C-23, from the relation, never from the role alone):
--   read and replace  a teacher of the assignment: the open teacher member of its course, or the
--                     mentor of its open mentorship, with a confirmed, unrevoked teacher role
--   read              a student of the assignment: the open student member of its course, or the
--                     student of its open mentorship. Without a rubric the server answers the
--                     six default criteria (SRV side, not stored); the teacher reads an empty one.
-- Anyone else, another institution and an unknown assignment are the same ZD404.
--
-- Errors carry no input: ZD401 no session, ZD404 not there or no part in the assignment,
-- ZD409 conflict, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.assignment_rubric_version (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) BETWEEN 1 AND 12),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (assignment_id, version),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE institution.assignment_rubric_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.assignment_rubric_version FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_rubric_version_owner ON institution.assignment_rubric_version
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.assignment_rubric_version FROM PUBLIC, ductus_app;

-- Append only, for every role.
CREATE FUNCTION institution.reject_assignment_rubric_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'assignment rubric version is immutable' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER assignment_rubric_version_immutable BEFORE UPDATE OR DELETE ON institution.assignment_rubric_version
  FOR EACH ROW EXECUTE FUNCTION institution.reject_assignment_rubric_change();
CREATE TRIGGER assignment_rubric_version_no_truncate BEFORE TRUNCATE ON institution.assignment_rubric_version
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_assignment_rubric_change();

-- A line of text of a rubric: p_min..p_max characters, NFC, no control character; p_lines lets
-- a line break through (a descriptor). Non-blank when p_min >= 1.
CREATE FUNCTION institution.is_rubric_text(p_value jsonb, p_min integer, p_max integer, p_lines boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_typeof(p_value) = 'string'
    AND pg_catalog.char_length(p_value #>> '{}') BETWEEN p_min AND p_max
    AND (p_min < 1 OR (p_value #>> '{}') ~ '[^[:space:]]')
    AND (p_value #>> '{}') IS NFC NORMALIZED
    AND (p_value #>> '{}') !~ (CASE WHEN p_lines THEN '[\x01-\x09\x0b-\x1f\x7f-\x9f]' ELSE '[[:cntrl:]]' END)
$$;

-- The list of criteria: 1 to 12 objects, each exactly {id, title, levels}, ids unique,
-- levels exactly three {label, descriptor}; nothing else, no number anywhere.
CREATE FUNCTION institution.is_rubric_criteria(p_list jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
  v_level jsonb;
  v_key text;
BEGIN
  IF p_list IS NULL OR pg_catalog.jsonb_typeof(p_list) <> 'array'
     OR pg_catalog.jsonb_array_length(p_list) NOT BETWEEN 1 AND 12
     OR pg_catalog.octet_length(p_list::text) > 32768 THEN
    RETURN false;
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT e ->> 'id') FROM pg_catalog.jsonb_array_elements(p_list) e)
     <> pg_catalog.jsonb_array_length(p_list) THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_list) e LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      RETURN false;
    END IF;
    FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_item) k LOOP
      IF v_key NOT IN ('id', 'title', 'levels') THEN
        RETURN false;
      END IF;
    END LOOP;
    IF NOT (v_item ? 'id' AND v_item ? 'title' AND v_item ? 'levels')
       OR pg_catalog.jsonb_typeof(v_item -> 'id') <> 'string'
       OR (v_item ->> 'id') !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
       OR NOT institution.is_rubric_text(v_item -> 'title', 1, 120, false)
       OR pg_catalog.jsonb_typeof(v_item -> 'levels') <> 'array'
       OR pg_catalog.jsonb_array_length(v_item -> 'levels') <> 3 THEN
      RETURN false;
    END IF;
    FOR v_level IN SELECT l FROM pg_catalog.jsonb_array_elements(v_item -> 'levels') l LOOP
      IF pg_catalog.jsonb_typeof(v_level) <> 'object' THEN
        RETURN false;
      END IF;
      FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_level) k LOOP
        IF v_key NOT IN ('label', 'descriptor') THEN
          RETURN false;
        END IF;
      END LOOP;
      IF NOT (v_level ? 'label' AND v_level ? 'descriptor')
         OR NOT institution.is_rubric_text(v_level -> 'label', 1, 80, false)
         OR NOT institution.is_rubric_text(v_level -> 'descriptor', 0, 400, true) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END
$$;

-- What the caller is to an assignment now, without a lock: 'teacher', 'student' or null (not
-- there, another institution, no part in it). The same rows lock_assignment_teacher and
-- lock_assignment_student look at.
CREATE FUNCTION institution.assignment_rubric_role(p_assignment_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_assignment institution.assignment%ROWTYPE;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT a.* INTO v_assignment FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_assignment.course_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM institution.course_member m
                WHERE m.course_id = v_assignment.course_id AND m.institution_id = v_actor.institution_id
                  AND m.user_id = v_actor.user_id AND m.role = 'teacher' AND m.member_to IS NULL)
       AND EXISTS (SELECT 1 FROM institution.institution_role r
                    WHERE r.institution_id = v_actor.institution_id AND r.user_id = v_actor.user_id
                      AND r.role = 'teacher' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL) THEN
      RETURN 'teacher';
    END IF;
    IF EXISTS (SELECT 1 FROM institution.course_member m
                WHERE m.course_id = v_assignment.course_id AND m.institution_id = v_actor.institution_id
                  AND m.user_id = v_actor.user_id AND m.role = 'student' AND m.member_to IS NULL) THEN
      RETURN 'student';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM institution.mentorship s
                WHERE s.id = v_assignment.mentorship_id AND s.institution_id = v_actor.institution_id
                  AND s.mentor_id = v_actor.user_id AND s.ended_at IS NULL)
       AND EXISTS (SELECT 1 FROM institution.institution_role r
                    WHERE r.institution_id = v_actor.institution_id AND r.user_id = v_actor.user_id
                      AND r.role = 'teacher' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL) THEN
      RETURN 'teacher';
    END IF;
    IF EXISTS (SELECT 1 FROM institution.mentorship s
                WHERE s.id = v_assignment.mentorship_id AND s.institution_id = v_actor.institution_id
                  AND s.student_id = v_actor.user_id AND s.ended_at IS NULL) THEN
      RETURN 'student';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- The latest version of the rubric of an assignment, for a teacher of it. No row: none yet.
CREATE FUNCTION app.read_assignment_rubric_teacher(p_assignment_id uuid)
RETURNS TABLE (version integer, criteria jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (SELECT a.user_id FROM app.current_actor() a) IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF institution.assignment_rubric_role(p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN QUERY
    SELECT v.version, v.criteria FROM institution.assignment_rubric_version v
     WHERE v.assignment_id = p_assignment_id ORDER BY v.version DESC LIMIT 1;
END
$$;

-- The latest version of the rubric of an assignment, for a student of it. No row: none yet.
CREATE FUNCTION app.read_assignment_rubric_student(p_assignment_id uuid)
RETURNS TABLE (version integer, criteria jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (SELECT a.user_id FROM app.current_actor() a) IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF institution.assignment_rubric_role(p_assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN QUERY
    SELECT v.version, v.criteria FROM institution.assignment_rubric_version v
     WHERE v.assignment_id = p_assignment_id ORDER BY v.version DESC LIMIT 1;
END
$$;

-- A teacher of the assignment adds the next version. The assignment row is locked first (then
-- the role and the membership, as lock_assignment_teacher), so versions are numbered without
-- gaps and a revocation in progress is waited for.
CREATE FUNCTION app.publish_assignment_rubric(
  p_assignment_id uuid, p_expected_version integer, p_criteria jsonb
) RETURNS TABLE (version integer, criteria jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_latest integer;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  PERFORM 1 FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id FOR UPDATE;
  IF NOT FOUND OR NOT institution.lock_assignment_teacher(p_assignment_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0
     OR NOT institution.is_rubric_criteria(p_criteria) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT coalesce(max(v.version), 0) INTO v_latest
    FROM institution.assignment_rubric_version v WHERE v.assignment_id = p_assignment_id;
  IF v_latest <> p_expected_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.assignment_rubric_version
    (institution_id, assignment_id, version, criteria, created_by)
  VALUES (v_actor.institution_id, p_assignment_id, v_latest + 1, p_criteria, v_actor.user_id);
  RETURN QUERY SELECT v_latest + 1, p_criteria;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_assignment_rubric_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_rubric_text(jsonb, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_rubric_criteria(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.assignment_rubric_role(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_assignment_rubric_teacher(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_assignment_rubric_student(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_assignment_rubric(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_assignment_rubric_teacher(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_assignment_rubric_student(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.publish_assignment_rubric(uuid, integer, jsonb) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.publish_assignment_rubric(uuid, integer, jsonb);
DROP FUNCTION app.read_assignment_rubric_student(uuid);
DROP FUNCTION app.read_assignment_rubric_teacher(uuid);
DROP FUNCTION institution.assignment_rubric_role(uuid);
DROP FUNCTION institution.is_rubric_criteria(jsonb);
DROP FUNCTION institution.is_rubric_text(jsonb, integer, integer, boolean);
DROP TABLE institution.assignment_rubric_version;
DROP FUNCTION institution.reject_assignment_rubric_change();
SET LOCAL ROLE ductus_migrator;
