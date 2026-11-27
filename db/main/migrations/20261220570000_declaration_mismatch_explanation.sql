-- migrate:up
-- F4-PRE-R02-SRV2 (R-35): when the student picks a pattern of use that the
-- record of transfers from the Asistent contradicts (no use, while a transfer
-- is recorded), the student may add a short explanation. Expand only;
-- declaration-v1 payloads, their hashes and the receipt stay byte-equal. As
-- the answer to the teacher's question (20261214150000, declaration-v1
-- section 6.8), the explanation is not part of the hashed payload: it is a
-- row bound to one statement row (a draft or a confirmed version), so it is
-- stale or bound exactly when that version is. It never blocks a submission.
--
--   declaration.mismatch_explanation  the student's explanation, up to 2000
--                   code points, bound to one statement row. A draft's
--                   explanation goes with the draft; a confirmed version's
--                   explanation never changes.
--   declaration.save_statement_explained()  save_statement_answer and the
--                   explanation in one transaction; nothing is written when
--                   any of them is refused.
--   declaration.view_statement()  also mismatchExplanation.
--
-- Nobody writes another person's explanation: the only writer is the owner's
-- save_statement_explained, under the student's own session. Errors carry no
-- input: ZD403 a confirmed version's explanation, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE declaration.mismatch_explanation (
  statement_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  explanation_text text NOT NULL CHECK (declaration.valid_text(explanation_text, 2000, true)),
  FOREIGN KEY (statement_id, institution_id) REFERENCES declaration.statement (id, institution_id)
);
ALTER TABLE declaration.mismatch_explanation ENABLE ROW LEVEL SECURITY;
ALTER TABLE declaration.mismatch_explanation FORCE ROW LEVEL SECURITY;
CREATE POLICY mismatch_explanation_owner ON declaration.mismatch_explanation
  TO ductus_evidence USING (true) WITH CHECK (true);

-- No update; a delete only when its statement row is not a confirmed version
-- (declaration.reject_answer_change checks OLD.statement_id).
CREATE TRIGGER mismatch_explanation_immutable BEFORE UPDATE OR DELETE ON declaration.mismatch_explanation
  FOR EACH ROW EXECUTE FUNCTION declaration.reject_answer_change();
CREATE TRIGGER mismatch_explanation_no_truncate BEFORE TRUNCATE ON declaration.mismatch_explanation
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- save_statement replaces the draft row by deleting it; its explanation goes
-- first. A confirmed row is never deleted (statement_immutable).
CREATE FUNCTION declaration.delete_draft_explanation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM declaration.mismatch_explanation e
   WHERE e.statement_id = OLD.id AND e.institution_id = OLD.institution_id;
  RETURN OLD;
END $$;
CREATE TRIGGER statement_draft_explanation BEFORE DELETE ON declaration.statement
  FOR EACH ROW WHEN (OLD.draft IS NOT NULL) EXECUTE FUNCTION declaration.delete_draft_explanation();

