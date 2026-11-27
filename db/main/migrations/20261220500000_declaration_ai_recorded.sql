-- SRV-1809 step 2: ai.recorded in a confirmed declaration (declaration-v1,
-- "recorded"): every ductus-ai-transfer-v1 record named by a segment in the
-- evidence chain of the declared document up to its revision, as
-- { aiTransferId, aiTransferSha256 }, ordered by aiTransferId. The links come
-- from evidence.segment_ai_transfer (20261220490000). Until then the
-- declaration carried [] because no segment could name a transfer.
-- save_statement is the 20261129112000 body with only that key changed: the
-- same signature, owner, grants and callers. Declarations already confirmed
-- keep their hashed payload; a new confirmation builds the list.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

-- Only references and hashes; provider, model, purpose and text stay in the
-- transfer record (declaration-v1, D-41). A segment counts once its receipt
-- names a revision at or before p_revision.
CREATE FUNCTION declaration.recorded_transfers(p_institution uuid, p_student uuid, p_document text, p_revision bigint)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('aiTransferId', t.ai_transfer_id::text,
      'aiTransferSha256', t.ai_transfer_sha256) ORDER BY t.ai_transfer_id), '[]'::jsonb)
    FROM evidence.segment_ai_transfer t
    JOIN evidence.segment s ON (s.id, s.evidence_package_id, s.institution_id, s.principal_id)
      = (t.segment_id, t.evidence_package_id, t.institution_id, t.principal_id)
   WHERE s.institution_id = p_institution AND s.principal_id = p_student AND s.document_id = p_document
     AND EXISTS (SELECT 1 FROM evidence.receipt r
                  WHERE (r.segment_id, r.evidence_package_id, r.institution_id)
                      = (s.id, s.evidence_package_id, s.institution_id)
                    AND (r.receipt_payload::jsonb->>'revision')::bigint <= p_revision)
