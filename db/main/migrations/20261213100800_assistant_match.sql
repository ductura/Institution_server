-- migrate:up
-- SRV-1230 (Ductus#2052; P-1, rule 13): the match of a segment of a work with an
-- answer of the assistant of the same work, 8 or more words in a row. The
-- comparison itself is deterministic and runs in server/assistant-match; here
-- stand the two records it leaves and the switch.
--
--   evidence.assistant_match_finding     one finding: the segment (its reference
--                                        in the work), the answer it matches
--                                        (conversation and message ids) and the
--                                        length of the longest run in words.
--                                        Ids and a number only: no text of the
--                                        segment or of the answer is copied.
--                                        Append-only; the student sees the same.
--   evidence.assistant_match_attachment  the conversation attached to the
--                                        student's declaration as transferred
--                                        text (D-41), one per conversation,
--                                        made together with the finding. The
--                                        declaration producer (M9.5) reads it.
--   evidence.assistant_match_setting     the switch of an institution
--                                        (assistantMatchEnabled). No row means
--                                        ON: the pilot has it on (Daniel,
--                                        22. 11. 2026). Written only by the
--                                        owner's SQL, no RPC writes it. While it
--                                        is OFF nothing is read, computed or
--                                        saved, and nothing is shown.
--
-- Only through the RPCs. The tables belong to the evidence role with forced RLS
-- and no privilege for any other role. Who writes comes from the relation to the
-- work (the student owner of the document), who reads from the relation too (the
-- owner, or a reader of the work as for the origin records): C-23, through
-- app.origin_work_access (SRV-0910). One answer, ZD403, for every refusal, also
-- for an unknown document, a message of someone else and a message that is not an
-- answer of the assistant. ZD401 no session, ZD422 invalid input.
--
--   app.assistant_match_responses  the answers of the assistant of the owner's
--                                  conversations of this assignment (the newest
--                                  200), none while the switch is off
--   app.assistant_match_record     the owner records a finding and attaches the
--                                  conversation; false when nothing was new
--   app.assistant_match_read       the findings of a work, the same for the owner
--                                  and the readers, none while the switch is off
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT USAGE ON SCHEMA institution, identity TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.assignment, identity.user_account TO ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.assistant_match_finding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  segment_ref text NOT NULL CHECK (char_length(segment_ref) BETWEEN 1 AND 128 AND segment_ref !~ '[[:cntrl:]]'),
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  run_words integer NOT NULL CHECK (run_words BETWEEN 8 AND 100000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id, segment_ref, message_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assistant_match_finding_work_idx
  ON evidence.assistant_match_finding (institution_id, assignment_id, student_id, seq);

CREATE TABLE evidence.assistant_match_attachment (
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  reason text NOT NULL DEFAULT 'assistant_match' CHECK (reason = 'assistant_match'),
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_id, conversation_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

CREATE TABLE evidence.assistant_match_setting (
  institution_id uuid PRIMARY KEY,
  enabled boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION evidence.assistant_match_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'assistant match is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER assistant_match_finding_guard BEFORE UPDATE OR DELETE ON evidence.assistant_match_finding
  FOR EACH ROW EXECUTE FUNCTION evidence.assistant_match_append_only();
CREATE TRIGGER assistant_match_finding_no_truncate BEFORE TRUNCATE ON evidence.assistant_match_finding
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.assistant_match_append_only();
CREATE TRIGGER assistant_match_attachment_guard BEFORE UPDATE OR DELETE ON evidence.assistant_match_attachment
  FOR EACH ROW EXECUTE FUNCTION evidence.assistant_match_append_only();
CREATE TRIGGER assistant_match_attachment_no_truncate BEFORE TRUNCATE ON evidence.assistant_match_attachment
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.assistant_match_append_only();

ALTER TABLE evidence.assistant_match_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.assistant_match_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_match_finding_owner ON evidence.assistant_match_finding TO ductus_evidence USING (true) WITH CHECK (true);
ALTER TABLE evidence.assistant_match_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.assistant_match_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_match_attachment_owner ON evidence.assistant_match_attachment TO ductus_evidence USING (true) WITH CHECK (true);
ALTER TABLE evidence.assistant_match_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.assistant_match_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_match_setting_owner ON evidence.assistant_match_setting TO ductus_evidence USING (true) WITH CHECK (true);

-- Evidence-owned workers, called only by the identity-owned RPCs below.
CREATE FUNCTION app.assistant_match_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.enabled FROM evidence.assistant_match_setting s WHERE s.institution_id = a.institution_id), true)
    FROM app.current_actor() a WHERE a.institution_id IS NOT NULL
$$;

CREATE FUNCTION app.assistant_match_finding_add(
  p_assignment_id uuid, p_student_id uuid, p_segment_ref text, p_conversation_id uuid, p_message_id uuid, p_run_words integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_rows integer;
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL OR NOT app.assistant_match_enabled() THEN RETURN false; END IF;
  INSERT INTO evidence.assistant_match_finding
    (institution_id, assignment_id, student_id, segment_ref, conversation_id, message_id, run_words)
  VALUES (v_institution, p_assignment_id, p_student_id, p_segment_ref, p_conversation_id, p_message_id, p_run_words)
  ON CONFLICT (assignment_id, student_id, segment_ref, message_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  INSERT INTO evidence.assistant_match_attachment (institution_id, assignment_id, student_id, conversation_id)
  VALUES (v_institution, p_assignment_id, p_student_id, p_conversation_id)
  ON CONFLICT DO NOTHING;
  RETURN v_rows = 1;
END
$$;

CREATE FUNCTION app.assistant_match_findings_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (segment_ref text, conversation_id uuid, message_id uuid, run_words integer, recorded_at timestamptz, attached_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT f.segment_ref, f.conversation_id, f.message_id, f.run_words, f.recorded_at, t.attached_at
    FROM app.current_actor() a
    JOIN evidence.assistant_match_finding f
      ON f.institution_id = a.institution_id AND f.assignment_id = p_assignment_id AND f.student_id = p_student_id
    JOIN evidence.assistant_match_attachment t
      ON t.assignment_id = f.assignment_id AND t.student_id = f.student_id AND t.conversation_id = f.conversation_id
   WHERE app.assistant_match_enabled()
   ORDER BY f.seq
$$;

REVOKE ALL ON FUNCTION evidence.assistant_match_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_finding_add(uuid, uuid, text, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_findings_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_match_enabled() TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.assistant_match_finding_add(uuid, uuid, text, uuid, uuid, integer) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.assistant_match_findings_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
GRANT USAGE ON SCHEMA assistant TO ductus_identity;

CREATE FUNCTION app.assistant_match_responses(p_document_id text)
RETURNS TABLE (conversation_id uuid, message_id uuid, content text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  IF NOT app.assistant_match_enabled() THEN RETURN; END IF;
  RETURN QUERY
    SELECT m.conversation_id, m.id, m.content
      FROM assistant.conversation c
      JOIN assistant.message m ON m.conversation_id = c.id AND m.institution_id = c.institution_id
     WHERE c.assignment_id = v_access.assignment_id AND c.student_id = v_access.student_id
       AND m.role = 'provider_response'
     ORDER BY m.created_at DESC, m.id
     LIMIT 200;
END
$$;

CREATE FUNCTION app.assistant_match_record(p_document_id text, p_segment_ref text, p_message_id uuid, p_run_words integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
  v_conversation uuid;
BEGIN
  PERFORM institution.require_actor();
  IF p_segment_ref IS NULL OR char_length(p_segment_ref) NOT BETWEEN 1 AND 128 OR p_segment_ref ~ '[[:cntrl:]]'
     OR p_message_id IS NULL OR p_run_words IS NULL OR p_run_words NOT BETWEEN 8 AND 100000 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  IF NOT app.assistant_match_enabled() THEN RETURN false; END IF;
  SELECT m.conversation_id INTO v_conversation
    FROM assistant.message m
    JOIN assistant.conversation c ON c.id = m.conversation_id AND c.institution_id = m.institution_id
   WHERE m.id = p_message_id AND m.role = 'provider_response'
     AND c.assignment_id = v_access.assignment_id AND c.student_id = v_access.student_id;
  IF v_conversation IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN app.assistant_match_finding_add(v_access.assignment_id, v_access.student_id, p_segment_ref,
                                         v_conversation, p_message_id, p_run_words);
END
$$;

CREATE FUNCTION app.assistant_match_read(p_document_id text)
RETURNS TABLE (segment_ref text, conversation_id uuid, message_id uuid, run_words integer, recorded_at timestamptz, attached_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.assistant_match_findings_of(v_access.assignment_id, v_access.student_id);
END
$$;

REVOKE ALL ON FUNCTION app.assistant_match_responses(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_record(text, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_read(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_match_responses(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.assistant_match_record(text, text, uuid, integer) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.assistant_match_read(text) TO ductus_app;

REVOKE REFERENCES ON institution.assignment, identity.user_account FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE USAGE ON SCHEMA institution, identity FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assistant_match_read(text);
DROP FUNCTION app.assistant_match_record(text, text, uuid, integer);
DROP FUNCTION app.assistant_match_responses(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.assistant_match_findings_of(uuid, uuid);
DROP FUNCTION app.assistant_match_finding_add(uuid, uuid, text, uuid, uuid, integer);
DROP FUNCTION app.assistant_match_enabled();
DROP TABLE evidence.assistant_match_setting;
DROP TABLE evidence.assistant_match_attachment;
DROP TABLE evidence.assistant_match_finding;
DROP FUNCTION evidence.assistant_match_append_only();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
