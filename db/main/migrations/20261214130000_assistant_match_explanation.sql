-- migrate:up
-- PIL-P1-PODUDARANJE-OBJASNJENJE-SRV (Ductus#2052; P-1, rule 13): the student's
-- explanation of a finding of the match with the assistant (20261213100800).
-- The student who owns the work writes it once per finding (the segment and the
-- answer it matches); it is never rewritten or removed. The student and the
-- readers of the work read it with the findings. While the switch of the
-- institution (assistantMatchEnabled) is off nothing is written or read.
--
--   evidence.assistant_match_explanation   one per finding: the text (1 to 2000
--                                          characters, NFC, not blank, no
--                                          control character but newline and
--                                          tab, no bidirectional control) and
--                                          when it was written. Append-only.
--
-- Only through the RPCs. The table belongs to the evidence role with forced RLS
-- and no privilege for any other role. Who writes comes from the relation to the
-- work (the student owner), who reads from the relation too (the owner, or a
-- reader of the work), through app.origin_work_access (C-23). One answer, ZD403,
-- for every refusal, also for a finding that does not exist and while the switch
-- is off; ZD409 for a second explanation of the same finding; ZD401 no session,
-- ZD422 invalid input.
--
--   app.assistant_match_explain       the owner explains a finding, once
--   app.assistant_match_explanations  the explanations of a work, the same for
--                                     the owner and the readers, none while the
--                                     switch is off
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- The key of a finding with its institution, for the foreign key below: every
-- foreign key to a table that carries institution_id includes it.
ALTER TABLE evidence.assistant_match_finding
  ADD CONSTRAINT assistant_match_finding_institution_key
  UNIQUE (institution_id, assignment_id, student_id, segment_ref, message_id);

CREATE TABLE evidence.assistant_match_explanation (
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  segment_ref text NOT NULL,
  message_id uuid NOT NULL,
  explanation_text text NOT NULL CHECK (
    explanation_text IS NFC NORMALIZED
    AND char_length(explanation_text) BETWEEN 1 AND 2000
    AND explanation_text ~ '[^[:space:]]'
    AND translate(explanation_text, E'\n\t', '') !~ '[[:cntrl:]]'
    AND explanation_text !~ E'[‪-‮⁦-⁩]'),
  written_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (assignment_id, student_id, segment_ref, message_id),
  FOREIGN KEY (institution_id, assignment_id, student_id, segment_ref, message_id)
    REFERENCES evidence.assistant_match_finding (institution_id, assignment_id, student_id, segment_ref, message_id)
);

CREATE TRIGGER assistant_match_explanation_guard BEFORE UPDATE OR DELETE ON evidence.assistant_match_explanation
  FOR EACH ROW EXECUTE FUNCTION evidence.assistant_match_append_only();
CREATE TRIGGER assistant_match_explanation_no_truncate BEFORE TRUNCATE ON evidence.assistant_match_explanation
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.assistant_match_append_only();

ALTER TABLE evidence.assistant_match_explanation ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.assistant_match_explanation FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_match_explanation_owner ON evidence.assistant_match_explanation
  TO ductus_evidence USING (true) WITH CHECK (true);

-- Evidence-owned workers, called only by the identity-owned RPCs below.
CREATE FUNCTION app.assistant_match_explanation_add(
  p_assignment_id uuid, p_student_id uuid, p_segment_ref text, p_message_id uuid, p_text text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_written timestamptz;
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL OR NOT app.assistant_match_enabled() OR NOT EXISTS (
       SELECT 1 FROM evidence.assistant_match_finding f
        WHERE f.institution_id = v_institution AND f.assignment_id = p_assignment_id
          AND f.student_id = p_student_id AND f.segment_ref = p_segment_ref AND f.message_id = p_message_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO evidence.assistant_match_explanation
    (institution_id, assignment_id, student_id, segment_ref, message_id, explanation_text)
  VALUES (v_institution, p_assignment_id, p_student_id, p_segment_ref, p_message_id, p_text)
  ON CONFLICT (assignment_id, student_id, segment_ref, message_id) DO NOTHING
  RETURNING written_at INTO v_written;
  IF v_written IS NULL THEN
    RAISE EXCEPTION 'already explained' USING ERRCODE = 'ZD409';
  END IF;
  RETURN v_written;
END
$$;

CREATE FUNCTION app.assistant_match_explanations_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (segment_ref text, message_id uuid, explanation_text text, written_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.segment_ref, e.message_id, e.explanation_text, e.written_at
    FROM app.current_actor() a
    JOIN evidence.assistant_match_explanation e
      ON e.institution_id = a.institution_id AND e.assignment_id = p_assignment_id AND e.student_id = p_student_id
   WHERE app.assistant_match_enabled()
   ORDER BY e.written_at, e.segment_ref, e.message_id
$$;

REVOKE ALL ON FUNCTION app.assistant_match_explanation_add(uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_explanations_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_match_explanation_add(uuid, uuid, text, uuid, text) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.assistant_match_explanations_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.assistant_match_explain(p_document_id text, p_segment_ref text, p_message_id uuid, p_text text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_segment_ref IS NULL OR char_length(p_segment_ref) NOT BETWEEN 1 AND 128 OR p_segment_ref ~ '[[:cntrl:]]'
     OR p_message_id IS NULL OR NOT coalesce(collaboration.is_comment_body(p_text), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.assistant_match_explanation_add(v_access.assignment_id, v_access.student_id, p_segment_ref,
                                             p_message_id, p_text);
END
$$;

CREATE FUNCTION app.assistant_match_explanations(p_document_id text)
RETURNS TABLE (segment_ref text, message_id uuid, explanation_text text, written_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.assistant_match_explanations_of(v_access.assignment_id, v_access.student_id);
END
$$;

REVOKE ALL ON FUNCTION app.assistant_match_explain(text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assistant_match_explanations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_match_explain(text, text, uuid, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.assistant_match_explanations(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (Ductus docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assistant_match_explanations(text);
DROP FUNCTION app.assistant_match_explain(text, text, uuid, text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.assistant_match_explanations_of(uuid, uuid);
DROP FUNCTION app.assistant_match_explanation_add(uuid, uuid, text, uuid, text);
DROP TABLE evidence.assistant_match_explanation;
ALTER TABLE evidence.assistant_match_finding DROP CONSTRAINT assistant_match_finding_institution_key;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
