-- migrate:up
-- SRV-20 (Ductus#2028, c.7009405737): the state of a student's submission on
-- an assignment, read by assignment and student instead of by submission id
-- (app.read_submission_receipt, 20261027090000), so the student's screen and
-- the teacher's read one shape from one function (PRODUCT 5 rule 5).
--
--   app.submission_state_of        the one reader of the shape; no side
--                                  effect, no access check, not executable
--                                  by ductus_app (only by the definer
--                                  functions of ductus_identity that check
--                                  access first)
--   app.my_submission_state        the caller's own state on an assignment of
--                                  a course where they hold an open student
--                                  membership; writes nothing
--   app.my_assignment_requirements the word range of the current version, for
--                                  the same caller
--   app.teacher_submission_state   the same state of one student, for a
--                                  reader of that student's work (teacher or
--                                  collaborator of the course, seminar group
--                                  teacher, mentor)
--
-- States: none (no recorded submission), ceka (recorded, no receipt bound
-- yet: the signer was unavailable, SRV-18 503 signing), potvrdeno (the bound
-- receipt, byte for byte as stored). "Submitted" is a row in
-- evidence.submission, as in app.assignment_submissions: a request alone is
-- not a submission. A caller with no relation gets not_found, the same as
-- for an assignment that does not exist; no session is ZD401.
--
-- The teacher's read returns the state and the receipt, never the text of
-- the work, so it is a read without content and writes nothing to
-- audit.access_log (Ductus docs/backend/suradnja.md, DAN-294: lists without
-- content log nothing; the submitted text is logged as submitted_text where
-- it is read). Answer to P-5 on Ductus#2028, c.7010418731.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- The institution comes from the session, never from a parameter. At most
-- one submission per student and assignment (its unique key) and at most one
-- receipt per submission (its primary key), so at most one row.
CREATE FUNCTION app.submission_state_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (
  state text, revision bigint, requested_at timestamptz,
  receipt_payload text, payload_digest_sha256 text, signature jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN x.id IS NULL THEN 'none' WHEN r.submission_id IS NULL THEN 'ceka' ELSE 'potvrdeno' END,
         x.revision, x.requested_at, r.receipt_payload, r.payload_digest_sha256, r.signature
    FROM app.current_actor() a
    LEFT JOIN evidence.submission x
      ON x.assignment_id = p_assignment_id AND x.institution_id = a.institution_id
     AND x.principal_id = p_student_id
    LEFT JOIN evidence.submission_receipt r
      ON r.submission_id = x.id AND r.institution_id = x.institution_id AND r.principal_id = x.principal_id
   WHERE a.institution_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.submission_state_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submission_state_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The caller's own state. The relation is collaboration.actor_role's student
-- branch: an open student membership in the course of the assignment and the
-- caller as owner. A removed student, a teacher of the course and anyone else
-- get not_found.
CREATE FUNCTION app.my_submission_state(p_assignment_id uuid)
RETURNS TABLE (
  state text, revision bigint, requested_at timestamptz,
  receipt_payload text, payload_digest_sha256 text, signature jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::timestamptz, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.submission_state_of(p_assignment_id, v_user);
END
$$;
REVOKE ALL ON FUNCTION app.my_submission_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_submission_state(uuid) TO ductus_app;

-- The word range of the assignment's current version (20261022090000), for a
-- student of its course; NULL bounds are "no bound". Anyone else: not_found.
CREATE FUNCTION app.my_assignment_requirements(p_assignment_id uuid)
RETURNS TABLE (outcome text, word_min integer, word_max integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT 'found'::text, v.word_min, v.word_max
    FROM institution.assignment a
    JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution;
END
$$;
REVOKE ALL ON FUNCTION app.my_assignment_requirements(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_assignment_requirements(uuid) TO ductus_app;

-- One student's state for a reader of that student's work. The reader and
-- the role are those of audit.reader_role, the rule the access log is written
-- by: the teacher of the course (holder or collaborator, within the boundary
-- of actor_course_work), the mentor of a mentorship's assignment, or the
-- teacher of the student's seminar group. The student must be one of the
-- assignment: a student of its course, now or before (the work of a removed
-- student stays readable, as through actor_role), or the student of its
-- mentorship. The owner, a reader of another course or institution, an
-- unknown or null assignment, a user who is not a student of the assignment
-- or of another institution: ZD403, one answer for every refusal. No
-- session: ZD401. Both checks and the read are one STABLE read; writes
-- nothing.
CREATE FUNCTION app.teacher_submission_state(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (
  state text, revision bigint, requested_at timestamptz,
  receipt_payload text, payload_digest_sha256 text, signature jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL
     OR audit.reader_role(v_institution, p_assignment_id, p_student_id) IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = p_student_id AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship t
                           WHERE t.id = s.mentorship_id AND t.institution_id = s.institution_id
                             AND t.student_id = p_student_id))) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.submission_state_of(p_assignment_id, p_student_id);
END
$$;
REVOKE ALL ON FUNCTION app.teacher_submission_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_submission_state(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_submission_state(uuid, uuid);
DROP FUNCTION app.my_assignment_requirements(uuid);
DROP FUNCTION app.my_submission_state(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.submission_state_of(uuid, uuid);
RESET ROLE;
