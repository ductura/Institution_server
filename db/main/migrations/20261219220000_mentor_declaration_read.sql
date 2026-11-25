-- SRV-IZJAVA-MENTOR (owner decision of 25. 11. 2026, Ductus #2055
-- issuecomment-7149114297): the mentor of a student's work reads the
-- declaration bound to its live submission, as the course teacher reads it for
-- a course's assignment (declaration-v1 section 8). The access comes only from
-- the relation (C-23): audit.reader_role is 'mentor' only for the mentor of the
-- assignment's mentorship, and the student must be that mentorship's student.
-- The same relation check as app.teacher_declaration_answer (20261214150000).
-- The read is written to the access log as before (surface 'declaration'); the
-- log names the reader's role, here 'mentor'. Nobody else gains a read: the
-- course teacher of a mentored work, a seminar teacher, a teacher of another
-- course, an administrator and colleagues are still refused (ZD403).
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION app.teacher_declaration(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(state text, payload_jcs text, declaration_sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_row record;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL
     OR coalesce(audit.reader_role(v_institution, p_assignment_id, p_student_id), '') NOT IN ('teacher', 'mentor')
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = p_student_id AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship ms
                           WHERE ms.id = s.mentorship_id AND ms.institution_id = s.institution_id
                             AND ms.student_id = p_student_id))) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT b.document_id, b.payload_jcs, b.declaration_sha256 INTO v_row
    FROM declaration.bound_declaration_of(v_institution, p_assignment_id, p_student_id) b;
  IF v_row.document_id IS NULL THEN
    RETURN QUERY SELECT 'none'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  PERFORM audit.record_work_opening(v_institution, v_row.document_id, p_assignment_id, p_student_id,
                                    'declaration');
  RETURN QUERY SELECT 'bound'::text, v_row.payload_jcs, v_row.declaration_sha256;
END
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION app.teacher_declaration(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(state text, payload_jcs text, declaration_sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_row record;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL
     OR audit.reader_role(v_institution, p_assignment_id, p_student_id) IS DISTINCT FROM 'teacher'
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution AND s.mentorship_id IS NULL
          AND EXISTS (SELECT 1 FROM institution.course_member m
                       WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                         AND m.user_id = p_student_id AND m.role = 'student')) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT b.document_id, b.payload_jcs, b.declaration_sha256 INTO v_row
    FROM declaration.bound_declaration_of(v_institution, p_assignment_id, p_student_id) b;
  IF v_row.document_id IS NULL THEN
    RETURN QUERY SELECT 'none'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  PERFORM audit.record_work_opening(v_institution, v_row.document_id, p_assignment_id, p_student_id,
                                    'declaration');
  RETURN QUERY SELECT 'bound'::text, v_row.payload_jcs, v_row.declaration_sha256;
END
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
