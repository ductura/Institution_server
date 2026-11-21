-- SRV-1213 (B1): the teacher of a course reads the declaration a student bound
-- to the live submission of an assignment (spec §7.1, §8; OD-10). Expand only.
--
--   declaration.bound_declaration_of
--                             the statement pinned by the live (not withdrawn)
--                             submission of a student; the evidence owner's
--                             helper, executable by the identity role only,
--                             which passes the institution of the session (as
--                             declaration.lock_scope does).
--   app.teacher_declaration   the teacher of the course reads it; the read is
--                             written to the access log with the surface
--                             'declaration'. No live submission: state 'none'
--                             and nothing is written.
--
-- Only the teacher of the course reads it: a mentor, a seminar teacher, a
-- teacher of another course, an administrator and the student's colleagues
-- are refused (ZD403), and nothing is written. Errors carry no input.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
-- The identity owner of the reader calls the helper; no table of the schema is
-- granted to it.
GRANT USAGE ON SCHEMA declaration TO ductus_identity;

-- 1. The access log knows the new surface; every existing row still holds.
SET LOCAL ROLE ductus_identity;
-- squawk-ignore ban-drop-constraint
ALTER TABLE audit.access_log DROP CONSTRAINT access_log_surface_check;
ALTER TABLE audit.access_log ADD CONSTRAINT access_log_surface_check
  CHECK (surface IN ('live_view', 'process_summary', 'fast_path', 'replay', 'submitted_text', 'declaration'))
  NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE audit.access_log VALIDATE CONSTRAINT access_log_surface_check;

-- 2. The bound statement of the live submission (evidence owner).
RESET ROLE;
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION declaration.bound_declaration_of(p_institution_id uuid, p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(document_id text, payload_jcs text, declaration_sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.document_id, s.payload_jcs, r.declaration_sha256
    FROM evidence.submission x
    JOIN evidence.submission_request r
      ON r.id = x.submission_request_id AND r.institution_id = x.institution_id
    JOIN declaration.statement s
      ON s.id = r.declaration_version_id AND s.institution_id = r.institution_id
   WHERE x.institution_id = p_institution_id AND x.assignment_id = p_assignment_id
     AND x.principal_id = p_student_id AND NOT evidence.submission_withdrawn(x.id)
     AND s.content_sha256 = r.declaration_sha256
$$;
REVOKE ALL ON FUNCTION declaration.bound_declaration_of(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.bound_declaration_of(uuid, uuid, uuid) TO ductus_identity;

-- 3. The teacher's reader (identity owner).
RESET ROLE;
SET LOCAL ROLE ductus_identity;
CREATE FUNCTION app.teacher_declaration(p_assignment_id uuid, p_student_id uuid)
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
REVOKE ALL ON FUNCTION app.teacher_declaration(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_declaration(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
-- Forward only. Rows written with the surface 'declaration' stay; a rollback
-- is a new forward migration.
