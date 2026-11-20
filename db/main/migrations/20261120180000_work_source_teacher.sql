-- migrate:up
-- SRV-7B step (b) (Ductus#2028, c.7037154952: "preporučene i obvezne izvore
-- dodaje nastavnik"): a teacher of a student's work adds a recommended or
-- required source to that work's source list (20261120170000), changes it or
-- removes it. "A teacher of the work" is a reader of it as in
-- institution.work_source_access: the teacher or collaborator of the course,
-- the teacher of the student's seminar group, the mentor.
--
--   institution.save_teacher_work_source    add or change a teacher's source
--   institution.delete_teacher_work_source  remove a teacher's source
--
-- A teacher's source has a requirement and was added by the teacher (the
-- table's CHECK); a source without requirement is the student's, so a teacher
-- neither changes nor removes it (ZD403), as the student cannot change a
-- teacher's (save_work_source). Any teacher of the work may change or remove
-- a teacher's source; added_by keeps who added it. The same bound of 500
-- sources per work and the same lock as save_work_source. Errors as there:
-- ZD401 no session, ZD403 no relation, ZD422 invalid input or a full list.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.save_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_record jsonb,
                                                     p_requirement text, p_doi text DEFAULT NULL,
                                                     p_isbn text DEFAULT NULL, p_undated boolean DEFAULT false)
RETURNS TABLE (id uuid, record jsonb, doi text, isbn text, undated boolean, requirement text,
               created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
  v_id uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_record IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object'
     OR NOT coalesce(p_record->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
     OR NOT institution.work_source_record_valid((p_record->>'id')::uuid, p_record)
     OR NOT coalesce(p_requirement IN ('recommended', 'required'), false)
     OR NOT coalesce(char_length(p_doi) <= 300 AND p_doi ~ '^10\.[0-9]{4,9}/[!-~]+$' AND p_doi = lower(p_doi), p_doi IS NULL)
     OR NOT coalesce(p_isbn ~ '^([0-9]{9}[0-9X]|97[89][0-9]{10})$', p_isbn IS NULL)
     OR p_undated IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_id := (p_record->>'id')::uuid;
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('work_source:' || p_assignment_id || ':' || p_student_id, 0));
  IF NOT EXISTS (SELECT 1 FROM institution.work_source w
                  WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = v_id)
     AND (SELECT count(*) FROM institution.work_source w
           WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id) >= 500 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.work_source AS w
      (institution_id, assignment_id, student_id, id, record, doi, isbn, undated, requirement, added_by)
    VALUES (v_institution, p_assignment_id, p_student_id, v_id, p_record, p_doi, p_isbn, p_undated, p_requirement, v_user)
    ON CONFLICT (assignment_id, student_id, id) DO UPDATE
      SET record = excluded.record, doi = excluded.doi, isbn = excluded.isbn, undated = excluded.undated,
          requirement = excluded.requirement, updated_at = statement_timestamp()
      WHERE w.requirement IS NOT NULL
    RETURNING w.id, w.record, w.doi, w.isbn, w.undated, w.requirement, w.created_at, w.updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

-- True when the teacher's source was there, false when it was not. The
-- student's own source stays: ZD403.
CREATE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION institution.save_teacher_work_source(uuid, uuid, jsonb, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.delete_teacher_work_source(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.save_teacher_work_source(uuid, uuid, jsonb, text, text, text, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.delete_teacher_work_source(uuid, uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.delete_teacher_work_source(uuid, uuid, uuid);
DROP FUNCTION institution.save_teacher_work_source(uuid, uuid, jsonb, text, text, text, boolean);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
