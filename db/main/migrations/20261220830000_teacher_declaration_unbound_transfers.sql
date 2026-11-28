-- migrate:up
-- SRV-IZJAVA-AI-UNBOUND (declaration-v1, D-41): the teacher's declaration read
-- lists the student's AI transfer records of the declared document that no
-- evidence revision binds. Additive only: the payload, its hash and the
-- student's read stay as they are; the list travels beside the payload.
--
--   declaration.bound_ai_transfer_ids   the transfer records of a student that a
--       segment with a receipt names, any revision (the bound side of
--       declaration.recorded_transfers, without its revision bound). Evidence
--       owner's helper; only ductus_identity may execute it.
--   app.teacher_declaration_unbound   for the course teacher or the mentor
--       (the relation check of app.teacher_declaration_answer), the transfer
--       records of the bound declaration's document that the helper does not
--       name, ordered by id and capped at assistant.ai_transfer_max(); null
--       without a bound declaration. It is read in the same transaction as
--       app.teacher_declaration, which writes the access-log row, so it writes
--       none of its own.

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;

-- 1. The bound transfer records (evidence owner).
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION declaration.bound_ai_transfer_ids(p_institution_id uuid, p_student_id uuid)
RETURNS TABLE(ai_transfer_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.ai_transfer_id
    FROM evidence.segment_ai_transfer t
    JOIN evidence.segment s ON (s.id, s.evidence_package_id, s.institution_id, s.principal_id)
      = (t.segment_id, t.evidence_package_id, t.institution_id, t.principal_id)
   WHERE t.institution_id = p_institution_id AND t.principal_id = p_student_id
     AND EXISTS (SELECT 1 FROM evidence.receipt r
                  WHERE (r.segment_id, r.evidence_package_id, r.institution_id)
                      = (s.id, s.evidence_package_id, s.institution_id))
$$;
REVOKE ALL ON FUNCTION declaration.bound_ai_transfer_ids(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.bound_ai_transfer_ids(uuid, uuid) TO ductus_identity;

-- 2. The teacher's reader (identity owner).
RESET ROLE;
SET LOCAL ROLE ductus_identity;
CREATE FUNCTION app.teacher_declaration_unbound(p_assignment_id uuid, p_student_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_institution uuid; v_document text;
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
  SELECT b.document_id INTO v_document
    FROM declaration.bound_declaration_of(v_institution, p_assignment_id, p_student_id) b;
  IF v_document IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object('aiTransferId', u.transfer_id::text,
        'aiTransferSha256', u.record_sha256) ORDER BY u.transfer_id), '[]'::jsonb)
      FROM (SELECT a.transfer_id, a.record_sha256
              FROM assistant.ai_transfer a
             WHERE a.institution_id = v_institution AND a.student_id = p_student_id
               AND a.document_id = v_document
               AND a.transfer_id NOT IN (
                 SELECT b.ai_transfer_id FROM declaration.bound_ai_transfer_ids(v_institution, p_student_id) b)
             ORDER BY a.transfer_id
             LIMIT assistant.ai_transfer_max()) u);
END $$;
REVOKE ALL ON FUNCTION app.teacher_declaration_unbound(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_declaration_unbound(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
RESET ROLE;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_declaration_unbound(uuid, uuid);
RESET ROLE;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION declaration.bound_ai_transfer_ids(uuid, uuid);
RESET ROLE;
