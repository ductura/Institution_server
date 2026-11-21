-- migrate:up
-- SRV-1214. Step 5 of docs/contracts/declaration-v1.md: the link between a
-- declaration and the submission. SRV-1510 already expanded
-- evidence.submission_request with declaration_version_id and
-- declaration_sha256 (NULL for older requests) and pins them in the same
-- transaction as app.request_submission, under declaration.lock_scope. This
-- step adds the freshness rule of section 6.2 to that pin and to the state
-- the student reads (section 5), from one function:
--   * the latest confirmed version names the submitted document, the
--     submitted revision (OD-15) and the current assignment version;
--   * every conversation that evidence through that revision makes required
--     is among its attachments;
--   * no attachment is attachment_stale (2.4): each still names a prefix the
--     conversation has, with the same hash, reaching every transfer.
-- A version that is not fresh is never pinned (6.3): the teacher would get a
-- conversation version the student did not confirm. No assignment can ask
-- for a confirmed declaration yet (D-129 is conditional, OD-6), so the
-- declaration never blocks a submission: the request is written without it.
-- A technical error while reading the declaration does not block either
-- (rule 11); the request is written without a declaration.
-- The receipt is unchanged here: submission-receipt-v2 stays byte-equal.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE FUNCTION declaration.is_fresh(p_saved declaration.statement, p_document text, p_revision bigint,
  p_assignment_version integer) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_check record;
BEGIN
  IF p_saved.id IS NULL OR p_saved.payload_jcs IS NULL
     OR p_saved.document_id IS DISTINCT FROM p_document
     OR p_saved.revision IS DISTINCT FROM p_revision
     OR p_saved.assignment_version IS DISTINCT FROM p_assignment_version
  THEN RETURN false; END IF;
  SELECT * INTO v_check FROM declaration.check_conversation_refs(
    p_saved.institution_id, p_saved.assignment_id, p_saved.principal_id, p_saved.document_id, p_saved.revision,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('conversationId', a.conversation_id,
        'throughSeq', a.through_seq, 'messagesSha256', a.messages_sha256) ORDER BY a.conversation_id), '[]'::jsonb)
       FROM declaration.conversation_attachment a
      WHERE (a.statement_id, a.institution_id) = (p_saved.id, p_saved.institution_id)));
  RETURN v_check.has_unknown IS FALSE AND v_check.missing = '[]'::jsonb AND v_check.stale = '[]'::jsonb;
END $$;
REVOKE EXECUTE ON FUNCTION declaration.is_fresh(declaration.statement,text,bigint,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION declaration.pin_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_saved declaration.statement%ROWTYPE;
BEGIN
  -- app.request_submission runs as the evidence owner. Any other caller
  -- reaches its ordinary RLS check without invoking a private helper.
  IF current_user <> 'ductus_evidence' THEN RETURN NEW; END IF;
  PERFORM declaration.lock_scope(NEW.institution_id, NEW.assignment_id, NEW.principal_id);
  -- Only this trigger chooses the pinned version, never the inserting row.
  NEW.declaration_version_id := NULL;
  NEW.declaration_sha256 := NULL;
  BEGIN
    SELECT * INTO v_saved FROM declaration.statement s
     WHERE (s.institution_id, s.assignment_id, s.principal_id)
         = (NEW.institution_id, NEW.assignment_id, NEW.principal_id)
       AND s.payload_jcs IS NOT NULL
     ORDER BY s.version DESC LIMIT 1;
    IF FOUND AND declaration.is_fresh(v_saved, NEW.document_id, NEW.revision, NEW.assignment_version) THEN
      NEW.declaration_version_id := v_saved.id;
      NEW.declaration_sha256 := v_saved.content_sha256;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Section 6.3, rule 11: the submission goes ahead without a declaration.
    NEW.declaration_version_id := NULL;
    NEW.declaration_sha256 := NULL;
  END;
  RETURN NEW;
END $$;

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
  -- Section 5: confirmed only while the version is fresh for the current
  -- revision (6.2), so a confirmed state is exactly what a request pins.
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
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads));
END $$;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
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
    WHEN v_saved.revision = p_revision AND v_saved.assignment_version = p_assignment_version THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads));
END $$;

CREATE OR REPLACE FUNCTION declaration.pin_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user <> 'ductus_evidence' THEN RETURN NEW; END IF;
  PERFORM declaration.lock_scope(NEW.institution_id, NEW.assignment_id, NEW.principal_id);
  SELECT s.id, s.content_sha256 INTO NEW.declaration_version_id, NEW.declaration_sha256
    FROM declaration.statement s
   WHERE s.institution_id = NEW.institution_id AND s.assignment_id = NEW.assignment_id
     AND s.principal_id = NEW.principal_id AND s.payload_jcs IS NOT NULL
   ORDER BY s.version DESC LIMIT 1;
  IF NEW.declaration_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM declaration.statement s WHERE s.id = NEW.declaration_version_id
      AND s.document_id = NEW.document_id AND s.revision = NEW.revision
      AND s.assignment_version = NEW.assignment_version
  ) THEN
    NEW.declaration_version_id := NULL;
    NEW.declaration_sha256 := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION declaration.is_fresh(declaration.statement,text,bigint,integer);