$$;
REVOKE ALL ON FUNCTION declaration.recorded_transfers(uuid, uuid, text, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION declaration.save_statement(p_assignment uuid, p_body jsonb, p_form_file text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor record;
  v_assignment_version integer;
  v_document evidence.document%ROWTYPE;
  v_form jsonb;
  v_ai jsonb := p_body->'ai';
  v_help jsonb := p_body->'humanHelp';
  v_selected jsonb;
  v_conversations record;
  v_confirm boolean := (p_body->'confirm') = 'true'::jsonb;
  max_external_attachments constant integer := 10;
  v_count integer;
  v_version bigint;
  v_requested_revision bigint;
  v_changed_conversations jsonb;
  v_previous jsonb;
  v_id uuid := gen_random_uuid();
  v_payload text;
  uuid_v4_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL THEN RETURN '{"status":"unauthorized"}'; END IF;
  SELECT a.current_version INTO v_assignment_version FROM app.lock_student_assignment(p_assignment) a;
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  SELECT * INTO v_document FROM declaration.student_document(v_actor.institution_id, p_assignment, v_actor.user_id);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  PERFORM declaration.lock_scope(v_actor.institution_id, p_assignment, v_actor.user_id);

  SELECT coalesce(max(s.version), 0) INTO v_version FROM declaration.statement s
   WHERE (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id);
  IF EXISTS (SELECT 1 FROM evidence.submission_request q WHERE (q.institution_id, q.assignment_id, q.principal_id)
       = (v_actor.institution_id, p_assignment, v_actor.user_id))
  THEN RETURN '{"status":"conflict","reason":"already_submitted"}'; END IF;
  IF (p_body->'baseVersion') IS DISTINCT FROM to_jsonb(v_version) THEN
    RETURN jsonb_build_object('status','conflict','reason','declaration_conflict','currentVersion',v_version);
  END IF;
  IF v_document.current_revision = 0 OR (p_body->'revision') IS DISTINCT FROM to_jsonb(v_document.current_revision) THEN
    -- Reasons are fixed by evidence at each revision. Compare the two scoped
    -- snapshots when a confirmation still refers to an older preview.
    IF v_confirm AND jsonb_typeof(p_body->'revision') = 'number'
       AND p_body->>'revision' ~ '^[1-9][0-9]{0,15}$' THEN
      v_requested_revision := (p_body->>'revision')::bigint;
      IF v_requested_revision < v_document.current_revision AND EXISTS (
        SELECT 1 FROM evidence.document_revision r
          WHERE (r.document_id,r.institution_id,r.revision)
            = (v_document.id,v_actor.institution_id,v_requested_revision)
      ) THEN
        SELECT jsonb_agg(c.conversation_id ORDER BY c.conversation_id) INTO v_changed_conversations
          FROM declaration.conversation_snapshot(v_actor.institution_id,p_assignment,v_actor.user_id,
            v_document.id,v_document.current_revision) c
          LEFT JOIN declaration.conversation_snapshot(v_actor.institution_id,p_assignment,v_actor.user_id,
            v_document.id,v_requested_revision) previous USING (conversation_id)
          WHERE c.reason <> 'student_added' AND c.reason IS DISTINCT FROM previous.reason;
        IF v_changed_conversations IS NOT NULL THEN
          RETURN jsonb_build_object('status','conflict','reason','attachment_stale','conversationIds',v_changed_conversations);
        END IF;
      END IF;
    END IF;
    RETURN jsonb_build_object('status','conflict','reason','stale_revision','currentRevision',v_document.current_revision);
  END IF;

  IF p_form_file IS NULL THEN RETURN '{"status":"conflict","reason":"form_outdated"}'; END IF;
  IF octet_length(p_form_file) NOT BETWEEN 1 AND 128000
     OR octet_length(p_body::text) > 800000
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  v_form := p_form_file::jsonb;
  IF v_form->>'formSchema' IS DISTINCT FROM 'ductura-declaration-form-v1'
     OR coalesce(v_form->>'formId','') !~ '^[a-z0-9][a-z0-9-]{0,63}$'
     OR coalesce(v_form->>'formVersion','') !~ '^[1-9][0-9]{0,9}$'
     OR (v_form->>'formVersion')::bigint > 2147483647
     OR NOT declaration.valid_text(v_form->>'text', 20000, true)
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF (p_body->'form') IS DISTINCT FROM jsonb_build_object('formId', v_form->'formId', 'formVersion',
      v_form->'formVersion', 'formSha256', encode(sha256(convert_to(p_form_file, 'UTF8')), 'hex'))
  THEN RETURN '{"status":"conflict","reason":"form_outdated"}'; END IF;

  IF jsonb_typeof(p_body->'confirm') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_body#>'{ownWork,confirmed}') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_help->'received') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_help->'entries') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_ai->'declaredTools') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_ai->'externalAttachmentIds') IS DISTINCT FROM 'array'
     OR v_ai->'use' IS NULL OR v_ai->'use' NOT IN ('null'::jsonb, '"used"'::jsonb, '"not_used"'::jsonb)
     OR jsonb_typeof(v_ai->'attachments') IS DISTINCT FROM 'array'
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF v_help IS DISTINCT FROM jsonb_build_object('received',v_help->'received','entries',v_help->'entries')
     OR v_ai IS DISTINCT FROM jsonb_build_object('use',v_ai->'use','declaredTools',v_ai->'declaredTools',
       'attachments',v_ai->'attachments','externalAttachmentIds',v_ai->'externalAttachmentIds')
     OR p_body IS DISTINCT FROM jsonb_build_object('baseVersion',v_version,'revision',v_document.current_revision,
       'form',p_body->'form','ownWork',jsonb_build_object('confirmed',p_body#>'{ownWork,confirmed}'),
       'humanHelp',v_help,'ai',v_ai,'confirm',p_body->'confirm')
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF jsonb_array_length(v_help->'entries') > 20 OR jsonb_array_length(v_ai->'declaredTools') > 20
     OR jsonb_array_length(v_ai->'externalAttachmentIds') > max_external_attachments
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ai->'attachments') e
       WHERE jsonb_typeof(e->'throughSeq') IS DISTINCT FROM 'number'
          OR coalesce(e->>'throughSeq','') !~ '^[1-9][0-9]{0,9}$'
          OR coalesce(e->>'conversationId','') !~ uuid_v4_pattern
          OR coalesce(e->>'messagesSha256','') !~ '^[0-9a-f]{64}$'
          OR e IS DISTINCT FROM jsonb_build_object('conversationId',e->>'conversationId',
            'throughSeq',e->'throughSeq','messagesSha256',e->>'messagesSha256'))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ai->'attachments') e
       GROUP BY e->>'conversationId' HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_ai->'externalAttachmentIds') e
       GROUP BY e HAVING coalesce(e,'') !~ uuid_v4_pattern OR count(*) > 1)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_help->'entries') e
       WHERE coalesce(e->>'kind','') NOT IN ('language','structure','sources','content','technical','other')
          OR jsonb_typeof(e->'text') IS DISTINCT FROM 'string'
          OR NOT declaration.valid_text(e->>'text', 2000, true)
          OR e IS DISTINCT FROM jsonb_build_object('kind',e->'kind','text',e->'text'))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ai->'declaredTools') e
       WHERE jsonb_typeof(e->'toolLabel') IS DISTINCT FROM 'string'
          OR jsonb_typeof(e->'purposeText') IS DISTINCT FROM 'string'
          OR jsonb_typeof(e->'phaseText') IS DISTINCT FROM 'string'
          OR NOT declaration.valid_text(e->>'toolLabel', 200, false)
          OR NOT declaration.valid_text(e->>'purposeText', 200, false)
          OR NOT declaration.valid_text(e->>'phaseText', 200, false)
          OR e IS DISTINCT FROM jsonb_build_object('toolLabel',e->'toolLabel','purposeText',e->'purposeText','phaseText',e->'phaseText'))
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) || '{"reason":"external_upload"}'::jsonb
    ORDER BY a.id), '[]'::jsonb), count(*) INTO v_selected, v_count
    FROM declaration.external_attachment a WHERE
    (a.institution_id, a.assignment_id, a.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
    AND (v_ai->'externalAttachmentIds') ? a.id::text;
  IF v_count <> jsonb_array_length(v_ai->'externalAttachmentIds')
  THEN RETURN '{"status":"not_found","reason":"invalid_attachment"}'; END IF;

  SELECT * INTO v_conversations FROM declaration.check_conversation_refs(
    v_actor.institution_id, p_assignment, v_actor.user_id, v_document.id, v_document.current_revision, v_ai->'attachments');
  IF v_conversations.has_unknown THEN RETURN '{"status":"invalid_input","reason":"invalid_attachment"}'; END IF;
  IF v_conversations.too_many THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF v_confirm AND v_conversations.stale <> '[]'::jsonb THEN
    RETURN jsonb_build_object('status','conflict','reason','attachment_stale','conversationIds',v_conversations.stale);
  END IF;
  IF v_conversations.missing <> '[]'::jsonb THEN
    RETURN jsonb_build_object('status','conflict','reason','mandatory_attachment_missing','conversationIds',v_conversations.missing);
  END IF;

  IF v_confirm THEN
    IF p_body#>'{ownWork,confirmed}' <> 'true'::jsonb OR coalesce(v_ai->>'use','') = ''
       OR (v_help->'received' = 'true'::jsonb) <> (jsonb_array_length(v_help->'entries') > 0)
       OR (v_ai->>'use' = 'not_used' AND jsonb_array_length(v_ai->'declaredTools') > 0)
    THEN RETURN '{"status":"conflict","reason":"incomplete"}'; END IF;
    SELECT s.payload_jcs::jsonb INTO v_previous FROM declaration.statement s
      WHERE (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
        AND s.payload_jcs IS NOT NULL
      ORDER BY s.version DESC LIMIT 1;
    v_payload := declaration.canonical_payload(jsonb_build_object('declarationSchema','ductura-declaration-v1',
      'declarationId',coalesce(v_previous->>'declarationId',v_id::text),
      'declarationVersion',coalesce((v_previous->>'declarationVersion')::bigint,0) + 1,
      'principalId',v_actor.user_id,
      'assignmentId',p_assignment,'assignmentVersion',v_assignment_version,'documentId',v_document.id,
      'revision',v_document.current_revision,'form',p_body->'form','ownWork','{"confirmed":true}'::jsonb,
      'humanHelp',jsonb_build_object('received',v_help->'received','entries',v_help->'entries'),
      'ai',jsonb_build_object('use',v_ai->'use','declaredTools',v_ai->'declaredTools','recorded',declaration.recorded_transfers(v_actor.institution_id,v_actor.user_id,
          v_document.id,v_document.current_revision),
        'attachments',v_conversations.attachments || v_selected),
      'confirmedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  END IF;
  DELETE FROM declaration.statement s WHERE s.draft IS NOT NULL
    AND (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id);
  INSERT INTO declaration.statement (id,institution_id,assignment_id,assignment_version,project_id,principal_id,
    document_id,revision,version,form_text,draft,payload_jcs,content_sha256)
    VALUES (v_id,v_actor.institution_id,p_assignment,v_assignment_version,v_document.project_id,v_actor.user_id,
      v_document.id,v_document.current_revision,v_version + 1,v_form->>'text',
      CASE WHEN v_payload IS NULL THEN p_body END,
      v_payload, encode(sha256(convert_to(v_payload, 'UTF8')), 'hex'));
  IF v_confirm THEN
    INSERT INTO declaration.conversation_attachment
      (statement_id,institution_id,conversation_id,reason,through_seq,messages_sha256)
    SELECT v_id,v_actor.institution_id,(e->>'conversationId')::uuid,e->>'reason',
      (e->>'throughSeq')::integer,e->>'messagesSha256'
      FROM jsonb_array_elements(v_conversations.attachments) e;
  END IF;
  RETURN declaration.view_statement(v_actor.institution_id, p_assignment, v_actor.user_id,
    v_document.current_revision, v_assignment_version);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN '{"status":"invalid_input"}';
END $$;
-- Unchanged grants (20261127100200), restated.
REVOKE ALL ON FUNCTION declaration.save_statement(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.save_statement(uuid, jsonb, text) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION declaration.save_statement(p_assignment uuid, p_body jsonb, p_form_file text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor record;
  v_assignment_version integer;
  v_document evidence.document%ROWTYPE;
  v_form jsonb;
  v_ai jsonb := p_body->'ai';
  v_help jsonb := p_body->'humanHelp';
  v_selected jsonb;
  v_conversations record;
  v_confirm boolean := (p_body->'confirm') = 'true'::jsonb;
  max_external_attachments constant integer := 10;
  v_count integer;
  v_version bigint;
  v_requested_revision bigint;
  v_changed_conversations jsonb;
  v_previous jsonb;
  v_id uuid := gen_random_uuid();
  v_payload text;
  uuid_v4_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL THEN RETURN '{"status":"unauthorized"}'; END IF;
  SELECT a.current_version INTO v_assignment_version FROM app.lock_student_assignment(p_assignment) a;
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  SELECT * INTO v_document FROM declaration.student_document(v_actor.institution_id, p_assignment, v_actor.user_id);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  PERFORM declaration.lock_scope(v_actor.institution_id, p_assignment, v_actor.user_id);

  SELECT coalesce(max(s.version), 0) INTO v_version FROM declaration.statement s
   WHERE (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id);
  IF EXISTS (SELECT 1 FROM evidence.submission_request q WHERE (q.institution_id, q.assignment_id, q.principal_id)
       = (v_actor.institution_id, p_assignment, v_actor.user_id))
  THEN RETURN '{"status":"conflict","reason":"already_submitted"}'; END IF;
  IF (p_body->'baseVersion') IS DISTINCT FROM to_jsonb(v_version) THEN
    RETURN jsonb_build_object('status','conflict','reason','declaration_conflict','currentVersion',v_version);
  END IF;
  IF v_document.current_revision = 0 OR (p_body->'revision') IS DISTINCT FROM to_jsonb(v_document.current_revision) THEN
    -- Reasons are fixed by evidence at each revision. Compare the two scoped
    -- snapshots when a confirmation still refers to an older preview.
    IF v_confirm AND jsonb_typeof(p_body->'revision') = 'number'
       AND p_body->>'revision' ~ '^[1-9][0-9]{0,15}$' THEN
      v_requested_revision := (p_body->>'revision')::bigint;
      IF v_requested_revision < v_document.current_revision AND EXISTS (
        SELECT 1 FROM evidence.document_revision r
          WHERE (r.document_id,r.institution_id,r.revision)
            = (v_document.id,v_actor.institution_id,v_requested_revision)
      ) THEN
        SELECT jsonb_agg(c.conversation_id ORDER BY c.conversation_id) INTO v_changed_conversations
          FROM declaration.conversation_snapshot(v_actor.institution_id,p_assignment,v_actor.user_id,
            v_document.id,v_document.current_revision) c
          LEFT JOIN declaration.conversation_snapshot(v_actor.institution_id,p_assignment,v_actor.user_id,
            v_document.id,v_requested_revision) previous USING (conversation_id)
          WHERE c.reason <> 'student_added' AND c.reason IS DISTINCT FROM previous.reason;
        IF v_changed_conversations IS NOT NULL THEN
          RETURN jsonb_build_object('status','conflict','reason','attachment_stale','conversationIds',v_changed_conversations);
        END IF;
      END IF;
    END IF;
    RETURN jsonb_build_object('status','conflict','reason','stale_revision','currentRevision',v_document.current_revision);
  END IF;

  IF p_form_file IS NULL THEN RETURN '{"status":"conflict","reason":"form_outdated"}'; END IF;
  IF octet_length(p_form_file) NOT BETWEEN 1 AND 128000
     OR octet_length(p_body::text) > 800000
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  v_form := p_form_file::jsonb;
  IF v_form->>'formSchema' IS DISTINCT FROM 'ductura-declaration-form-v1'
     OR coalesce(v_form->>'formId','') !~ '^[a-z0-9][a-z0-9-]{0,63}$'
     OR coalesce(v_form->>'formVersion','') !~ '^[1-9][0-9]{0,9}$'
     OR (v_form->>'formVersion')::bigint > 2147483647
     OR NOT declaration.valid_text(v_form->>'text', 20000, true)
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF (p_body->'form') IS DISTINCT FROM jsonb_build_object('formId', v_form->'formId', 'formVersion',
      v_form->'formVersion', 'formSha256', encode(sha256(convert_to(p_form_file, 'UTF8')), 'hex'))
  THEN RETURN '{"status":"conflict","reason":"form_outdated"}'; END IF;

  IF jsonb_typeof(p_body->'confirm') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_body#>'{ownWork,confirmed}') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_help->'received') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_help->'entries') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_ai->'declaredTools') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_ai->'externalAttachmentIds') IS DISTINCT FROM 'array'
     OR v_ai->'use' IS NULL OR v_ai->'use' NOT IN ('null'::jsonb, '"used"'::jsonb, '"not_used"'::jsonb)
     OR jsonb_typeof(v_ai->'attachments') IS DISTINCT FROM 'array'
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF v_help IS DISTINCT FROM jsonb_build_object('received',v_help->'received','entries',v_help->'entries')
     OR v_ai IS DISTINCT FROM jsonb_build_object('use',v_ai->'use','declaredTools',v_ai->'declaredTools',
       'attachments',v_ai->'attachments','externalAttachmentIds',v_ai->'externalAttachmentIds')
     OR p_body IS DISTINCT FROM jsonb_build_object('baseVersion',v_version,'revision',v_document.current_revision,
       'form',p_body->'form','ownWork',jsonb_build_object('confirmed',p_body#>'{ownWork,confirmed}'),
       'humanHelp',v_help,'ai',v_ai,'confirm',p_body->'confirm')
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF jsonb_array_length(v_help->'entries') > 20 OR jsonb_array_length(v_ai->'declaredTools') > 20
     OR jsonb_array_length(v_ai->'externalAttachmentIds') > max_external_attachments
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ai->'attachments') e
       WHERE jsonb_typeof(e->'throughSeq') IS DISTINCT FROM 'number'
          OR coalesce(e->>'throughSeq','') !~ '^[1-9][0-9]{0,9}$'
          OR coalesce(e->>'conversationId','') !~ uuid_v4_pattern
          OR coalesce(e->>'messagesSha256','') !~ '^[0-9a-f]{64}$'
          OR e IS DISTINCT FROM jsonb_build_object('conversationId',e->>'conversationId',
            'throughSeq',e->'throughSeq','messagesSha256',e->>'messagesSha256'))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ai->'attachments') e
       GROUP BY e->>'conversationId' HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_ai->'externalAttachmentIds') e
       GROUP BY e HAVING coalesce(e,'') !~ uuid_v4_pattern OR count(*) > 1)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_help->'entries') e
       WHERE coalesce(e->>'kind','') NOT IN ('language','structure','sources','content','technical','other')
          OR jsonb_typeof(e->'text') IS DISTINCT FROM 'string'
          OR NOT declaration.valid_text(e->>'text', 2000, true)
          OR e IS DISTINCT FROM jsonb_build_object('kind',e->'kind','text',e->'text'))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ai->'declaredTools') e
       WHERE jsonb_typeof(e->'toolLabel') IS DISTINCT FROM 'string'
          OR jsonb_typeof(e->'purposeText') IS DISTINCT FROM 'string'
          OR jsonb_typeof(e->'phaseText') IS DISTINCT FROM 'string'
          OR NOT declaration.valid_text(e->>'toolLabel', 200, false)
          OR NOT declaration.valid_text(e->>'purposeText', 200, false)
          OR NOT declaration.valid_text(e->>'phaseText', 200, false)
          OR e IS DISTINCT FROM jsonb_build_object('toolLabel',e->'toolLabel','purposeText',e->'purposeText','phaseText',e->'phaseText'))
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) || '{"reason":"external_upload"}'::jsonb
    ORDER BY a.id), '[]'::jsonb), count(*) INTO v_selected, v_count
    FROM declaration.external_attachment a WHERE
    (a.institution_id, a.assignment_id, a.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
    AND (v_ai->'externalAttachmentIds') ? a.id::text;
  IF v_count <> jsonb_array_length(v_ai->'externalAttachmentIds')
  THEN RETURN '{"status":"not_found","reason":"invalid_attachment"}'; END IF;

  SELECT * INTO v_conversations FROM declaration.check_conversation_refs(
    v_actor.institution_id, p_assignment, v_actor.user_id, v_document.id, v_document.current_revision, v_ai->'attachments');
  IF v_conversations.has_unknown THEN RETURN '{"status":"invalid_input","reason":"invalid_attachment"}'; END IF;
  IF v_conversations.too_many THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF v_confirm AND v_conversations.stale <> '[]'::jsonb THEN
    RETURN jsonb_build_object('status','conflict','reason','attachment_stale','conversationIds',v_conversations.stale);
  END IF;
  IF v_conversations.missing <> '[]'::jsonb THEN
    RETURN jsonb_build_object('status','conflict','reason','mandatory_attachment_missing','conversationIds',v_conversations.missing);
  END IF;

  IF v_confirm THEN
    IF p_body#>'{ownWork,confirmed}' <> 'true'::jsonb OR coalesce(v_ai->>'use','') = ''
       OR (v_help->'received' = 'true'::jsonb) <> (jsonb_array_length(v_help->'entries') > 0)
       OR (v_ai->>'use' = 'not_used' AND jsonb_array_length(v_ai->'declaredTools') > 0)
    THEN RETURN '{"status":"conflict","reason":"incomplete"}'; END IF;
    SELECT s.payload_jcs::jsonb INTO v_previous FROM declaration.statement s
      WHERE (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
        AND s.payload_jcs IS NOT NULL
      ORDER BY s.version DESC LIMIT 1;
    v_payload := declaration.canonical_payload(jsonb_build_object('declarationSchema','ductura-declaration-v1',
      'declarationId',coalesce(v_previous->>'declarationId',v_id::text),
      'declarationVersion',coalesce((v_previous->>'declarationVersion')::bigint,0) + 1,
      'principalId',v_actor.user_id,
      'assignmentId',p_assignment,'assignmentVersion',v_assignment_version,'documentId',v_document.id,
      'revision',v_document.current_revision,'form',p_body->'form','ownWork','{"confirmed":true}'::jsonb,
      'humanHelp',jsonb_build_object('received',v_help->'received','entries',v_help->'entries'),
      'ai',jsonb_build_object('use',v_ai->'use','declaredTools',v_ai->'declaredTools','recorded','[]'::jsonb,
        'attachments',v_conversations.attachments || v_selected),
      'confirmedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  END IF;
  DELETE FROM declaration.statement s WHERE s.draft IS NOT NULL
    AND (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id);
  INSERT INTO declaration.statement (id,institution_id,assignment_id,assignment_version,project_id,principal_id,
    document_id,revision,version,form_text,draft,payload_jcs,content_sha256)
    VALUES (v_id,v_actor.institution_id,p_assignment,v_assignment_version,v_document.project_id,v_actor.user_id,
      v_document.id,v_document.current_revision,v_version + 1,v_form->>'text',
      CASE WHEN v_payload IS NULL THEN p_body END,
      v_payload, encode(sha256(convert_to(v_payload, 'UTF8')), 'hex'));
  IF v_confirm THEN
    INSERT INTO declaration.conversation_attachment
      (statement_id,institution_id,conversation_id,reason,through_seq,messages_sha256)
    SELECT v_id,v_actor.institution_id,(e->>'conversationId')::uuid,e->>'reason',
      (e->>'throughSeq')::integer,e->>'messagesSha256'
      FROM jsonb_array_elements(v_conversations.attachments) e;
  END IF;
  RETURN declaration.view_statement(v_actor.institution_id, p_assignment, v_actor.user_id,
    v_document.current_revision, v_assignment_version);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN '{"status":"invalid_input"}';
END $$;

DROP FUNCTION declaration.recorded_transfers(uuid, uuid, text, bigint);

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