-- save_statement_answer and the explanation in one call. p_explanation is
-- null (no explanation) or a text of 1 to 2000 code points (as
-- declaration.valid_text, multiline). Every refusal of save_statement_answer
-- is returned unchanged; an invalid explanation is invalid_input and nothing
-- of the save stays.
CREATE FUNCTION declaration.save_statement_explained(p_assignment uuid, p_body jsonb, p_form_file text,
  p_answer jsonb, p_explanation text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor record;
  v_result jsonb;
  v_statement declaration.statement%ROWTYPE;
BEGIN
  BEGIN
    v_result := declaration.save_statement_answer(p_assignment, p_body, p_form_file, p_answer);
    IF v_result->>'status' = 'ok' AND p_explanation IS NOT NULL THEN
      -- Checked after the save, so a refusal of its own is answered first.
      IF NOT declaration.valid_text(p_explanation, 2000, true) THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
      SELECT * INTO v_actor FROM app.current_actor();
      SELECT * INTO v_statement FROM declaration.statement s
       WHERE (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
       ORDER BY s.version DESC LIMIT 1;
      INSERT INTO declaration.mismatch_explanation (statement_id, institution_id, explanation_text)
      VALUES (v_statement.id, v_statement.institution_id, p_explanation);
      v_result := jsonb_set(v_result, '{statement,mismatchExplanation}', to_jsonb(p_explanation));
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZD422' THEN
    -- The subtransaction is rolled back: neither the statement row nor the
    -- answer is written.
    RETURN '{"status":"invalid_input"}';
  END;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION declaration.save_statement_explained(uuid, jsonb, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.save_statement_explained(uuid, jsonb, text, jsonb, text) TO ductus_app;
REVOKE ALL ON FUNCTION declaration.delete_draft_explanation() FROM PUBLIC;

-- As 20261214150000, with mismatchExplanation: the explanation of the row the
-- state is about, so it is draft, confirmed, stale or bound exactly as the
-- declaration is.
CREATE OR REPLACE FUNCTION declaration.view_statement(p_institution uuid, p_assignment uuid, p_student uuid,
  p_revision bigint, p_assignment_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_saved declaration.statement%ROWTYPE;
  v_uploads jsonb;
  v_state text;
BEGIN
  SELECT * INTO v_request FROM evidence.submission_request q
    WHERE (q.institution_id, q.assignment_id, q.principal_id) = (p_institution, p_assignment, p_student)
      AND evidence.request_live(q.id, q.institution_id);
  SELECT * INTO v_saved FROM declaration.statement s
    WHERE (s.institution_id, s.assignment_id, s.principal_id) = (p_institution, p_assignment, p_student)
      AND (v_request.id IS NULL OR s.id = v_request.declaration_version_id)
    ORDER BY s.version DESC LIMIT 1;
  v_state := CASE WHEN v_saved.id IS NULL THEN 'none'
    WHEN v_request.id IS NOT NULL THEN 'bound'
    WHEN v_saved.draft IS NOT NULL THEN 'draft'
    WHEN declaration.is_fresh(v_saved, v_saved.document_id, p_revision, p_assignment_version) THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads,
    'declarationRequired', app.assignment_declaration_required(p_assignment),
    'teacherQuestion', app.assignment_declaration_question(p_assignment),
    'questionAnswer', (SELECT declaration.answer_ref(a) FROM declaration.question_answer a
                        WHERE a.statement_id = v_saved.id AND a.institution_id = p_institution),
    'mismatchExplanation', (SELECT e.explanation_text FROM declaration.mismatch_explanation e
                             WHERE e.statement_id = v_saved.id AND e.institution_id = p_institution)));
END $$;
-- Unchanged: only the definer functions of its owner call it (010 holds PUBLIC out).
REVOKE ALL ON FUNCTION declaration.view_statement(uuid, uuid, uuid, bigint, integer) FROM PUBLIC;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
-- Local only.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION declaration.view_statement(p_institution uuid, p_assignment uuid, p_student uuid,
  p_revision bigint, p_assignment_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_saved declaration.statement%ROWTYPE;
  v_uploads jsonb;
  v_state text;
BEGIN
  SELECT * INTO v_request FROM evidence.submission_request q
    WHERE (q.institution_id, q.assignment_id, q.principal_id) = (p_institution, p_assignment, p_student)
      AND evidence.request_live(q.id, q.institution_id);
  SELECT * INTO v_saved FROM declaration.statement s
    WHERE (s.institution_id, s.assignment_id, s.principal_id) = (p_institution, p_assignment, p_student)
      AND (v_request.id IS NULL OR s.id = v_request.declaration_version_id)
    ORDER BY s.version DESC LIMIT 1;
  v_state := CASE WHEN v_saved.id IS NULL THEN 'none'
    WHEN v_request.id IS NOT NULL THEN 'bound'
    WHEN v_saved.draft IS NOT NULL THEN 'draft'
    WHEN declaration.is_fresh(v_saved, v_saved.document_id, p_revision, p_assignment_version) THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads,
    'declarationRequired', app.assignment_declaration_required(p_assignment),
    'teacherQuestion', app.assignment_declaration_question(p_assignment),
    'questionAnswer', (SELECT declaration.answer_ref(a) FROM declaration.question_answer a
                        WHERE a.statement_id = v_saved.id AND a.institution_id = p_institution)));
END $$;
DROP FUNCTION declaration.save_statement_explained(uuid, jsonb, text, jsonb, text);
DROP TRIGGER statement_draft_explanation ON declaration.statement;
DROP TABLE declaration.mismatch_explanation;
DROP FUNCTION declaration.delete_draft_explanation();
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
