-- migrate:up
-- SRV-1212. Keep the SRV-1510 status for the mounted routes; reason and
-- its context implement declaration-v1 for the next route revision.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

-- M9.5 replaces this private source (declaration-v1 §2.5). One row per
-- eligible conversation in this scope. Reason and required_through_seq are
-- derived from evidence through the named immutable document revision.
-- message_hashes is the contiguous seq 1..N prefix, in ascending seq order.
-- New messages can extend it; required_through_seq is 0 for student_added.
CREATE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT NULL::uuid, NULL::text, NULL::integer, NULL::text[] WHERE false
$$;

CREATE FUNCTION declaration.check_conversation_refs(
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

REVOKE EXECUTE ON FUNCTION declaration.conversation_snapshot(uuid,uuid,uuid,text,bigint),
  declaration.check_conversation_refs(uuid,uuid,uuid,text,bigint,jsonb) FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION declaration.upload_attachment(p_assignment uuid, p_format text, p_content bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor record;
  v_document evidence.document%ROWTYPE;
  v_file declaration.external_attachment%ROWTYPE;
  v_count integer;
  v_total_bytes bigint;
  max_external_attachment_bytes constant integer := 2097152;
  max_external_attachments constant integer := 10;
  max_external_total_bytes constant integer := 10485760;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL THEN RETURN '{"status":"unauthorized"}'; END IF;
  PERFORM 1 FROM app.lock_student_assignment(p_assignment);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  SELECT * INTO v_document FROM declaration.student_document(v_actor.institution_id, p_assignment, v_actor.user_id);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  IF coalesce(p_format,'') NOT IN ('application/pdf','text/plain')
  THEN RETURN '{"status":"invalid_input","reason":"unsupported_media_type"}'; END IF;
  IF p_content IS NULL OR octet_length(p_content) NOT BETWEEN 1 AND max_external_attachment_bytes
     OR (p_format = 'application/pdf' AND substring(p_content FROM 1 FOR 5) <> convert_to('%PDF-', 'UTF8'))
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF p_format = 'text/plain' AND (substring(p_content FROM 1 FOR 3) = decode('efbbbf','hex')
      OR replace(replace(convert_from(p_content,'UTF8'),chr(10),''),chr(9),'') ~ U&'[\0001-\001F\007F-\009F]')
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  PERFORM declaration.lock_scope(v_actor.institution_id, p_assignment, v_actor.user_id);
  IF EXISTS (SELECT 1 FROM evidence.submission_request q WHERE (q.institution_id, q.assignment_id, q.principal_id)
    = (v_actor.institution_id, p_assignment, v_actor.user_id))
  THEN RETURN '{"status":"conflict","reason":"already_submitted"}'; END IF;
  SELECT a.* INTO v_file FROM declaration.external_attachment a
   WHERE (a.institution_id, a.assignment_id, a.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
     AND a.format = p_format AND a.content_sha256 = encode(sha256(p_content),'hex');
  IF NOT FOUND THEN
    SELECT count(*), coalesce(sum(octet_length(a.content)),0) INTO v_count,v_total_bytes
      FROM declaration.external_attachment a
      WHERE (a.institution_id, a.assignment_id, a.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id);
    IF v_count >= max_external_attachments THEN RETURN '{"status":"conflict","reason":"too_many_attachments"}'; END IF;
    IF v_total_bytes + octet_length(p_content) > max_external_total_bytes
    THEN RETURN '{"status":"conflict","reason":"attachments_too_large"}'; END IF;
    INSERT INTO declaration.external_attachment (institution_id,assignment_id,project_id,principal_id,format,content)
      VALUES (v_actor.institution_id,p_assignment,v_document.project_id,v_actor.user_id,p_format,p_content)
      RETURNING * INTO v_file;
  END IF;
  RETURN declaration.attachment_ref(v_file) || '{"status":"ok"}'::jsonb;
EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN
  RETURN '{"status":"invalid_input"}';
END $$;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
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
  v_count integer;
  v_version bigint;
  v_previous jsonb;
  v_id uuid := gen_random_uuid();
  v_payload text;
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
  IF v_document.current_revision = 0 OR (p_body->'revision') IS DISTINCT FROM to_jsonb(v_document.current_revision)
     OR (p_body->'baseVersion') IS DISTINCT FROM to_jsonb(v_version)
     OR EXISTS (SELECT 1 FROM evidence.submission_request q WHERE (q.institution_id, q.assignment_id, q.principal_id)
       = (v_actor.institution_id, p_assignment, v_actor.user_id))
  THEN RETURN '{"status":"conflict"}'; END IF;

  IF p_form_file IS NULL THEN RETURN '{"status":"conflict"}'; END IF;
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
  THEN RETURN '{"status":"conflict"}'; END IF;

  IF jsonb_typeof(p_body->'confirm') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_body#>'{ownWork,confirmed}') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_help->'received') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_help->'entries') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_ai->'declaredTools') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_ai->'externalAttachmentIds') IS DISTINCT FROM 'array'
     OR v_ai->'use' IS NULL OR v_ai->'use' NOT IN ('null'::jsonb, '"used"'::jsonb, '"not_used"'::jsonb)
     OR (v_ai->'attachments') IS DISTINCT FROM '[]'::jsonb
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF v_help IS DISTINCT FROM jsonb_build_object('received',v_help->'received','entries',v_help->'entries')
     OR v_ai IS DISTINCT FROM jsonb_build_object('use',v_ai->'use','declaredTools',v_ai->'declaredTools',
       'attachments','[]'::jsonb,'externalAttachmentIds',v_ai->'externalAttachmentIds')
     OR p_body IS DISTINCT FROM jsonb_build_object('baseVersion',v_version,'revision',v_document.current_revision,
       'form',p_body->'form','ownWork',jsonb_build_object('confirmed',p_body#>'{ownWork,confirmed}'),
       'humanHelp',v_help,'ai',v_ai,'confirm',p_body->'confirm')
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF jsonb_array_length(v_help->'entries') > 20 OR jsonb_array_length(v_ai->'declaredTools') > 20
     OR jsonb_array_length(v_ai->'externalAttachmentIds') > 10
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
  IF v_count <> jsonb_array_length(v_ai->'externalAttachmentIds') THEN RETURN '{"status":"not_found"}'; END IF;

  IF p_body->'confirm' = 'true'::jsonb THEN
    IF p_body#>'{ownWork,confirmed}' <> 'true'::jsonb OR coalesce(v_ai->>'use','') = ''
       OR (v_help->'received' = 'true'::jsonb) <> (jsonb_array_length(v_help->'entries') > 0)
       OR (v_ai->>'use' = 'not_used' AND jsonb_array_length(v_ai->'declaredTools') > 0)
    THEN RETURN '{"status":"conflict"}'; END IF;
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
        'attachments',v_selected),
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
  RETURN declaration.view_statement(v_actor.institution_id, p_assignment, v_actor.user_id,
    v_document.current_revision, v_assignment_version);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN '{"status":"invalid_input"}';
END $$;

CREATE OR REPLACE FUNCTION declaration.upload_attachment(p_assignment uuid, p_format text, p_content bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor record; v_document evidence.document%ROWTYPE; v_file declaration.external_attachment%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL THEN RETURN '{"status":"unauthorized"}'; END IF;
  PERFORM 1 FROM app.lock_student_assignment(p_assignment);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  SELECT * INTO v_document FROM declaration.student_document(v_actor.institution_id, p_assignment, v_actor.user_id);
  IF NOT FOUND THEN RETURN '{"status":"not_found"}'; END IF;
  IF coalesce(p_format,'') NOT IN ('application/pdf','text/plain') OR p_content IS NULL
     OR octet_length(p_content) NOT BETWEEN 1 AND 2097152
     OR (p_format = 'application/pdf' AND substring(p_content FROM 1 FOR 5) <> convert_to('%PDF-', 'UTF8'))
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  IF p_format = 'text/plain' AND (substring(p_content FROM 1 FOR 3) = decode('efbbbf','hex')
      OR replace(replace(convert_from(p_content,'UTF8'),chr(10),''),chr(9),'') ~ U&'[\0001-\001F\007F-\009F]')
  THEN RETURN '{"status":"invalid_input"}'; END IF;
  PERFORM declaration.lock_scope(v_actor.institution_id, p_assignment, v_actor.user_id);
  IF EXISTS (SELECT 1 FROM evidence.submission_request q WHERE (q.institution_id, q.assignment_id, q.principal_id)
    = (v_actor.institution_id, p_assignment, v_actor.user_id)) THEN RETURN '{"status":"conflict"}'; END IF;
  SELECT a.* INTO v_file FROM declaration.external_attachment a
   WHERE (a.institution_id, a.assignment_id, a.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
     AND a.format = p_format AND a.content_sha256 = encode(sha256(p_content),'hex');
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM declaration.external_attachment a
      WHERE (a.institution_id, a.assignment_id, a.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
      HAVING count(*) >= 10 OR sum(octet_length(a.content)) + octet_length(p_content) > 10485760)
    THEN RETURN '{"status":"conflict"}'; END IF;
    INSERT INTO declaration.external_attachment (institution_id,assignment_id,project_id,principal_id,format,content)
      VALUES (v_actor.institution_id,p_assignment,v_document.project_id,v_actor.user_id,p_format,p_content)
      RETURNING * INTO v_file;
  END IF;
  RETURN declaration.attachment_ref(v_file) || '{"status":"ok"}'::jsonb;
EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN
  RETURN '{"status":"invalid_input"}';
END $$;

DROP FUNCTION declaration.check_conversation_refs(uuid,uuid,uuid,text,bigint,jsonb);
DROP FUNCTION declaration.conversation_snapshot(uuid,uuid,uuid,text,bigint);
