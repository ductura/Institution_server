-- F4-NAS-R04-SRV (D-41, declaration-v1 section 8): the course teacher reads a
-- conversation the student attached to the declaration bound to the live
-- submission, up to its throughSeq and no further. Expand only; no table.
--
--   app.teacher_declaration_conversation
--     the messages (seq 1..throughSeq) of one conversation named in
--     ai.attachments of the bound declaration. The conversation must be the
--     student's, of this assignment, and its messages up to throughSeq must
--     still hash to the messagesSha256 the student confirmed. The read is
--     written to the access log with the surface 'declaration'.
--
-- Only the teacher of the course reads it (declaration-v1 section 8: a mentor
-- does not, yet). No live submission, a conversation the declaration does not
-- attach (unattached, another student's, another assignment's, unknown) and
-- every other reader are the same refusal (ZD403); a stored conversation that
-- no longer matches what was confirmed is ZD409. Nothing is written on a
-- refusal. Errors carry no input.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.teacher_declaration_conversation(
  p_assignment_id uuid, p_student_id uuid, p_conversation_id uuid
) RETURNS TABLE(seq integer, role text, content text, content_sha256 text, created_at timestamptz,
                through_seq integer, messages_sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_row record;
  v_through integer;
  v_sha text;
  v_attachment jsonb;
  v_hashes text;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL OR p_conversation_id IS NULL
     OR audit.reader_role(v_institution, p_assignment_id, p_student_id) IS DISTINCT FROM 'teacher'
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution AND s.mentorship_id IS NULL
          AND EXISTS (SELECT 1 FROM institution.course_member m
                       WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                         AND m.user_id = p_student_id AND m.role = 'student')) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT b.document_id, b.payload_jcs INTO v_row
    FROM declaration.bound_declaration_of(v_institution, p_assignment_id, p_student_id) b;
  IF v_row.document_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT a INTO v_attachment
    FROM jsonb_array_elements(coalesce((v_row.payload_jcs::jsonb)#>'{ai,attachments}', '[]'::jsonb)) a
   WHERE a->>'conversationId' = p_conversation_id::text
   LIMIT 1;
  IF v_attachment IS NULL
     OR jsonb_typeof(v_attachment->'throughSeq') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_attachment->'messagesSha256') IS DISTINCT FROM 'string'
     OR NOT EXISTS (
       SELECT 1 FROM assistant.conversation c
        WHERE c.id = p_conversation_id AND c.institution_id = v_institution
          AND c.student_id = p_student_id AND c.assignment_id = p_assignment_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  v_through := (v_attachment->>'throughSeq')::integer;
  v_sha := v_attachment->>'messagesSha256';
  SELECT string_agg('"' || m.content_sha256 || '"', ',' ORDER BY m.seq) INTO v_hashes
    FROM assistant.message m
   WHERE m.conversation_id = p_conversation_id AND m.institution_id = v_institution AND m.seq <= v_through;
  IF v_hashes IS NULL
     OR (SELECT count(*) FROM assistant.message m
          WHERE m.conversation_id = p_conversation_id AND m.institution_id = v_institution
            AND m.seq <= v_through) <> v_through
     OR encode(sha256(convert_to('[' || v_hashes || ']', 'UTF8')), 'hex') <> v_sha THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  PERFORM audit.record_work_opening(v_institution, v_row.document_id, p_assignment_id, p_student_id,
                                    'declaration');
  RETURN QUERY
    SELECT m.seq, m.role, m.content, m.content_sha256, m.created_at, v_through, v_sha
      FROM assistant.message m
     WHERE m.conversation_id = p_conversation_id AND m.institution_id = v_institution AND m.seq <= v_through
     ORDER BY m.seq;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_declaration_conversation(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_declaration_conversation(uuid, uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_declaration_conversation(uuid, uuid, uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
