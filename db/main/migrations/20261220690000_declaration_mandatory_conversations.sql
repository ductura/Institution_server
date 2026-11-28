-- migrate:up
-- F4-PRE-R02-SRV2 part B (declaration-v1 2.2 and 2.4): the mandatory reason
-- transferred. Replaces the body of declaration.conversation_snapshot
-- (20261220520000), which returned only student_added, and of
-- declaration.check_conversation_refs (20261129112000), which now reads a
-- switch per institution. Expand only: the payload, its hash, the closed reason
-- set and the HTTP contract stay as they are.
--
--   declaration.mandatory_attachment_setting   the switch of the mandatory
--       check, one row per institution, like evidence.assistant_match_setting
--       but with the opposite default: no row means the check is off. Written
--       only by the owner's SQL (ductus_evidence); no runtime role reads it.
--   assistant.ai_transfer_through_seqs   for the transfer records a chain
--       names, the student's conversations they come from on the assignment and
--       the last seq of a transferred response in each. Reads assistant.* as
--       ductus_identity, like ai_transfer_link_sha256; only ductus_evidence may
--       call it.
--   declaration.conversation_snapshot   a conversation is transferred when a
--       transfer record named by a segment of the declared document, with a
--       receipt up to the revision, comes from it; required_through_seq is the
--       highest seq of such a response (rule 1 of 2.4), never above the
--       messages known. Every other conversation stays student_added with 0.
--   declaration.check_conversation_refs   with the switch off, neither a
--       missing mandatory conversation nor a throughSeq below
--       required_through_seq is reported; reason and throughSeq of each
--       attachment are returned either way.
--
-- Decisions (owner, F4 val 2 #7):
--   OD-7  transferred_deleted is not returned: it needs the text of the events,
--         which exists only in replay (declaration-v1 section 8). A transfer
--         whose text was later deleted stays transferred; the obligation is
--         the same.
--   pasted_known is deferred until the verdicts of a paste are stored; no
--         table holds them yet.
--   The switch is off by default. While it is off, a confirmation that refers
--   to an older revision answers attachment_stale instead of stale_revision
--   when a transfer appeared in between (save_statement compares the reasons
--   of the two snapshots); both reasons are in the contract.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION assistant.ai_transfer_through_seqs(
  p_institution_id uuid, p_student_id uuid, p_document_id text, p_assignment_id uuid, p_transfer_ids uuid[]
) RETURNS TABLE (conversation_id uuid, through_seq integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT t.conversation_id, max(m.seq)
    FROM assistant.ai_transfer t
    JOIN assistant.conversation c ON (c.id, c.institution_id) = (t.conversation_id, t.institution_id)
    JOIN assistant.message m ON (m.id, m.conversation_id, m.institution_id)
      = (t.response_id, t.conversation_id, t.institution_id)
   WHERE t.transfer_id = ANY (p_transfer_ids) AND t.institution_id = p_institution_id
     AND t.student_id = p_student_id AND t.document_id = p_document_id
     AND c.student_id = p_student_id AND c.assignment_id = p_assignment_id
     AND m.role = 'provider_response'
   GROUP BY t.conversation_id
$$;
REVOKE ALL ON FUNCTION assistant.ai_transfer_through_seqs(uuid, uuid, text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.ai_transfer_through_seqs(uuid, uuid, text, uuid, uuid[]) TO ductus_evidence;

RESET ROLE;
SET LOCAL ROLE ductus_evidence;

-- No FK to the institution, as evidence.assistant_match_setting.
CREATE TABLE declaration.mandatory_attachment_setting (
  institution_id uuid PRIMARY KEY,
  enabled boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE declaration.mandatory_attachment_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE declaration.mandatory_attachment_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY mandatory_attachment_setting_owner ON declaration.mandatory_attachment_setting
  TO ductus_evidence USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT h.conversation_id,
         CASE WHEN x.through_seq IS NULL THEN 'student_added' ELSE 'transferred' END,
         coalesce(least(x.through_seq, cardinality(h.message_hashes)), 0),
         h.message_hashes
    FROM app.declaration_conversation_hashes(p_assignment, p_student) h
    LEFT JOIN assistant.ai_transfer_through_seqs(p_institution, p_student, p_document, p_assignment, ARRAY(
      SELECT t.ai_transfer_id
        FROM evidence.segment_ai_transfer t
        JOIN evidence.segment s ON (s.id, s.evidence_package_id, s.institution_id, s.principal_id)
          = (t.segment_id, t.evidence_package_id, t.institution_id, t.principal_id)
       WHERE s.institution_id = p_institution AND s.principal_id = p_student AND s.document_id = p_document
         AND EXISTS (SELECT 1 FROM evidence.receipt r
                      WHERE (r.segment_id, r.evidence_package_id, r.institution_id)
                          = (s.id, s.evidence_package_id, s.institution_id)
                        AND (r.receipt_payload::jsonb->>'revision')::bigint <= p_revision))) x
      ON x.conversation_id = h.conversation_id
$$;

CREATE OR REPLACE FUNCTION declaration.check_conversation_refs(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint, p_refs jsonb
) RETURNS TABLE (has_unknown boolean, too_many boolean, missing jsonb, stale jsonb, attachments jsonb)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH setting AS (
    SELECT coalesce((SELECT s.enabled FROM declaration.mandatory_attachment_setting s
                      WHERE s.institution_id = p_institution), false) AS enabled
  ), requested AS (
    SELECT r AS ref, (r->>'conversationId')::uuid AS id, (r->>'throughSeq')::bigint AS seq
    FROM jsonb_array_elements(p_refs) r
  ), checks AS (
    SELECT c.conversation_id, c.reason, r.ref, r.id, CASE
      WHEN r.seq IS NULL OR c.conversation_id IS NULL THEN false
      WHEN ((SELECT enabled FROM setting) AND r.seq < c.required_through_seq)
        OR r.seq > cardinality(c.message_hashes) THEN true
      ELSE (r.ref->>'messagesSha256') IS DISTINCT FROM encode(sha256(
        convert_to(array_to_json(c.message_hashes[1:r.seq::integer])::text, 'UTF8')), 'hex')
      END AS is_stale
    FROM declaration.conversation_snapshot(p_institution,p_assignment,p_student,p_document,p_revision) c
    FULL JOIN requested r ON r.id = c.conversation_id
  ), limits AS (
    SELECT 50 AS max_student_added
  )
  SELECT count(*) FILTER (WHERE conversation_id IS NULL) > 0,
    count(*) FILTER (WHERE id IS NOT NULL AND reason = 'student_added') > (SELECT max_student_added FROM limits),
    coalesce(jsonb_agg(conversation_id ORDER BY conversation_id)
      FILTER (WHERE id IS NULL AND reason <> 'student_added' AND (SELECT enabled FROM setting)), '[]'::jsonb),
    coalesce(jsonb_agg(conversation_id ORDER BY conversation_id) FILTER (WHERE is_stale), '[]'::jsonb),
    coalesce(jsonb_agg(ref || jsonb_build_object('reason',reason)
      ORDER BY array_position(ARRAY['transferred_deleted','transferred','pasted_known','student_added'],reason),
        conversation_id) FILTER (WHERE ref IS NOT NULL AND conversation_id IS NOT NULL AND NOT is_stale), '[]'::jsonb)
  FROM checks
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION declaration.check_conversation_refs(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint, p_refs jsonb
) RETURNS TABLE (has_unknown boolean, too_many boolean, missing jsonb, stale jsonb, attachments jsonb)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH requested AS (
    SELECT r AS ref, (r->>'conversationId')::uuid AS id, (r->>'throughSeq')::bigint AS seq
    FROM jsonb_array_elements(p_refs) r
  ), checks AS (
    SELECT c.conversation_id, c.reason, r.ref, r.id, CASE
      WHEN r.seq IS NULL OR c.conversation_id IS NULL THEN false
      WHEN r.seq < c.required_through_seq OR r.seq > cardinality(c.message_hashes) THEN true
      ELSE (r.ref->>'messagesSha256') IS DISTINCT FROM encode(sha256(
        convert_to(array_to_json(c.message_hashes[1:r.seq::integer])::text, 'UTF8')), 'hex')
      END AS is_stale
    FROM declaration.conversation_snapshot(p_institution,p_assignment,p_student,p_document,p_revision) c
    FULL JOIN requested r ON r.id = c.conversation_id
  ), limits AS (
    SELECT 50 AS max_student_added
  )
  SELECT count(*) FILTER (WHERE conversation_id IS NULL) > 0,
    count(*) FILTER (WHERE id IS NOT NULL AND reason = 'student_added') > (SELECT max_student_added FROM limits),
    coalesce(jsonb_agg(conversation_id ORDER BY conversation_id)
      FILTER (WHERE id IS NULL AND reason <> 'student_added'), '[]'::jsonb),
    coalesce(jsonb_agg(conversation_id ORDER BY conversation_id) FILTER (WHERE is_stale), '[]'::jsonb),
    coalesce(jsonb_agg(ref || jsonb_build_object('reason',reason)
      ORDER BY array_position(ARRAY['transferred_deleted','transferred','pasted_known','student_added'],reason),
        conversation_id) FILTER (WHERE ref IS NOT NULL AND conversation_id IS NOT NULL AND NOT is_stale), '[]'::jsonb)
  FROM checks
$$;

CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT h.conversation_id, 'student_added'::text, 0, h.message_hashes
    FROM app.declaration_conversation_hashes(p_assignment, p_student) h
$$;

DROP TABLE declaration.mandatory_attachment_setting;

RESET ROLE;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION assistant.ai_transfer_through_seqs(uuid, uuid, text, uuid, uuid[]);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
