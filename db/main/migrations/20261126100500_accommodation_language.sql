-- migrate:up
-- SRV-1410, M2 (D-50, F-06): two limits on what already exists.
--
-- 1. The accommodation mark (yes or no, no reason, no health data) is read
--    only by the student of the work and by the holder of the work: a teacher
--    of the course (within the boundary of the earlier-work rule) or the mentor. A teacher of a seminar group (an assistant)
--    no longer reads it; other students and co-mentors never did.
-- 2. The language of a work (hr, en) must be one the institution offers: the
--    list of the assignment's pinned institution config (workLanguages). The
--    CHECK on is_work_language stays the outer closed set. An assignment
--    created before any config version has no list and keeps the closed set.
--    An unchanged inherited language is never re-checked, so a later config
--    cannot block a new version that leaves the language as it was.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION institution.work_accommodation(p_assignment_id uuid, p_student_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_role text;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  v_role := institution.actor_assignment_role(p_assignment_id);
  IF v_user IS NULL OR p_student_id IS NULL
     OR NOT coalesce((v_role = 'student' AND p_student_id = v_user)
                     OR (v_role = 'teacher'
                         AND institution.work_relation(p_student_id, p_assignment_id) = 'student'
                         AND institution.actor_course_work(p_assignment_id, p_student_id)), false) THEN
    RETURN NULL;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM institution.work_accommodation w
     WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id
       AND w.institution_id = v_institution);
END
$$;

-- Is p_language on the list of the assignment's config version. True when the
-- assignment has no version (nothing to read), false for a language not listed.
CREATE FUNCTION institution.work_language_offered(p_assignment_id uuid, p_language text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT c.rules -> 'workLanguages' ? p_language
       FROM institution.assignment a
       JOIN app.institution_config c ON c.institution_id = a.institution_id AND c.version = a.config_version
      WHERE a.id = p_assignment_id),
    true)
$$;
REVOKE ALL ON FUNCTION institution.work_language_offered(uuid, text) FROM PUBLIC;

CREATE FUNCTION institution.work_language_offered_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_previous text;
BEGIN
  IF TG_TABLE_NAME = 'assignment_version' THEN
    SELECT v.work_language INTO v_previous FROM institution.assignment_version v
     WHERE v.assignment_id = NEW.assignment_id AND v.version_no = NEW.version_no - 1;
    IF NEW.work_language IS NOT DISTINCT FROM v_previous THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT institution.work_language_offered(NEW.assignment_id, NEW.work_language) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION institution.work_language_offered_check() FROM PUBLIC;
-- After assignment_version_work_language, which fills an omitted language.
CREATE TRIGGER assignment_version_work_language_offered BEFORE INSERT ON institution.assignment_version
  FOR EACH ROW EXECUTE FUNCTION institution.work_language_offered_check();
CREATE TRIGGER work_language_override_offered BEFORE INSERT OR UPDATE ON institution.work_language_override
  FOR EACH ROW EXECUTE FUNCTION institution.work_language_offered_check();

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP TRIGGER work_language_override_offered ON institution.work_language_override;
DROP TRIGGER assignment_version_work_language_offered ON institution.assignment_version;
DROP FUNCTION institution.work_language_offered_check();
DROP FUNCTION institution.work_language_offered(uuid, text);
CREATE OR REPLACE FUNCTION institution.work_accommodation(p_assignment_id uuid, p_student_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_role text;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  v_role := institution.actor_assignment_role(p_assignment_id);
  IF v_user IS NULL OR p_student_id IS NULL
     OR NOT coalesce((v_role = 'student' AND p_student_id = v_user)
                     OR (v_role = 'teacher'
                         AND institution.work_relation(p_student_id, p_assignment_id) = 'student'
                         AND institution.actor_course_work(p_assignment_id, p_student_id))
                     OR institution.actor_group_work(p_assignment_id, p_student_id), false) THEN
    RETURN NULL;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM institution.work_accommodation w
     WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id
       AND w.institution_id = v_institution);
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
