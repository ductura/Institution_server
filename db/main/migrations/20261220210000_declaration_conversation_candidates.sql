-- migrate:up
-- SRV-F4-EDI-R07 (lab editor EDI-R07): the student can attach her own
-- assistant conversations to the declaration (declaration-v1 ai.attachments).
-- Replaces the empty stub of declaration.conversation_snapshot (SRV-1212) and
-- adds the candidate list. Aditive: no table changes.
--
--   app.declaration_conversation_hashes   the student's conversations of one
--       assignment (the institution follows from the assignment) with the content hashes of their messages, seq 1..N in
--       order (stops at the first gap). Reads assistant.* as ductus_identity,
--       whose owner policies see every row; only ductus_evidence may call it.
--   declaration.conversation_snapshot     one row per conversation with at
--       least one message, reason student_added, required_through_seq 0.
--       The evidence chain keeps no link between an assistant message and a
--       transfer or paste (only origin_change character counts), so the
--       mandatory reasons (transferred, transferred_deleted, pasted_known)
--       cannot be derived yet and are never returned; the closed reason set
--       and the mandatory_attachment_missing check stay as they are.
--   declaration.list_conversations        RPC of the web role: the candidates
--       with the throughSeq and messagesSha256 the client sends back in
--       ai.attachments. Own work only; another student's assignment or a
--       missing one is not_found.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.declaration_conversation_hashes(p_assignment uuid, p_student uuid)
RETURNS TABLE (conversation_id uuid, message_hashes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id, array_agg(m.content_sha256 ORDER BY m.seq)
    FROM assistant.conversation c
    JOIN (SELECT x.conversation_id, x.institution_id, x.seq, x.content_sha256,
                 row_number() OVER (PARTITION BY x.conversation_id ORDER BY x.seq) AS rn
            FROM assistant.message x) m
      ON m.conversation_id = c.id AND m.institution_id = c.institution_id AND m.seq = m.rn
   WHERE c.assignment_id = p_assignment AND c.student_id = p_student
   GROUP BY c.id
$$;
REVOKE ALL ON FUNCTION app.declaration_conversation_hashes(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.declaration_conversation_hashes(uuid, uuid) TO ductus_evidence;

RESET ROLE;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT h.conversation_id, 'student_added'::text, 0, h.message_hashes
    FROM app.declaration_conversation_hashes(p_assignment, p_student) h
$$;

CREATE FUNCTION declaration.list_conversations(p_assignment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor record; v_document evidence.document%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL THEN RETURN '{"status":"unauthorized"}'; END IF;
  PERFORM 1 FROM app.lock_student_assignment(p_assignment);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  SELECT * INTO v_document FROM declaration.student_document(v_actor.institution_id, p_assignment, v_actor.user_id);
  RETURN jsonb_build_object('status','ok','conversations', coalesce((
    SELECT jsonb_agg(jsonb_build_object('conversationId', c.conversation_id, 'reason', c.reason,
        'throughSeq', cardinality(c.message_hashes),
        'messagesSha256', encode(sha256(convert_to(array_to_json(c.message_hashes)::text, 'UTF8')), 'hex'))
      ORDER BY c.conversation_id)
      FROM declaration.conversation_snapshot(v_actor.institution_id, p_assignment, v_actor.user_id,
        v_document.id, v_document.current_revision) c), '[]'::jsonb));
END $$;

REVOKE EXECUTE ON FUNCTION declaration.list_conversations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.list_conversations(uuid) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION declaration.list_conversations(uuid);
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT NULL::uuid, NULL::text, NULL::integer, NULL::text[] WHERE false
$$;
RESET ROLE;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.declaration_conversation_hashes(uuid, uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
