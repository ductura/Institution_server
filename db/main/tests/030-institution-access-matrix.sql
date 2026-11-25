-- Access matrix of the institution module (B-7 parts 1 and 2;
-- docs/ARCHITECTURE.md 3 and 7; plan of attack on issue #153, items 1 to 8,
-- 10, 13 and 19). Synthetic fixtures only (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
-- Denials are told apart by their message below, so the language is fixed.
SET LOCAL lc_messages TO 'C';

SELECT plan(5872);

SELECT ok(c.relrowsecurity AND c.relforcerowsecurity
    AND has_table_privilege('ductus_app', c.oid, 'SELECT')
    AND has_table_privilege('ductus_problem_report_reader', c.oid, 'SELECT')
    AND NOT has_database_privilege('ductus_problem_report_reader', current_database(), 'CONNECT')
    AND NOT has_table_privilege('public', c.oid, 'SELECT')
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin
        AND r.rolname NOT IN ('ductus_identity', 'ductus_app', 'ductus_problem_report_reader')
        AND has_any_column_privilege(r.oid, c.oid, 'SELECT'))
    AND NOT has_table_privilege('ductus_app', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('ductus_problem_report_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'problem reports have forced RLS and only app and operations read grants outside the owner')
  FROM pg_class c WHERE c.oid = 'identity.problem_report'::regclass;

SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole,
  'maintenance_window has forced RLS and the operations owner')
  FROM pg_class c WHERE c.oid = 'identity.maintenance_window'::regclass;
SELECT results_eq($$ SELECT policyname::text COLLATE "default", cmd::text, roles = ARRAY['ductus_identity'::name]
  FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'maintenance_window' ORDER BY policyname $$,
  $$ VALUES ('maintenance_read'::text, 'SELECT'::text, true), ('maintenance_record', 'INSERT', true) $$,
  'maintenance_window lets the operator read and append');
SELECT bag_eq($$ SELECT r.rolname::text FROM pg_roles r
  WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin
    AND has_function_privilege(r.oid, 'identity.public_maintenance_windows()', 'EXECUTE')
  UNION ALL SELECT 'public' WHERE has_function_privilege('public', 'identity.public_maintenance_windows()', 'EXECUTE') $$,
  ARRAY['ductus_identity', 'ductus_app'], 'only the app and owner execute the maintenance projection');

SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT has_table_privilege('ductus_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND ARRAY(SELECT p.policyname::text FROM pg_policies p
      WHERE p.schemaname = 'declaration' AND p.tablename = c.relname
        AND p.roles = ARRAY['ductus_evidence'::name] AND p.cmd = 'ALL') = ARRAY[t.policy],
  t.relation || ': forced RLS and only the evidence owner has access')
  FROM (VALUES ('declaration.statement', 'statement_owner'),
               ('declaration.external_attachment', 'attachment_owner'),
               ('declaration.conversation_attachment', 'conversation_attachment_owner'),
               -- SRV-IZJAVA-PITANJE: the student's answer to the teacher's question.
               ('declaration.question_answer', 'question_answer_owner')) t(relation, policy)
  LEFT JOIN pg_class c ON c.oid = to_regclass(t.relation);
SELECT ok(p.prosecdef AND 'search_path=""' = ANY(p.proconfig)
    AND has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE'),
  f.signature || ': definer RPC with an empty path, only for the application')
  FROM (VALUES ('declaration.read_statement(uuid)'), ('declaration.save_statement(uuid,jsonb,text)'),
               ('declaration.upload_attachment(uuid,text,bytea)'),
               ('declaration.save_statement_answer(uuid,jsonb,text,jsonb)')) f(signature)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature);
SELECT ok(NOT p.prosecdef AND 'search_path=""' = ANY(p.proconfig)
    AND NOT has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE'),
  f.signature || ': private to the evidence owner')
  FROM (VALUES ('declaration.conversation_snapshot(uuid,uuid,uuid,text,bigint)'),
               ('declaration.check_conversation_refs(uuid,uuid,uuid,text,bigint,jsonb)'),
               ('declaration.is_fresh(declaration.statement,text,bigint,integer)')) f(signature)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature);
-- SRV-1207, ai-tools-v1 "Matrica pristupa": the tool setting, the steps, the
-- loop reservation and the setting trail are reached only by their owner; the
-- application only through the definer RPCs, the worker and PUBLIC not at all.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT has_table_privilege('ductus_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('ductus_worker', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND ARRAY(SELECT p.policyname::text FROM pg_policies p
      WHERE p.schemaname = t.nsp AND p.tablename = c.relname
        AND p.roles = ARRAY['ductus_identity'::name] AND p.cmd = 'ALL') = ARRAY[t.policy]
    AND (SELECT count(*) FROM pg_policies p WHERE p.schemaname = t.nsp AND p.tablename = c.relname) = 1,
  t.nsp || '.' || t.rel || ': forced RLS and only the identity owner has access')
  FROM (VALUES ('assistant', 'assignment_tool_setting', 'assignment_tool_setting_owner'),
               ('assistant', 'tool_step', 'tool_step_owner'),
               ('assistant', 'tool_loop_reservation', 'tool_loop_reservation_owner'),
               ('audit', 'assistant_tool_setting_event', 'assistant_tool_setting_event_owner')) t(nsp, rel, policy)
  LEFT JOIN pg_class c ON c.oid = to_regclass(t.nsp || '.' || t.rel);
SELECT ok(p.prosecdef AND 'search_path=""' = ANY(p.proconfig) AND p.proowner = 'ductus_identity'::regrole
    AND has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE'),
  f.signature || ': definer RPC with an empty path, only for the application')
  FROM (VALUES ('assistant.begin_request(uuid,uuid,uuid,integer,text,text,text,text,text,text[])'),
               ('assistant.set_assignment_tools(uuid,integer,text[])'),
               ('assistant.read_assignment_tools(uuid)'),
               ('assistant.begin_tool_step(uuid,integer,text,text,text,boolean,text[])'),
               ('assistant.finish_tool_step(uuid,integer,text,text,integer,boolean)')) f(signature)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature);
SELECT ok('search_path=""' = ANY(p.proconfig)
    AND NOT has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE'),
  f.signature || ': private to the identity owner')
  FROM (VALUES ('assistant.code_tools()'), ('assistant.tool_step_max()'), ('assistant.is_tool_list(text[])'),
               ('assistant.intersect_tools(text[],text[])'), ('assistant.latest_tools(uuid)'),
               ('assistant.allowed_tools_now(assistant.request,text[])'),
               ('assistant.guard_tool_step_change()'), ('assistant.guard_tool_setting_version()'),
               ('assistant.check_tool_setting_event()'), ('assistant.check_tool_setting_has_event()')) f(signature)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature);
-- SRV-1211, declaration-v1 section 8: the catalogue of the schema. A table,
-- function, grant or trigger added later changes one of these lists.
SELECT bag_eq(
  $$ SELECT c.relname::text FROM pg_class c
     WHERE c.relnamespace = 'declaration'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') $$,
  ARRAY['statement', 'external_attachment', 'conversation_attachment', 'question_answer'],
  'the declaration schema holds exactly its three tables'
);
SELECT bag_eq(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'declaration'::regnamespace $$,
  ARRAY['declaration.lock_scope(uuid,uuid,uuid)', 'declaration.pin_request()',
        'declaration.student_document(uuid,uuid,uuid)',
        'declaration.attachment_ref(declaration.external_attachment)',
        'declaration.view_statement(uuid,uuid,uuid,bigint,integer)', 'declaration.read_statement(uuid)',
        'declaration.canonical_payload(jsonb)', 'declaration.valid_text(text,integer,boolean)',
        'declaration.save_statement(uuid,jsonb,text)', 'declaration.upload_attachment(uuid,text,bytea)',
        'declaration.payload_conversations(text)', 'declaration.check_conversation_attachment()',
        'declaration.check_statement_attachments()',
        'declaration.conversation_snapshot(uuid,uuid,uuid,text,bigint)',
        'declaration.check_conversation_refs(uuid,uuid,uuid,text,bigint,jsonb)',
        'declaration.is_fresh(declaration.statement,text,bigint,integer)',
        'declaration.bound_declaration_of(uuid,uuid,uuid)', 'declaration.submission_gate(text,bigint)',
        'declaration.require_pinned_submission()',
        'declaration.save_statement_answer(uuid,jsonb,text,jsonb)',
        'declaration.answer_ref(declaration.question_answer)', 'declaration.bound_answer_of(uuid,uuid,uuid)',
        'declaration.reject_answer_change()', 'declaration.delete_draft_answer()'],
  'the declaration schema holds exactly these functions'
);
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || p.oid::regprocedure::text
     FROM pg_proc p
     CROSS JOIN (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
                 UNION ALL SELECT 'public') r
     WHERE p.pronamespace = 'declaration'::regnamespace AND p.proowner <> to_regrole(r.rolname)
       AND has_function_privilege(r.rolname, p.oid, 'EXECUTE') $$,
  ARRAY['ductus_app declaration.read_statement(uuid)', 'ductus_app declaration.save_statement(uuid,jsonb,text)',
        'ductus_app declaration.upload_attachment(uuid,text,bytea)',
        'ductus_app declaration.submission_gate(text,bigint)',
        'ductus_app declaration.save_statement_answer(uuid,jsonb,text,jsonb)',
        'ductus_identity declaration.bound_declaration_of(uuid,uuid,uuid)',
        'ductus_identity declaration.bound_answer_of(uuid,uuid,uuid)'],
  'the web role executes only the student RPCs and the submission gate, and identity only the teacher''s bound-declaration and bound-answer helpers'
);
SELECT is_empty(
  $$ SELECT r.rolname, p.privilege, c.relname
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
             AND rolname <> 'ductus_evidence'
           UNION ALL SELECT 'public') r
     CROSS JOIN pg_class c
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(privilege)
     WHERE c.relnamespace = 'declaration'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
       AND (has_table_privilege(r.rolname, c.oid, p.privilege)
            OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                AND has_any_column_privilege(r.rolname, c.oid, p.privilege))) $$,
  'no role but the evidence owner holds any privilege on a declaration table'
);
SELECT bag_eq(
  $$ SELECT t.tgrelid::regclass::text || ' ' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'declaration'::regnamespace AND NOT t.tgisinternal $$,
  ARRAY['declaration.statement statement_no_update', 'declaration.statement statement_immutable',
        'declaration.statement statement_no_truncate', 'declaration.statement statement_attachments_complete',
        'declaration.external_attachment attachment_immutable', 'declaration.external_attachment attachment_no_truncate',
        'declaration.conversation_attachment conversation_attachment_immutable',
        'declaration.conversation_attachment conversation_attachment_no_truncate',
        'declaration.conversation_attachment conversation_attachment_in_payload',
        'declaration.statement statement_draft_answer',
        'declaration.question_answer question_answer_immutable',
        'declaration.question_answer question_answer_no_truncate'],
  'the declaration tables carry exactly their immutability and payload triggers'
);
SELECT ok(NOT has_schema_privilege('ductus_worker', 'declaration', 'USAGE')
    AND NOT has_column_privilege('ductus_worker', 'evidence.submission_request', 'declaration_version_id', 'UPDATE')
    AND NOT has_column_privilege('ductus_worker', 'evidence.submission_request', 'declaration_sha256', 'UPDATE'),
  'the worker cannot reach the declaration schema nor change the pinned id and hash');

-- 1. The catalogue. A table, policy, grant or function that is added later
-- changes one of these lists, so it cannot arrive without a row here.
SELECT bag_eq(
  $$ SELECT c.relname::text FROM pg_class c
     WHERE c.relnamespace = 'institution'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') $$,
  ARRAY['institution_settings', 'institution_role', 'course', 'course_enrollment_code', 'course_member', 'enrollment_attempt',
        'assignment', 'assignment_version', 'notice_acknowledgment', 'faculty_work_rule', 'mentorship', 'notification',
        'course_holder', 'course_assistant', 'seminar_group', 'seminar_group_teacher', 'seminar_group_member',
        'course_editor', 'team_substitution', 'work_grant', 'mentorship_request', 'faculty_rule_version',
        'work_language_override', 'work_accommodation', 'notice_read', 'work_source', 'source_note', 'work_attachment', 'source_proof',
        'deadline_extension', 'late_submission_exception', 'merlin_package', 'merlin_package_download', 'consultation_slot', 'work_milestone',
        'work_milestone_deadline', 'work_milestone_progress', 'work_milestone_event', 'milestone_template_version', 'assignment_rubric_version', 'work_template_version', 'assignment_template_pin', 'mentor_note', 'submission_withdrawal_setting',
        'work_interview', 'work_interview_question', 'work_interview_explanation', 'work_interview_note', 'origin_threshold',
        'course_required_source', 'source_proof_request', 'work_literature_seen',
        'thesis_form', 'thesis_setting', 'work_thesis_form_event', 'work_mentor_consent_event', 'work_thesis_stage_event',
        'mentorship_opening',
        -- SRV-V19-DNEVNIK-BAZA: the practice journal; cells in 247-practice-journal.sql.
        'practice_placement', 'practice_entry', 'practice_signoff',
        -- SRV-V19-GRUPA-BAZA: teams on an assignment; cells in 248-work-team.sql.
        'assignment_team_setting', 'work_team', 'work_team_member_event',
        -- SRV-V19-RECENZIJA-BAZA: anonymous peer review; cells in 249-peer-review.sql.
        'peer_review_round', 'peer_review_allocation', 'peer_review', 'peer_review_withdrawal',
        -- SRV-V18-UPITNIK-BAZA: questionnaires without a person on the sheet; cells in 247-questionnaire.sql.
        'questionnaire', 'questionnaire_question', 'questionnaire_response', 'questionnaire_answer',
        'questionnaire_participation',
        -- SRV-V18-KODIRANJE-BAZA: the student's own coding material; cells in 248-qualitative-coding.sql.
        'qual_material', 'qual_code', 'qual_segment',
        -- SRV-ASIST-PREKIDAC: the assistant switch per course; cells in 254-assistant-course-switch.sql.
        'course_assistant_setting',
        -- SRV-ADMIN-2 (OA-10): the roster import; cells per actor in 235-roster-import.sql.
        'roster_import', 'roster_import_entry'],
  'the institution schema holds exactly the tables of this matrix'
);
SELECT is_empty(
  $$ SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'institution'::regnamespace AND c.relkind = 'r'
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole) $$,
  'every institution table has ENABLE and FORCE ROW LEVEL SECURITY and belongs to ductus_identity'
);
-- The privilege lists below name the group roles. has_*_privilege counts what a
-- role inherits, so a login that is a member of ductus_app (db/local/app-login.sql)
-- would appear with ductus_app's rows; they are left out here with NOT rolcanlogin,
-- and 010 checks every login (it may do nothing ductus_app may not, and holds no
-- grant of its own).
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || p.privilege || ' ' || c.relname
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_identity'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN pg_class c
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE c.relnamespace = 'institution'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
       AND (has_table_privilege(r.rolname, c.oid, p.privilege)
            OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                AND has_any_column_privilege(r.rolname, c.oid, p.privilege))) $$,
  ARRAY[
    'ductus_app SELECT institution_settings',
    'ductus_app SELECT institution_role',
    'ductus_app SELECT course',
    'ductus_app SELECT course_enrollment_code',
    'ductus_app SELECT course_member',
    'ductus_app SELECT assignment',
    'ductus_app SELECT assignment_version',
    'ductus_app SELECT notice_acknowledgment',
    'ductus_app SELECT mentorship',
    'ductus_app SELECT mentor_note',
    'ductus_app SELECT course_holder',
    'ductus_app SELECT seminar_group',
    'ductus_app SELECT seminar_group_teacher',
    'ductus_app SELECT seminar_group_member',
    'ductus_app SELECT course_editor',
    'ductus_app SELECT team_substitution',
    'ductus_app SELECT work_grant',
    'ductus_app SELECT mentorship_request',
    'ductus_app SELECT faculty_rule_version',
    'ductus_app SELECT work_language_override',
    'ductus_app SELECT work_accommodation',
    'ductus_app SELECT notice_read'
  ],
  'besides the owner only ductus_app holds a privilege on an institution table, and only SELECT'
);
SELECT bag_eq(
  $$ SELECT a.attname::text FROM pg_attribute a
     WHERE a.attrelid = 'institution.course_enrollment_code'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT has_column_privilege('ductus_app', a.attrelid, a.attnum, 'SELECT') $$,
  ARRAY['code_hash'],
  'ductus_app may read every column of an enrolment code except its hash'
);
SELECT bag_eq(
  $$ SELECT tablename || ': ' || policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',')
     FROM pg_policies WHERE schemaname = 'institution' $$,
  ARRAY[
    'institution_settings: institution_settings_owner ALL to ductus_identity',
    'institution_settings: institution_settings_read SELECT to ductus_app',
    'institution_role: institution_role_owner ALL to ductus_identity',
    'institution_role: institution_role_read SELECT to ductus_app',
    'course: course_owner ALL to ductus_identity',
    'course: course_read SELECT to ductus_app',
    'course_enrollment_code: course_enrollment_code_owner ALL to ductus_identity',
    'course_enrollment_code: course_enrollment_code_read SELECT to ductus_app',
    'course_member: course_member_owner ALL to ductus_identity',
    'course_member: course_member_read SELECT to ductus_app',
    'enrollment_attempt: enrollment_attempt_owner ALL to ductus_identity',
    'assignment: assignment_owner ALL to ductus_identity',
    'assignment: assignment_read SELECT to ductus_app',
    'assignment_version: assignment_version_owner ALL to ductus_identity',
    'assignment_version: assignment_version_read SELECT to ductus_app',
    'notice_acknowledgment: notice_acknowledgment_owner ALL to ductus_identity',
    'notice_acknowledgment: notice_acknowledgment_read SELECT to ductus_app',
    'faculty_work_rule: faculty_work_rule_owner ALL to ductus_identity',
    'mentorship: mentorship_owner ALL to ductus_identity',
    'mentorship: mentorship_read SELECT to ductus_app',
    'mentor_note: mentor_note_owner ALL to ductus_identity',
    'mentor_note: mentor_note_read SELECT to ductus_app',
    'notification: notification_owner ALL to ductus_identity',
    'course_holder: course_holder_owner ALL to ductus_identity',
    'course_holder: course_holder_read SELECT to ductus_app',
    'course_assistant: course_assistant_owner ALL to ductus_identity',
    'seminar_group: seminar_group_owner ALL to ductus_identity',
    'seminar_group: seminar_group_read SELECT to ductus_app',
    'seminar_group_teacher: seminar_group_teacher_owner ALL to ductus_identity',
    'seminar_group_teacher: seminar_group_teacher_read SELECT to ductus_app',
    'seminar_group_member: seminar_group_member_owner ALL to ductus_identity',
    'seminar_group_member: seminar_group_member_read SELECT to ductus_app',
    'course_editor: course_editor_owner ALL to ductus_identity',
    'course_editor: course_editor_read SELECT to ductus_app',
    'team_substitution: team_substitution_owner ALL to ductus_identity',
    'team_substitution: team_substitution_read SELECT to ductus_app',
    'work_grant: work_grant_owner ALL to ductus_identity',
    'work_grant: work_grant_read SELECT to ductus_app',
    'mentorship_request: mentorship_request_owner ALL to ductus_identity',
    'mentorship_request: mentorship_request_read SELECT to ductus_app',
    'faculty_rule_version: faculty_rule_version_owner ALL to ductus_identity',
    'faculty_rule_version: faculty_rule_version_read SELECT to ductus_app',
    'origin_threshold: origin_threshold_owner ALL to ductus_identity',
    'work_language_override: work_language_override_owner ALL to ductus_identity',
    'work_language_override: work_language_override_read SELECT to ductus_app',
    'work_accommodation: work_accommodation_owner ALL to ductus_identity',
    'work_accommodation: work_accommodation_read SELECT to ductus_app',
    'notice_read: notice_read_owner ALL to ductus_identity',
    'notice_read: notice_read_read SELECT to ductus_app',
    'work_source: work_source_owner ALL to ductus_identity',
    'course_required_source: course_required_source_owner ALL to ductus_identity',
    'source_proof_request: source_proof_request_owner ALL to ductus_identity',
    'work_literature_seen: work_literature_seen_owner ALL to ductus_identity',
    'source_note: source_note_owner ALL to ductus_identity',
    'work_attachment: work_attachment_owner ALL to ductus_identity',
    'source_proof: source_proof_owner ALL to ductus_identity',
    'deadline_extension: deadline_extension_owner ALL to ductus_identity',
    'late_submission_exception: late_submission_exception_owner ALL to ductus_identity',
    'merlin_package: merlin_package_owner ALL to ductus_identity',
    'merlin_package_download: merlin_package_download_owner ALL to ductus_identity',
    'consultation_slot: consultation_slot_owner ALL to ductus_identity',
    'work_milestone: work_milestone_owner ALL to ductus_identity',
    'work_milestone_deadline: work_milestone_deadline_owner ALL to ductus_identity',
    'work_milestone_progress: work_milestone_progress_owner ALL to ductus_identity',
    'work_milestone_event: work_milestone_event_owner ALL to ductus_identity',
    'milestone_template_version: milestone_template_version_owner ALL to ductus_identity',
    'assignment_rubric_version: assignment_rubric_version_owner ALL to ductus_identity',
    'work_template_version: work_template_version_owner ALL to ductus_identity',
    'assignment_template_pin: assignment_template_pin_owner ALL to ductus_identity',
    'submission_withdrawal_setting: submission_withdrawal_setting_owner ALL to ductus_identity',
    'work_interview: work_interview_owner ALL to ductus_identity',
    'work_interview_question: work_interview_question_owner ALL to ductus_identity',
    'work_interview_explanation: work_interview_explanation_owner ALL to ductus_identity',
    'work_interview_note: work_interview_note_owner ALL to ductus_identity',
    'thesis_form: thesis_form_owner ALL to ductus_identity',
    'thesis_setting: thesis_setting_owner ALL to ductus_identity',
    'work_thesis_form_event: work_thesis_form_event_owner ALL to ductus_identity',
    'work_mentor_consent_event: work_mentor_consent_event_owner ALL to ductus_identity',
    'work_thesis_stage_event: work_thesis_stage_event_owner ALL to ductus_identity',
    'mentorship_opening: mentorship_opening_owner ALL to ductus_identity',
    'practice_placement: practice_placement_owner ALL to ductus_identity',
    'practice_entry: practice_entry_owner ALL to ductus_identity',
    'practice_signoff: practice_signoff_owner ALL to ductus_identity',
    'assignment_team_setting: assignment_team_setting_owner ALL to ductus_identity',
    'work_team: work_team_owner ALL to ductus_identity',
    'work_team_member_event: work_team_member_event_owner ALL to ductus_identity',
    'peer_review_round: peer_review_round_owner ALL to ductus_identity',
    'peer_review_allocation: peer_review_allocation_owner ALL to ductus_identity',
    'peer_review: peer_review_owner ALL to ductus_identity',
    'peer_review_withdrawal: peer_review_withdrawal_owner ALL to ductus_identity',
    'questionnaire: questionnaire_owner ALL to ductus_identity',
    'questionnaire_question: questionnaire_question_owner ALL to ductus_identity',
    'questionnaire_response: questionnaire_response_owner ALL to ductus_identity',
    'questionnaire_answer: questionnaire_answer_owner ALL to ductus_identity',
    'questionnaire_participation: questionnaire_participation_owner ALL to ductus_identity',
    'qual_material: qual_material_owner ALL to ductus_identity',
    'qual_code: qual_code_owner ALL to ductus_identity',
    'qual_segment: qual_segment_owner ALL to ductus_identity',
    'course_assistant_setting: course_assistant_setting_owner ALL to ductus_identity',
    'roster_import: roster_import_owner ALL to ductus_identity',
    'roster_import_entry: roster_import_entry_owner ALL to ductus_identity'
  ],
  'policies: the owner on every table and ductus_app for SELECT on its readable tables'
);
-- A version is immutable by its triggers, one of a mentorship's assignment
-- stays within the faculty's rule, an administrator comes and goes only
-- through the operator procedure (DAN-525), and a grant is bound to its rows
-- on insert (DAN-379); losing one must change this list.
SELECT bag_eq(
  $$ SELECT c.relname || ': ' || t.tgname || ' ' || t.tgtype::text || ' ' || t.tgenabled::text
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'institution'::regnamespace AND NOT t.tgisinternal $$,
  ARRAY['assignment: assignment_practice_immutable 19 O', 'assignment: assignment_setup_immutable 19 O',
        'assignment: assignment_config_pin 23 O',
        'assignment_version: assignment_version_immutable 27 O', 'assignment_version: assignment_version_no_truncate 34 O',
        'assignment_version: assignment_version_mentorship_rule 7 O', 'assignment_version: assignment_version_notify 5 O',
        'assignment_version: assignment_version_institution_fill 7 O',
        'assignment_version: assignment_version_work_language 7 O',
        'assignment_version: assignment_version_work_language_offered 7 O',
        'assignment_version: assignment_version_default_language 7 O',
        'assignment_version: assignment_version_purpose_catalog 7 O',
        'course_enrollment_code: course_enrollment_code_institution_fill 7 O',
        'work_milestone_event: work_milestone_event_append_only 27 O', 'work_milestone_event: work_milestone_event_no_truncate 34 O',
        'thesis_form: thesis_form_append_only 27 O', 'thesis_form: thesis_form_no_truncate 34 O',
        'thesis_setting: thesis_setting_append_only 27 O', 'thesis_setting: thesis_setting_no_truncate 34 O',
        'work_thesis_form_event: work_thesis_form_event_append_only 27 O', 'work_thesis_form_event: work_thesis_form_event_no_truncate 34 O',
        'work_mentor_consent_event: work_mentor_consent_event_append_only 27 O', 'work_mentor_consent_event: work_mentor_consent_event_no_truncate 34 O',
        'work_thesis_stage_event: work_thesis_stage_event_append_only 27 O', 'work_thesis_stage_event: work_thesis_stage_event_no_truncate 34 O',
        'assignment_rubric_version: assignment_rubric_version_immutable 27 O', 'assignment_rubric_version: assignment_rubric_version_no_truncate 34 O',
        'work_template_version: work_template_version_immutable 27 O', 'work_template_version: work_template_version_no_truncate 34 O',
        'assignment_template_pin: assignment_template_pin_frozen 19 O',
        'milestone_template_version: milestone_template_version_immutable 27 O', 'milestone_template_version: milestone_template_version_no_truncate 34 O',
        'assignment: assignment_apply_milestone_template 5 O',
        'faculty_rule_version: faculty_rule_version_immutable 27 O', 'faculty_rule_version: faculty_rule_version_no_truncate 34 O',
        'faculty_rule_version: faculty_rule_version_has_event 5 O',
        'institution_role: institution_role_admin_appointed 5 O', 'institution_role: institution_role_admin_reappointed 17 O',
        'institution_role: institution_role_keeps_admin 17 O',
        'notice_acknowledgment: notice_acknowledgment_fingerprint_immutable 19 O',
        'notice_acknowledgment: notice_acknowledgment_binding_fill 7 O',
        'notice_acknowledgment: notice_acknowledgment_binding_immutable 19 O',
        'work_grant: work_grant_binding_fill 23 O',
        'work_language_override: work_language_override_offered 23 O',
        'notice_read: notice_read_immutable 27 O', 'notice_read: notice_read_no_truncate 34 O',
        'work_attachment: work_attachment_immutable 27 O', 'work_attachment: work_attachment_no_truncate 34 O',
        'deadline_extension: deadline_extension_immutable 27 O', 'deadline_extension: deadline_extension_no_truncate 34 O',
        'late_submission_exception: late_submission_exception_immutable 27 O', 'late_submission_exception: late_submission_exception_no_truncate 34 O',
        'merlin_package: merlin_package_guard 27 O', 'merlin_package: merlin_package_no_truncate 34 O',
        'merlin_package: merlin_package_practice 7 O',
        'merlin_package_download: merlin_package_download_immutable 27 O',
        'merlin_package_download: merlin_package_download_no_truncate 34 O',
        'submission_withdrawal_setting: submission_withdrawal_setting_immutable 27 O',
        'submission_withdrawal_setting: submission_withdrawal_setting_no_truncate 34 O',
        'mentorship_opening: mentorship_opening_immutable 27 O', 'mentorship_opening: mentorship_opening_no_truncate 34 O',
        'practice_placement: practice_placement_append_only 27 O', 'practice_placement: practice_placement_no_truncate 34 O',
        'practice_entry: practice_entry_append_only 27 O', 'practice_entry: practice_entry_no_truncate 34 O',
        'practice_signoff: practice_signoff_append_only 27 O', 'practice_signoff: practice_signoff_no_truncate 34 O',
        'assignment_team_setting: assignment_team_setting_append_only 27 O', 'assignment_team_setting: assignment_team_setting_no_truncate 34 O',
        'work_team: work_team_append_only 27 O', 'work_team: work_team_no_truncate 34 O',
        'work_team_member_event: work_team_member_event_append_only 27 O', 'work_team_member_event: work_team_member_event_no_truncate 34 O',
        'peer_review_round: peer_review_round_append_only 27 O', 'peer_review_round: peer_review_round_no_truncate 34 O',
        'peer_review_allocation: peer_review_allocation_append_only 27 O', 'peer_review_allocation: peer_review_allocation_no_truncate 34 O',
        'peer_review: peer_review_append_only 27 O', 'peer_review: peer_review_no_truncate 34 O',
        'peer_review_withdrawal: peer_review_withdrawal_append_only 27 O', 'peer_review_withdrawal: peer_review_withdrawal_no_truncate 34 O',
        'questionnaire: questionnaire_guard 27 O', 'questionnaire: questionnaire_no_truncate 34 O',
        'questionnaire_question: questionnaire_question_guard 31 O', 'questionnaire_question: questionnaire_question_no_truncate 34 O',
        'questionnaire_response: questionnaire_response_append_only 27 O', 'questionnaire_response: questionnaire_response_no_truncate 34 O',
        'questionnaire_answer: questionnaire_answer_append_only 27 O', 'questionnaire_answer: questionnaire_answer_no_truncate 34 O',
        'questionnaire_participation: questionnaire_participation_append_only 27 O', 'questionnaire_participation: questionnaire_participation_no_truncate 34 O',
        'qual_material: qual_material_fixed 19 O', 'qual_material: qual_material_no_truncate 34 O',
        'qual_code: qual_code_guard 19 O', 'qual_code: qual_code_no_truncate 34 O',
        'qual_segment: qual_segment_fixed 19 O', 'qual_segment: qual_segment_no_truncate 34 O',
        'roster_import: roster_import_fixed 27 O', 'roster_import: roster_import_no_truncate 34 O',
        'roster_import_entry: roster_import_entry_fixed 27 O', 'roster_import_entry: roster_import_entry_no_truncate 34 O'],
  'triggers: immutable versions, fingerprints and bindings, the bindings derived on insert, mentorship validation, the inherited purpose catalogue, transactional notification, the institution of the parent and the operator''s administrators, all enabled'
);
SELECT bag_eq(
  $$ SELECT rolname::text FROM pg_roles
     WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND has_schema_privilege(rolname, 'institution', 'USAGE')
     UNION ALL SELECT 'public' WHERE has_schema_privilege('public', 'institution', 'USAGE') $$,
  ARRAY['ductus_app', 'ductus_identity', 'ductus_migrator'],
  'only ductus_app, the owner role and the migrator can use the institution schema'
);
SELECT bag_eq(
  $$ SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
            || CASE WHEN p.prosecdef THEN ' definer' ELSE '' END
            || CASE WHEN has_function_privilege('ductus_app', p.oid, 'EXECUTE') THEN ' app' ELSE '' END
     FROM pg_proc p WHERE p.pronamespace = 'institution'::regnamespace $$,
  ARRAY[
    'is_plain_label(p_text text)',
    'require_actor(OUT user_id uuid, OUT institution_id uuid)',
    'actor_has_role(p_role text) definer app',
    'actor_course_role(p_course_id uuid) definer app',
    'confirm_teacher_role(p_candidate_id uuid) definer app',
    'list_teacher_candidates() definer app',
    'create_course(p_name text, p_academic_year text, p_ai_policy text) definer app',
    'create_enrollment_code(p_course_id uuid, p_valid_until timestamp with time zone) definer app',
    'revoke_enrollment_code(p_course_id uuid) definer app',
    'enroll_with_code(p_code text, OUT outcome text, OUT enrolled_course_id uuid) definer app',
    'remove_student(p_course_id uuid, p_student_id uuid) definer app',
    'allow_student_return(p_course_id uuid, p_student_id uuid) definer app',
    'revoke_teacher_role(p_teacher_id uuid) definer app',
    'teachers_without_affiliation() definer app',
    'institution_overview() definer app',
    'teacher_roles() definer app',
    'institution_courses(p_academic_year text) definer app',
    'institution_academic_years() definer app',
    'ai_policy_rank(p_ai_policy text)',
    'is_assignment_content(p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean)',
    'is_assignment_content(p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_purpose_catalog_version integer)',
    'purpose_catalog_keys(p_version integer)',
    'refuse_change()',
    'actor_assignment_role(p_assignment_id uuid) definer app',
    'actor_course_ids(p_roles text[]) definer app',
    'actor_assignment_ids(p_roles text[]) definer app',
    'is_word_range(p_word_min integer, p_word_max integer)',
    'create_assignment(p_course_id uuid, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_word_min integer, p_word_max integer) definer app',
    'create_assignment(p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_word_min integer, p_word_max integer) definer app',
    'create_assignment(p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_word_min integer, p_word_max integer, p_purpose_catalog_version integer) definer app',
    'create_assignment(p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean) definer app',
    'create_assignment(p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean, p_external_tools_allowed boolean, p_ai_summary_only boolean) definer app',
    'assignment_grade_state(p_assignment_id uuid) app',
    'refuse_assignment_practice_change()',
    'refuse_assignment_setup_change()',
    'pin_assignment_config() definer',
    'refuse_practice_merlin_package()',
    'publish_assignment_version(p_assignment_id uuid, p_expected_version integer, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean, p_word_min integer, p_word_max integer) definer app',
    'acknowledge_notice(p_assignment_id uuid, p_version_no integer, p_template_version integer) definer app',
    'notice_fingerprint(p_template_version integer, p_title text, p_instructions text, p_work_type text, p_opens_at timestamp with time zone, p_due_at timestamp with time zone, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_word_min integer, p_word_max integer)',
    'refuse_acknowledgment_change()',
    'notice_acknowledgment_binding_fill()',
    'has_acknowledged_current(p_assignment_id uuid) definer app',
    'list_teacher_courses() app',
    'actor_mentorship_role(p_mentorship_id uuid) definer app',
    'create_mentor_note(p_mentorship_id uuid, p_body text) definer app',
    'check_mentorship_version() definer',
    'assignment_version_institution_fill()',
    'course_enrollment_code_institution_fill()',
    'notify_assignment_version() definer',
      'notify_published_comment() definer',
    'require_course_teacher(p_course_id uuid, OUT user_id uuid, OUT institution_id uuid)',
    'require_legal_hold_admin(OUT user_id uuid, OUT institution_id uuid)',
    'is_confirmed_teacher(p_user_id uuid, p_course_id uuid)',
    'set_course_holder(p_course_id uuid, p_holder_id uuid) definer app',
    'hand_over_course(p_course_id uuid, p_holder_id uuid) definer app',
    'create_seminar_group(p_course_id uuid, p_name text) definer app',
    'assign_group_teacher(p_group_id uuid, p_teacher_id uuid) definer app',
    'assign_group_student(p_group_id uuid, p_student_id uuid) definer app',
    'end_group_assignment(p_group_id uuid, p_user_id uuid) definer app',
    'actor_group_access(p_course_id uuid)',
    'require_group_manager(p_course_id uuid, p_collaborator boolean, OUT user_id uuid, OUT institution_id uuid)',
    'course_groups(p_course_id uuid) definer app',
    'read_teaching_team(p_course_id uuid) definer app',
    'read_teaching_team_view(p_course_id uuid) definer app',
    'lock_teaching_team(p_course_id uuid, OUT user_id uuid, OUT institution_id uuid)',
    'check_teaching_member_ids(p_ids uuid[])',
    'replace_course_assistants(p_course_id uuid, p_assistant_ids uuid[]) definer app',
    'replace_teaching_group_members(p_course_id uuid, p_group_id uuid, p_assistant_ids uuid[], p_student_ids uuid[]) definer app',
    'can(p_action text, p_document_id text) definer app',
    'actor_group_student(p_course_id uuid, p_student_id uuid)',
    'actor_group_work(p_assignment_id uuid, p_student_id uuid)',
    'actor_course_work(p_assignment_id uuid, p_student_id uuid)',
    'is_course_team_member(p_user_id uuid, p_course_id uuid)',
    'is_course_team_teacher(p_user_id uuid, p_course_id uuid)',
    'set_course_editor(p_course_id uuid, p_editor_id uuid) definer app',
    'end_course_editor(p_course_id uuid) definer app',
    'set_team_substitution(p_course_id uuid, p_absent_id uuid, p_substitute_id uuid, p_valid_to timestamp with time zone) definer app',
    'end_team_substitution(p_substitution_id uuid) definer app',
    'team_notification_recipients(p_course_id uuid, p_student_id uuid)',
    'is_grant_action_set(p_actions text[])',
    'work_relation(p_user_id uuid, p_assignment_id uuid)',
    'grant_work_access(p_assignment_id uuid, p_student_id uuid, p_grantee_id uuid, p_kind text, p_actions text[], p_valid_from timestamp with time zone, p_valid_to timestamp with time zone) definer app',
    'revoke_work_access(p_grant_id uuid) definer app',
    'grant_can(p_action text, p_document_id text) definer app',
    'work_grant_binding_fill()',
    'lock_teacher_role(p_user_id uuid)',
    'request_mentorship(p_teacher_id uuid, p_work_type text) definer app',
    'withdraw_mentorship_request(p_request_id uuid) definer app',
    'approve_mentorship_request(p_request_id uuid) definer app',
    'decline_mentorship_request(p_request_id uuid, p_reason text) definer app',
    'refuse_rule_version_change()',
    'check_rule_version_event() definer',
    'publish_faculty_rule_version(p_work_type text, p_expected_version integer, p_ai_policy text, p_ai_purposes text[], p_evidence_profile text, p_import_allowed boolean) definer app',
    'require_admin_request(p_user_id uuid, p_request_ref text)',
    'appoint_institution_admin(p_user_id uuid, p_request_ref text)',
    'revoke_institution_admin(p_user_id uuid, p_request_ref text)',
    'check_admin_appointment() definer',
    'check_last_admin() definer',
    'is_work_language(p_language text)',
    'assignment_version_work_language() definer',
    'work_language_offered(p_assignment_id uuid, p_language text) definer',
    'work_language_offered_check() definer',
    'assignment_version_config_language() definer',
    'assignment_version_purpose_catalog() definer',
    'lock_assignment_teacher(p_assignment_id uuid)',
    'lock_assignment_student(p_assignment_id uuid, p_student_id uuid)',
    'set_assignment_work_language(p_assignment_id uuid, p_expected_version integer, p_work_language text) definer app',
    'work_language(p_assignment_id uuid, p_student_id uuid) definer app',
    'set_work_language(p_assignment_id uuid, p_student_id uuid, p_work_language text) definer app',
    'work_accommodation(p_assignment_id uuid, p_student_id uuid) definer app',
    'set_work_accommodation(p_assignment_id uuid, p_marked boolean) definer app',
    'check_admin_event_actor() definer',
    'admin_appoint_admin(p_user_id uuid) definer app',
    'refuse_notice_read_change()',
    'mark_notice_read(p_assignment_id uuid) definer app',
    'student_assignments() definer app',
    -- INT-31 (Ductus#2055): the assignments of the open mentorships of the caller.
    'student_mentored_assignments() definer app',
    'admin_create_course(p_name text, p_academic_year text, p_ai_policy text, p_holder_id uuid) definer app',
    'work_source_record_valid(p_id uuid, p_record jsonb)',
    'source_notes(p_document_id text, p_source_id uuid, p_method text, p_note_id uuid, p_fields jsonb) definer app',
    'work_source_access(p_assignment_id uuid, p_student_id uuid)',
    'guidance_work_role(p_assignment_id uuid, p_student_id uuid)',
    'guidance_course_role(p_course_id uuid)',
    'guidance_instant(p_at timestamp with time zone)',
    'guidance_request_json(r institution.source_proof_request)',
    'guidance_work_of(p_document_id text, p_writer boolean)',
    'guidance_source_json(p_id uuid, p_record jsonb, p_doi text, p_isbn text, p_undated boolean, p_requirement text, p_created timestamp with time zone, p_updated timestamp with time zone)',
    'save_work_source(p_assignment_id uuid, p_record jsonb, p_doi text, p_isbn text, p_undated boolean) definer app',
    'delete_work_source(p_assignment_id uuid, p_source_id uuid) definer app',
    'work_sources(p_assignment_id uuid, p_student_id uuid) definer app',
    'save_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_record jsonb, p_requirement text, p_doi text, p_isbn text, p_undated boolean) definer app',
    'delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid) definer app',
    'refuse_work_attachment_change()',
    'add_work_attachment(p_assignment_id uuid, p_media_type text, p_byte_size integer, p_sha256 text, p_storage_ref text, p_pixel_width integer, p_pixel_height integer) definer app',
    'work_attachments(p_assignment_id uuid, p_student_id uuid) definer app',
    'read_work_attachment(p_attachment_id uuid) definer app',
    'source_proof_text_valid(p_text text, p_max integer, p_lines boolean)',
    'add_source_proof(p_assignment_id uuid, p_source_id uuid, p_page text, p_note text, p_image bytea) definer app',
    'source_proofs(p_assignment_id uuid, p_source_id uuid, p_student_id uuid) definer app',
    'read_source_proof_image(p_assignment_id uuid, p_source_id uuid, p_proof_id uuid, p_student_id uuid) definer app',
    'refuse_deadline_extension_change()',
    'reject_late_submission_exception_change()',
    'grant_late_submission_exception(p_assignment_id uuid, p_student_id uuid, p_until_at timestamp with time zone, p_reason_id text) definer app',
    'late_submission_exceptions(p_assignment_id uuid) definer app',
    'student_late_submission_exceptions(p_assignment_id uuid) definer app',
    'effective_due_at(p_assignment_id uuid, p_student_id uuid)',
    'extend_assignment_deadline(p_assignment_id uuid, p_student_id uuid, p_due_at timestamp with time zone, p_reason_id text) definer app',
    'deadline_extensions(p_assignment_id uuid) definer app',
    'student_deadline_history(p_assignment_id uuid) definer app',
    'copy_assignment(p_assignment_id uuid, p_course_id uuid, p_request_id uuid, p_opens_at timestamp with time zone, p_due_at timestamp with time zone) definer app',
      'list_notifications(p_before uuid, p_reminder_seconds integer) definer app',
      'list_revision_notifications(p_before uuid) definer app',
      'read_notification(p_id uuid) definer app',
    'guard_merlin_package()',
    'refuse_merlin_package_download_change()',
    'merlin_package_visible(p_assignment_id uuid, p_student_ids uuid[])',
    'own_merlin_package(p_assignment_id uuid, p_package_id uuid)',
    'merlin_package_state(p_state text, p_expires_at timestamp with time zone)',
    'request_merlin_package(p_assignment_id uuid, p_request_key text) definer app',
    'complete_merlin_package(p_assignment_id uuid, p_package_id uuid, p_content bytea, p_student_ids uuid[]) definer app',
    'fail_merlin_package(p_assignment_id uuid, p_package_id uuid, p_code text) definer app',
    'merlin_package_status(p_assignment_id uuid, p_package_id uuid) definer app',
    'download_merlin_package(p_assignment_id uuid, p_package_id uuid) definer app',
    'consultation_slots(p_document_id text) definer app',
    'request_consultation_slot(p_document_id text, p_starts_at timestamp with time zone) definer app',
    'act_on_consultation_slot(p_document_id text, p_slot_id uuid, p_action text, p_starts_at timestamp with time zone) definer app',
    'refuse_withdrawal_setting_change()',
    'withdrawal_setting_of(p_assignment_id uuid)',
    'submission_withdrawal_setting(p_assignment_id uuid) definer app',
    'set_submission_withdrawal(p_assignment_id uuid, p_allowed boolean) definer app',
    'set_declaration_required(p_assignment_id uuid, p_required boolean) definer app',
    'declaration_required_of(p_assignment_id uuid)',
    'declaration_required_setting(p_assignment_id uuid) definer app',
    'is_declaration_question(p_text text)',
    'declaration_question_of(p_assignment_id uuid)',
    'declaration_question_setting(p_assignment_id uuid) definer app',
    'set_declaration_question(p_assignment_id uuid, p_question text) definer app',
    'set_late_submission_allowed(p_assignment_id uuid, p_allowed boolean) definer app',
    'reject_work_milestone_event_change()',
    'is_thesis_text(p_text text, p_max integer)',
    'reject_thesis_record_change()',
    'reject_practice_record_change()',
    'practice_entries_digest(p_placement_id uuid, p_through date)',
    'practice_context(p_placement_id uuid, OUT o_institution_id uuid, OUT o_user_id uuid, OUT o_part text, OUT o_starts_on date, OUT o_ends_on date, OUT o_mentorship_open boolean)',
    'reject_work_team_record_change()',
    'work_team_setting_of(p_assignment_id uuid, OUT o_enabled boolean, OUT o_min_size integer, OUT o_max_size integer, OUT o_formation text)',
    'work_team_members_now(p_assignment_id uuid)',
    'work_team_context(p_assignment_id uuid, p_part text, OUT o_user_id uuid, OUT o_institution_id uuid, OUT o_enabled boolean, OUT o_min_size integer, OUT o_max_size integer, OUT o_formation text)',
    'work_team_lock(p_assignment_id uuid)',
    'work_team_part_submitted(p_assignment_id uuid, p_student_id uuid)',
    'peer_review_rubrics_valid(p_rubrics jsonb)',
    'reject_peer_review_record_change()',
    'peer_review_min_submissions(p_reviews_per_student integer)',
    'peer_review_pairs(p_round_id uuid, p_students uuid[], p_reviews_per_student integer)',
    'peer_review_context(p_assignment_id uuid, p_part text, OUT o_user_id uuid, OUT o_institution_id uuid, OUT o_course_id uuid)',
    'peer_review_lock(p_assignment_id uuid)',
    'peer_review_round_of(p_assignment_id uuid)',
    'peer_review_allocated(p_round_id uuid)',
    'questionnaire_options_valid(p_options jsonb)',
    'questionnaire_scale_valid(p_scale jsonb)',
    'questionnaire_shape_valid(p_kind text, p_options jsonb, p_scale jsonb)',
    'questionnaire_line_valid(p_value text, p_max integer)',
    'questionnaire_questions_valid(p_questions jsonb)',
    'questionnaire_value_valid(p_kind text, p_options jsonb, p_scale jsonb, p_value jsonb)',
    'reject_questionnaire_change()',
    'guard_questionnaire_question()',
    'reject_questionnaire_record_change()',
    'questionnaire_context(p_id uuid, p_part text, OUT o_user_id uuid, OUT o_institution_id uuid, OUT o_course_id uuid, OUT o_state text)',
    'questionnaire_course_context(p_course_id uuid, OUT o_user_id uuid, OUT o_institution_id uuid)',
    'questionnaire_add_questions(p_id uuid, p_questions jsonb)',
    'questionnaire_answers_valid(p_id uuid, p_answers jsonb)',
    'questionnaire_add_response(p_id uuid, p_answers jsonb)',
    'qual_text_valid(p_value text, p_max integer, p_multiline boolean)',
    'qual_body_valid(p_body text)',
    'qual_normalize_body(p_body text)',
    'qual_anchor_valid(p_body text, p_paragraph integer, p_start integer, p_end integer, p_quote text)',
    'reject_qual_change()',
    'guard_qual_code()',
    'qual_material_context(p_id uuid, OUT o_user_id uuid, OUT o_institution_id uuid)',
    'qual_code_context(p_id uuid, OUT o_user_id uuid, OUT o_institution_id uuid)',
    'qual_renumber_codes(p_owner uuid)',
    'thesis_setting_now()',
    'thesis_work_context(p_document_id text, OUT o_institution_id uuid, OUT o_user_id uuid, OUT o_part text, OUT o_work_type text)',
    'reject_milestone_template_change()',
    'reject_assignment_rubric_change()',
    'is_rubric_text(p_value jsonb, p_min integer, p_max integer, p_lines boolean)',
    'is_rubric_criteria(p_list jsonb)',
    'assignment_rubric_role(p_assignment_id uuid) definer',
    'reject_work_template_change()',
    'reject_assignment_template_pin_update()',
    'is_work_template_text(p_text text, p_min integer, p_max integer)',
    'is_work_template_title_page(p_list jsonb)',
    'is_work_template_sections(p_list jsonb)',
    'is_milestone_title(p_title text)',
    'is_milestone_template_list(p_list jsonb)',
    'apply_milestone_template(p_assignment_id uuid, p_from timestamp with time zone) definer',
    'assignment_apply_milestone_template() definer',
    'work_milestone_context(p_document_id text, OUT o_institution_id uuid, OUT o_assignment_id uuid, OUT o_user_id uuid, OUT o_role text, OUT o_mentor boolean)',
    'work_interview_draft_days()',
    'work_interview_context(p_document_id text, OUT actor_id uuid, OUT role text, OUT institution_id uuid, OUT assignment_id uuid, OUT student_id uuid, OUT interview_id uuid, OUT invited boolean)',
    'work_interview_read(p_document_id text, p_actor_id uuid, p_role text, p_interview_id uuid)',
    'work_interview_ensure(p_document_id text, c record)',
    'work_interview_get(p_document_id text) definer app',
    'add_work_interview_question(p_document_id text, p_paragraph_ref text, p_question_text text) definer app',
    'remove_work_interview_question(p_document_id text, p_question_id uuid) definer app',
    'invite_work_interview(p_document_id text) definer app',
    'set_work_interview_appointment(p_document_id text, p_slot_id uuid, p_place text, p_at timestamp with time zone) definer app',
    'mark_work_interview_held(p_document_id text, p_date date) definer app',
    'add_work_interview_explanation(p_document_id text, p_question_id uuid, p_text text) definer app',
    'work_interview_note_max_bytes()',
    'work_interview_note_max_count()',
    'is_work_interview_note(p_media_type text, p_content bytea)',
    'add_work_interview_note(p_document_id text, p_file_name text, p_media_type text, p_content bytea) definer app',
    'list_mentorship_notifications(p_before uuid) definer app',
    'insert_consultation_slot(p_document_id text, p_starts_at timestamp with time zone, p_topic text, p_preparation_text text, p_changed_paragraphs integer, p_resolved_comments integer)',
    'consultation_slot_details(p_document_id text) definer app',
    'request_consultation_slot_detail(p_document_id text, p_starts_at timestamp with time zone, p_topic text, p_preparation_text text, p_changed_paragraphs integer, p_resolved_comments integer) definer app',
    'close_consultation_slot(p_document_id text, p_slot_id uuid, p_action text, p_reason text) definer app',
    'refuse_roster_import_change()',
    'roster_import_max_rows()',
    'roster_import_valid_for()',
    'roster_name_key(p_name text)',
    'roster_import_admin(OUT user_id uuid, OUT institution_id uuid)',
    'roster_import_ineligible(p_user uuid, p_actor uuid)',
    'preview_roster_import(p_course_id uuid, p_source text, p_rows jsonb) definer app',
    'confirm_roster_import(p_import_id uuid) definer app'
  ],
  'functions: exact signatures, which are SECURITY DEFINER and which ductus_app may call'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || p.proname
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN pg_proc p
     WHERE p.pronamespace = 'institution'::regnamespace AND has_function_privilege(r.rolname, p.oid, 'EXECUTE') $$,
  'no other role, nor PUBLIC, may execute an institution function'
);
SELECT is_empty(
  $$ SELECT p.proname FROM pg_proc p
     WHERE p.pronamespace = 'institution'::regnamespace
       AND (p.proowner <> 'ductus_identity'::regrole OR NOT coalesce('search_path=""' = ANY (p.proconfig), false)) $$,
  'every institution function belongs to the NOLOGIN owner role and pins an empty search_path'
);

-- 1b. SRV-20: the submission state by assignment lives in schema app; its
-- reader app.submission_state_of is never the web role's. One cell per actor
-- of the fixture on Z1 of K1 (no submission in this fixture, so a student of
-- the course reads none) and on Z3 of fak-b.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.submission_state_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-20: only its owner and the identity role execute app.submission_state_of, never ductus_app'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.notify_submission_owner(uuid,uuid,uuid)', 'app.notify_bound_receipt()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1701: application and worker cannot directly produce a receipt notification'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.my_submission_state(uuid)', 'app.my_assignment_requirements(uuid)',
                             'app.teacher_submission_state(uuid,uuid)',
                             'app.my_assignment_late_submission(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-20, SRV-NF4-KASNA-POLJE: only ductus_app and the owner execute the state RPCs'
);
SELECT is(
  pg_temp.ask(c.actor, format('SELECT state FROM app.my_submission_state(%s)', c.assignment)), c.state,
  format('SRV-20: %s reads the own submission state on %s: %s', c.actor, c.assignment, c.state)
)
FROM (VALUES
  ('ana', '{z1}', 'none'), ('dora', '{z1}', 'none'), ('vesna', '{z1}', 'not_found'), ('marko', '{z1}', 'not_found'),
  ('boris', '{z1}', 'not_found'), ('iva', '{z1}', 'not_found'), ('nina', '{z1}', 'not_found'),
  ('tomo', '{z1}', 'not_found'), ('tomo', '{z3}', 'none'), ('ana', '{z3}', 'not_found'), ('petra', '{z3}', 'not_found')
) AS c (actor, assignment, state);
SELECT is(
  pg_temp.ask(c.actor, format('SELECT outcome FROM app.my_assignment_requirements(%s)', c.assignment)), c.outcome,
  format('SRV-20: %s reads the requirements of %s: %s', c.actor, c.assignment, c.outcome)
)
FROM (VALUES
  ('ana', '{z1}', 'found'), ('dora', '{z1}', 'found'), ('vesna', '{z1}', 'not_found'), ('marko', '{z1}', 'not_found'),
  ('boris', '{z1}', 'not_found'), ('tomo', '{z1}', 'not_found'), ('tomo', '{z3}', 'found'), ('petra', '{z3}', 'not_found')
) AS c (actor, assignment, outcome);
SELECT is(
  coalesce(substr(pg_temp.ask(c.actor, format('SELECT state FROM app.teacher_submission_state(%s, %s)', c.assignment, c.student)),
                  1, 5), 'NULL'), c.state,
  format('SRV-20: %s reads the state of %s on %s: %s', c.actor, c.student, c.assignment, c.state)
)
FROM (VALUES
  ('vesna', '{z1}', '{ana}', 'none'), ('vesna', '{z1}', '{dora}', 'none'), ('marko', '{z1}', '{ana}', 'ZD403'),
  ('ana', '{z1}', '{ana}', 'ZD403'), ('dora', '{z1}', '{ana}', 'ZD403'), ('boris', '{z1}', '{ana}', 'ZD403'),
  ('iva', '{z1}', '{ana}', 'ZD403'), ('nina', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'),
  ('petra', '{z3}', '{tomo}', 'none'), ('vesna', '{z3}', '{tomo}', 'ZD403'), ('tomo', '{z3}', '{tomo}', 'ZD403'),
  ('vesna', '{z1}', '{boris}', 'ZD403'), ('vesna', '{z1}', '{tomo}', 'ZD403')
) AS c (actor, assignment, student, state);
SELECT is(
  substr(pg_temp.ask('ana', 'SELECT state FROM app.submission_state_of({z1}, {ana})'), 1, 5), '42501',
  'SRV-20: the web role cannot call the reader of the state'
);

-- 1c. SRV-21: a student's notes (evidence.submission_note) only through the
-- two RPCs; the writer and the reader of the table are never the web role's.
-- One cell per actor of the fixture on Z1 of K1 and Z3 of fak-b; the rest of
-- the matrix (seminar group, collaborator, mentor, removal, append-only) is
-- in 147-submission-note.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.submission_note_append(uuid,uuid,text)', 'app.submission_notes_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-21: only their owner and the identity role execute the writer and the reader of the notes'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.add_submission_note(uuid,text)', 'app.submission_notes(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-21: only ductus_app and the owner execute the two note RPCs'
);
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT ''ok'' FROM app.add_submission_note(%s, %L)', c.assignment, 'Napomena ' || c.actor)), 1, 5),
  c.outcome, format('SRV-21: %s adds a note on %s: %s', c.actor, c.assignment, c.outcome)
)
FROM (VALUES
  ('ana', '{z1}', 'ok'), ('dora', '{z1}', 'ok'), ('vesna', '{z1}', 'ZD403'), ('marko', '{z1}', 'ZD403'),
  ('boris', '{z1}', 'ZD403'), ('iva', '{z1}', 'ZD403'), ('tomo', '{z1}', 'ZD403'), ('tomo', '{z3}', 'ok'),
  ('petra', '{z3}', 'ZD403')
) AS c (actor, assignment, outcome);
SELECT is(
  substr(pg_temp.ask('ana', format('SELECT ''ok'' FROM app.add_submission_note({z1}, %L)', repeat('a', 601))), 1, 5), 'ZD422',
  'SRV-21: a note of 601 characters is refused'
);
SELECT is(
  coalesce(substr(pg_temp.ask(c.actor, format('SELECT string_agg(text, ''|'') FROM app.submission_notes(%s, %s)',
                                              c.assignment, c.student)), 1, 13), 'NULL'), c.result,
  format('SRV-21: %s reads the notes of %s on %s: %s', c.actor, c.student, c.assignment, c.result)
)
FROM (VALUES
  ('ana', '{z1}', '{ana}', 'Napomena ana'), ('vesna', '{z1}', '{ana}', 'Napomena ana'),
  ('dora', '{z1}', '{ana}', 'ZD403: forbid'), ('marko', '{z1}', '{ana}', 'ZD403: forbid'),
  ('iva', '{z1}', '{ana}', 'ZD403: forbid'), ('petra', '{z3}', '{tomo}', 'Napomena tomo'),
  ('vesna', '{z3}', '{tomo}', 'ZD403: forbid')
) AS c (actor, assignment, student, result);

-- 1c2. SRV-1314: a student's amendment or dispute of a summary event
-- (evidence.event_dispute) only through the two RPCs; the writer and the
-- reader of the table are never the web role's. One cell per actor of the
-- fixture on Z1 of K1 and Z3 of fak-b; the rest of the matrix (seminar group,
-- collaborator, mentor, removal, input, append-only) is in 186-event-dispute.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-1314: event_dispute has forced RLS, the evidence owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'evidence.event_dispute'::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.event_dispute_append(uuid,uuid,text,text,text)', 'app.event_disputes_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1314: only their owner and the identity role execute the writer and the reader of the event records'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.add_event_dispute(uuid,text,text,text)', 'app.event_disputes(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1314: only ductus_app and the owner execute the two event record RPCs'
);
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT ''ok'' FROM app.add_event_dispute(%s, ''dispute'', ''pastes/0'', %L)',
                                     c.assignment, 'Osporavam ' || c.actor)), 1, 5),
  c.outcome, format('SRV-1314: %s disputes an event of %s: %s', c.actor, c.assignment, c.outcome)
)
FROM (VALUES
  ('ana', '{z1}', 'ok'), ('dora', '{z1}', 'ok'), ('vesna', '{z1}', 'ZD403'), ('marko', '{z1}', 'ZD403'),
  ('boris', '{z1}', 'ZD403'), ('iva', '{z1}', 'ZD403'), ('tomo', '{z1}', 'ZD403'), ('tomo', '{z3}', 'ok'),
  ('petra', '{z3}', 'ZD403')
) AS c (actor, assignment, outcome);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.add_work_event_dispute(text,text,text,text)', 'app.work_event_disputes(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1315: only ductus_app and the owner execute the two work-keyed event record RPCs (cells in 187-event-dispute-by-work.sql)'
);
SELECT is(
  substr(pg_temp.ask('ana', format('SELECT ''ok'' FROM app.add_event_dispute({z1}, ''dispute'', ''pastes/0'', %L)',
                                   repeat('a', 1001))), 1, 5), 'ZD422',
  'SRV-1314: a record of 1001 characters is refused'
);
SELECT is(
  coalesce(substr(pg_temp.ask(c.actor, format('SELECT string_agg(text, ''|'') FROM app.event_disputes(%s, %s)',
                                              c.assignment, c.student)), 1, 13), 'NULL'), c.result,
  format('SRV-1314: %s reads the event records of %s on %s: %s', c.actor, c.student, c.assignment, c.result)
)
FROM (VALUES
  ('ana', '{z1}', '{ana}', 'Osporavam ana'), ('vesna', '{z1}', '{ana}', 'Osporavam ana'),
  ('dora', '{z1}', '{ana}', 'ZD403: forbid'), ('marko', '{z1}', '{ana}', 'ZD403: forbid'),
  ('iva', '{z1}', '{ana}', 'ZD403: forbid'), ('petra', '{z3}', '{tomo}', 'Osporavam tom'),
  ('vesna', '{z3}', '{tomo}', 'ZD403: forbid')
) AS c (actor, assignment, student, result);

-- 1c3. SRV-0910: the kind of origin and the rhythm of typing (evidence.origin_change,
-- evidence.input_rhythm, evidence.input_rhythm_setting) and the teacher's switch
-- of the rhythm (evidence.input_rhythm_assignment_setting, PIL-P1-RITAM-SRV; per
-- course evidence.input_rhythm_course_setting, PIL-P1-RITAM-PREDMET-SRV) only
-- through the RPCs; the cells per actor are in 223-origin-rhythm.sql,
-- 226-input-rhythm-switch.sql and 229-input-rhythm-course-switch.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-0910: ' || t.name || ' has forced RLS, the evidence owner and no privilege for another role')
  FROM (VALUES ('origin_change'), ('input_rhythm'), ('input_rhythm_setting'), ('input_rhythm_assignment_setting'),
    ('input_rhythm_course_setting')) AS t (name)
  JOIN pg_class c ON c.oid = ('evidence.' || t.name)::regclass;
-- The trail of the teacher's switch (audit.input_rhythm_switch_event), PIL-P1-RITAM-SRV.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'PIL-P1-RITAM-SRV: audit.input_rhythm_switch_event has forced RLS, the identity owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'audit.input_rhythm_switch_event'::regclass;
-- The trail of the course's switch (audit.input_rhythm_course_switch_event), PIL-P1-RITAM-PREDMET-SRV.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'PIL-P1-RITAM-PREDMET-SRV: audit.input_rhythm_course_switch_event has forced RLS, the identity owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'audit.input_rhythm_course_switch_event'::regclass;
-- The trail of the assistant switch per course (audit.assistant_course_switch_event), SRV-ASIST-PREKIDAC.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-ASIST-PREKIDAC: audit.assistant_course_switch_event has forced RLS, the identity owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'audit.assistant_course_switch_event'::regclass;
-- The trail of the declaration switch (audit.declaration_required_event), PIL-K-IZJAVA-SRV.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'PIL-K-IZJAVA-SRV: audit.declaration_required_event has forced RLS, the identity owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'audit.declaration_required_event'::regclass;
-- The trail of the teacher's question with the declaration (audit.declaration_question_event), SRV-IZJAVA-PITANJE.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-IZJAVA-PITANJE: audit.declaration_question_event has forced RLS, the identity owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'audit.declaration_question_event'::regclass;

-- 1c3b. SRV-KARTA-RASPON: the ranges of origin of a revision (evidence.origin_segment)
-- only through the RPCs; the cells per actor are in 246-origin-segments.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-KARTA-RASPON: origin_segment has forced RLS, the evidence owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'evidence.origin_segment'::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.work_origin_segments_record(text,bigint,jsonb)', 'app.work_origin_segments(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-KARTA-RASPON: only the web role (and the owner) execute the RPCs of the ranges');

-- The trail of the late-submission exception (audit.late_submission_exception_event), SRV-NF4-IZNIMKA-ZAPIS.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-NF4-IZNIMKA-ZAPIS: audit.late_submission_exception_event has forced RLS, the identity owner and no privilege for another role')
  FROM pg_class c WHERE c.oid = 'audit.late_submission_exception_event'::regclass;

-- 1c4. SRV-1230: the match with the assistant (evidence.assistant_match_finding,
-- assistant_match_attachment, assistant_match_setting) only through the RPCs; the
-- cells per actor are in 225-assistant-match.sql. PIL-P1-PODUDARANJE-OBJASNJENJE-SRV:
-- the student's explanation of a finding (assistant_match_explanation) the same;
-- its cells per actor are in 230-assistant-match-explanation.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-1230: ' || t.name || ' has forced RLS, the evidence owner and no privilege for another role')
  FROM (VALUES ('assistant_match_finding'), ('assistant_match_attachment'), ('assistant_match_setting'),
               ('assistant_match_explanation')) AS t (name)
  JOIN pg_class c ON c.oid = ('evidence.' || t.name)::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.assistant_match_explain(text,text,uuid,text)', 'app.assistant_match_explanations(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'PIL-P1-PODUDARANJE-OBJASNJENJE-SRV: only the web role (and the owner) execute the explanation RPCs');
-- 1c5. SRV-1111: the thresholds of a faculty per kind of origin
-- (institution.origin_threshold, audit.origin_threshold_event) only through the
-- RPCs; the web role executes only them, and the cells per actor are in
-- 224-faculty-thresholds.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'SRV-1111: ' || t.nsp || '.' || t.rel || ' has forced RLS, the identity owner and no privilege for another role')
  FROM (VALUES ('institution', 'origin_threshold'), ('audit', 'origin_threshold_event')) AS t (nsp, rel)
  JOIN pg_class c ON c.oid = (t.nsp || '.' || t.rel)::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.origin_thresholds_read()', 'app.origin_threshold_put(text,numeric,text)',
       'app.origin_threshold_clear(text)', 'app.work_origin_threshold_status(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1111: only the web role (and the owner) execute the threshold RPCs');

-- 1d. SRV-28: the decline of a mentorship request and the overview of an
-- assignment, one cell per actor; the rest of their matrix (states, reason,
-- the trail; collaborator, groups, receipts) is in 104-mentorship-request.sql
-- and 086-assignment-submissions.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.decline_mentorship_request(uuid,text)', 'app.assignment_overview(uuid)',
                             'app.teacher_course_assignment_ids(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only ductus_app and the owner execute the decline, the overview and the course assignment ids'
);
SELECT is(
  pg_temp.ask(c.actor, format('SELECT count(*)::text FROM app.assignment_overview(%s)', c.assignment)), c.rows,
  format('SRV-28: %s reads the overview of %s: %s', c.actor, c.assignment, c.rows)
)
FROM (VALUES
  ('vesna', '{z1}', '2'), ('marko', '{z1}', '0'), ('ana', '{z1}', '0'), ('dora', '{z1}', '0'), ('boris', '{z1}', '0'),
  ('iva', '{z1}', '0'), ('nina', '{z1}', '0'), ('petra', '{z1}', '0'), ('petra', '{z3}', '1')
) AS c (actor, assignment, rows);
SELECT is(
  pg_temp.ask(c.actor, format('SELECT count(*) FROM app.teacher_course_assignment_ids(%s)', c.course)), c.result,
  format('SRV-29: %s reads only the course assignment ids permitted for %s', c.actor, c.course)
)
FROM (VALUES
  ('vesna', '{k1}', '1'), ('marko', '{k1}', '0'), ('ana', '{k1}', '0'), ('iva', '{k1}', '0'),
  ('nina', '{k1}', '0'), ('petra', '{k1}', '0'), ('vesna', '{nobody}', '0'),
  ('closed', '{k1}', 'ZD401: not authenticated')
) AS c (actor, course, result);
-- SRV-1906 (plan P-D6): the operator's pilot numbers. Only the web role
-- executes the RPC (the operator list and the second factor are the server's,
-- step 8); every live session gets one row of counts, none without a session.
-- The rest (suppression, cutoff, columns) is in 208-pilot-metrics.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.pilot_metrics()', 'app.pilot_metrics_at(timestamptz)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1906: only ductus_app and the owner execute the pilot numbers'
);
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.pilot_metrics()'), c.result,
  format('SRV-1906: %s reads the pilot numbers: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', '1'), ('ana', '1'), ('iva', '1'), ('tomo', '1'),
  ('closed', 'ZD401: not authenticated'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
-- SRV-ADMIN-1 (NF-7 OA-7, OA-3): the problem reports routed by kind and the
-- log of administrator and operator actions. Only the web role executes the
-- RPCs; a reader position gets its (here empty) list, anybody else ZD403, no
-- session ZD401. The routing, the state trail and the log rows are in
-- 232-problem-report-routing.sql and 233-admin-action-log.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['identity.routed_problem_reports()', 'identity.set_problem_report_status(text,text)',
       'identity.submit_course_problem_report(uuid,text,text,text,text,integer,text)', 'app.admin_action_log()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-ADMIN-1: only ductus_app and the owner execute the report routing and the action log'
);
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM identity.routed_problem_reports()'), c.result,
  format('SRV-ADMIN-1: %s reads the routed problem reports: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', '0'), ('marko', '0'), ('iva', '0'), ('lea', '0'), ('ana', 'ZD403: forbidden'), ('boris', 'ZD403: forbidden'),
  ('nina', 'ZD403: forbidden'), ('tomo', 'ZD403: forbidden'), ('closed', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.admin_action_log()'), c.result,
  format('SRV-ADMIN-1: %s reads the action log: %s', c.actor, c.result))
FROM (VALUES
  ('iva', '2'), ('lea', '2'), ('vesna', 'ZD403: forbidden'), ('ana', 'ZD403: forbidden'), ('nina', 'ZD403: forbidden'),
  ('closed', 'ZD401: not authenticated')
) AS c (actor, result);
-- SRV-1304 (plan M10.2, M10.7): the dry run of the data classes. Only the web
-- role executes it, with no institution from the caller; only the administrator
-- of the session's institution gets
-- the five counted classes, everyone else ZD403 or, without a session, ZD401.
-- The counts and the read-only proof are in 182-retention-dry-run.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
             AND rolname NOT IN ('ductus_app', 'ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.retention_candidates()', 'app.retention_evidence_candidates()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1304: only ductus_app and the owners execute the dry run'
);
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.retention_candidates()'), c.result,
  format('SRV-1304: %s runs the dry run: %s', c.actor, c.result))
FROM (VALUES
  ('iva', '5'), ('lea', '5'), ('vesna', 'ZD403: forbidden'), ('marko', 'ZD403: forbidden'),
  ('ana', 'ZD403: forbidden'), ('nina', 'ZD403: forbidden'), ('petra', 'ZD403: forbidden'),
  ('tomo', 'ZD403: forbidden'), ('closed', 'ZD401: not authenticated'),
  ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
-- SRV-1301 (M10.0-S1): the erasure contract. The tombstones have forced RLS
-- and only their owner reaches them; only the retention role executes the
-- two erasure RPCs, and the private steps belong to the two table owners.
-- The rest (append-only, the access log guard, the tombstone) is in
-- 180-erasure-tombstone.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner),
  'SRV-1301: erasure has forced RLS and no privilege outside its owner')
  FROM pg_class c WHERE c.oid = 'evidence.erasure'::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_retention', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.erasure_append(text,text,text,uuid)', 'app.erasure_of(text,text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1301: only the retention role and the owner execute the erasure RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.erasure_recorded(text,text)', 'app.access_log_hash(uuid)', 'app.access_log_erase(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1301: the private erasure steps are only for the two table owners'
);
SELECT is(pg_temp.ask_as(c.role, 'anon', $$ SELECT count(*)::text FROM app.erasure_of('access_log', {nobody}) $$), c.result,
  format('SRV-1301: %s reads a tombstone: %s', c.role, c.result))
FROM (VALUES
  ('ductus_app', '42501: permission denied for function erasure_of'),
  ('ductus_identity', '42501: permission denied for function erasure_of'),
  ('ductus_worker', '42501: permission denied for function erasure_of'),
  ('ductus_auth', '42501: permission denied for schema app'),
  ('ductus_retention', '0')
) AS c (role, result);
-- SRV-1303 (M10.0-S2): the scheduled purge of ended sessions. Only the
-- retention role and the owner of identity.session execute it; the web role
-- does not. The cut here is a century back, so the call deletes nothing of
-- this file's fixtures. The rest is in 181-purge-ended-sessions.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_retention', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.purge_ended_sessions(timestamptz)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1303: only the retention role and the owner execute the session purge'
);
SELECT is(pg_temp.ask_as(c.role, 'anon', $$ SELECT app.purge_ended_sessions(now() - interval '100 years')::text $$), c.result,
  format('SRV-1303: %s purges ended sessions: %s', c.role, c.result))
FROM (VALUES
  ('ductus_app', '42501: permission denied for function purge_ended_sessions'),
  ('ductus_worker', '42501: permission denied for function purge_ended_sessions'),
  ('ductus_auth', '42501: permission denied for schema app'),
  ('ductus_retention', '0')
) AS c (role, result);
-- SRV-1305 (M10.3): legal hold. The holds have forced RLS and only their
-- owner reaches them; the web role runs the three administrator RPCs, the
-- retention role only asks whether a subject is held, and no application role
-- runs the operator's release. The rest is in 212-legal-hold.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner),
  'SRV-1305: legal_hold has forced RLS and no privilege outside its owner')
  FROM pg_class c WHERE c.oid = 'evidence.legal_hold'::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['evidence.operator_release_legal_hold(uuid,text,text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1305: only the owner executes the operator''s release'
);
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.legal_holds()'), c.result,
  format('SRV-1305: %s lists the legal holds: %s', c.actor, c.result))
FROM (VALUES
  ('iva', '0'), ('lea', '0'), ('vesna', 'ZD403: forbidden'), ('ana', 'ZD403: forbidden'),
  ('tomo', 'ZD403: forbidden'), ('closed', 'ZD401: not authenticated'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.ask_as(c.role, 'iva', $$ SELECT app.is_on_legal_hold('work', 'doc-a')::text $$), c.result,
  format('SRV-1305: %s asks whether a work is held: %s', c.role, c.result))
FROM (VALUES
  ('ductus_app', '42501: permission denied for function is_on_legal_hold'),
  ('ductus_worker', '42501: permission denied for function is_on_legal_hold'),
  ('ductus_auth', '42501: permission denied for schema app'),
  ('ductus_retention', 'false')
) AS c (role, result);
-- SRV-1307 (M10.5): the export of a student's own data. Both tables have
-- forced RLS and only their owner reaches them; no application role runs the
-- operator's clerk procedures; the fixture has no clerk, so nobody requests,
-- and only an administrator of the institution gets as far as the request.
-- The worker alone runs its steps, the web role alone the link. The rest is in
-- 184-student-data-export.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner),
  format('SRV-1307: %s has forced RLS and no privilege outside its owner', c.relname))
  FROM pg_class c WHERE c.oid IN ('app.registry_clerk'::regclass, 'app.student_data_export'::regclass);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.appoint_registry_clerk(uuid,text)', 'app.revoke_registry_clerk(uuid,text)',
                             'app.student_data_export_actor()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1307: only the owner executes the clerk procedures and the private actor step'
);
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.student_data_exports()'), c.result,
  format('SRV-1307: %s lists the data exports: %s', c.actor, c.result))
FROM (VALUES
  ('iva', '0'), ('lea', '0'), ('vesna', '0'), ('ana', '0'), ('tomo', '0'),
  ('closed', 'ZD401: not authenticated'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.ask(c.actor, $$ SELECT app.request_student_data_export({ana}, true, 'Provjera 1/2026')::text $$),
  c.result, format('SRV-1307: %s requests a data export: %s', c.actor, c.result))
FROM (VALUES
  ('iva', 'ZD403: forbidden'), ('vesna', 'ZD403: forbidden'), ('dora', 'ZD403: forbidden'),
  ('tomo', 'ZD403: forbidden'), ('closed', 'ZD401: not authenticated'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.ask(c.actor, $$ SELECT app.approve_student_data_export({nobody}, 'Posao 1/2026')::text $$),
  c.result, format('SRV-1307: %s approves a data export: %s', c.actor, c.result))
FROM (VALUES
  ('iva', 'ZD404: not found'), ('lea', 'ZD404: not found'), ('vesna', 'ZD403: forbidden'),
  ('ana', 'ZD403: forbidden'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.ask_as(c.role, 'anon', 'SELECT app.worker_expire_student_data_exports()::text'), c.result,
  format('SRV-1307: %s expires the export links: %s', c.role, c.result))
FROM (VALUES
  ('ductus_app', '42501: permission denied for function worker_expire_student_data_exports'),
  ('ductus_retention', '42501: permission denied for function worker_expire_student_data_exports'),
  ('ductus_auth', '42501: permission denied for schema app'),
  ('ductus_worker', '0')
) AS c (role, result);
SELECT is(pg_temp.ask_as(c.role, 'anon',
    $$ SELECT export_id::text FROM app.consume_student_data_export(sha256('izmisljeni-token'::bytea)) $$),
  c.result, format('SRV-1307: %s uses an export link: %s', c.role, c.result))
FROM (VALUES
  ('ductus_app', 'ZD410: gone'),
  ('ductus_retention', '42501: permission denied for function consume_student_data_export'),
  ('ductus_auth', '42501: permission denied for schema app'),
  ('ductus_worker', '42501: permission denied for function consume_student_data_export')
) AS c (role, result);
-- SRV-1308 (M10.5): the worker's reads of the package of an approved export.
-- Only the worker runs them; the fixture has no export, so they read nothing.
-- The private subject step is the evidence role's alone. The rest is in
-- 185-student-data-export-contents.sql.
SELECT is(pg_temp.ask_as(c.role, 'anon', format('SELECT count(*)::text FROM app.%s(%L)', c.fn,
    '00000000-0000-4000-8000-0000000001ff')), c.result,
  format('SRV-1308: %s reads %s: %s', c.role, c.fn, c.result))
FROM (VALUES
  ('ductus_app', 'worker_student_data_export_submissions', '42501: permission denied for function worker_student_data_export_submissions'),
  ('ductus_retention', 'worker_student_data_export_submissions', '42501: permission denied for function worker_student_data_export_submissions'),
  ('ductus_auth', 'worker_student_data_export_submissions', '42501: permission denied for schema app'),
  ('ductus_worker', 'worker_student_data_export_submissions', '0'),
  ('ductus_app', 'worker_student_data_export_notes', '42501: permission denied for function worker_student_data_export_notes'),
  ('ductus_retention', 'worker_student_data_export_notes', '42501: permission denied for function worker_student_data_export_notes'),
  ('ductus_auth', 'worker_student_data_export_notes', '42501: permission denied for schema app'),
  ('ductus_worker', 'worker_student_data_export_notes', '0'),
  ('ductus_app', 'worker_student_data_export_access_log', '42501: permission denied for function worker_student_data_export_access_log'),
  ('ductus_retention', 'worker_student_data_export_access_log', '42501: permission denied for function worker_student_data_export_access_log'),
  ('ductus_auth', 'worker_student_data_export_access_log', '42501: permission denied for schema app'),
  ('ductus_worker', 'worker_student_data_export_access_log', '0')
) AS c (role, fn, result);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute app.student_data_export_subject(uuid)'
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.student_data_export_subject(uuid)', 'EXECUTE') $$,
  'SRV-1308: only the identity owner and the evidence reads execute the private subject step'
);
INSERT INTO ref VALUES ('rq',pg_temp.ask('ana', $$ SELECT institution.request_mentorship({vesna}, 'bachelor_thesis') $$));
SELECT matches((SELECT val FROM ref WHERE name = 'rq'), '^[0-9a-f-]{36}$', 'SRV-28: Ana asks Vesna to mentor a thesis');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.teacher_mentorship_requests()', 'app.approve_mentorship_request_with_work(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-31: the application role and owner execute the two RPCs'
);
SELECT ok(has_function_privilege('ductus_app', 'app.teacher_mentorship_requests()', 'EXECUTE')
       AND has_function_privilege('ductus_app', 'app.approve_mentorship_request_with_work(uuid)', 'EXECUTE'),
  'SRV-31: the application role can call both RPCs');
SELECT is(
  pg_temp.ask(c.actor, $$ SELECT count(*) FROM app.teacher_mentorship_requests() WHERE request_id = {rq} $$),
  c.rows, 'SRV-31: request visibility for ' || c.actor
)
FROM (VALUES ('vesna', '1'), ('marko', '0'), ('ana', '0'), ('iva', '0'), ('petra', '0'), ('anon', '0')) AS c (actor, rows);
SELECT is(
  left(pg_temp.ask(c.actor, $$ SELECT app.approve_mentorship_request_with_work({rq}) $$), 5),
  c.code, 'SRV-31: approval refused for ' || c.actor
)
FROM (VALUES ('marko', 'ZD403'), ('ana', 'ZD403'), ('iva', 'ZD403'), ('petra', 'ZD403'),
             ('tomo', 'ZD403'), ('anon', 'ZD401')) AS c (actor, code);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.approve_mentorship_request_once(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1407: only the application role and the owner execute the idempotent approval'
);
SELECT ok(has_function_privilege('ductus_app', 'app.approve_mentorship_request_once(uuid)', 'EXECUTE'),
  'SRV-1407: the application role can call the idempotent approval');
SELECT is(
  left(pg_temp.ask(c.actor, $$ SELECT app.approve_mentorship_request_once({rq}) $$), 5),
  c.code, 'SRV-1407: idempotent approval refused for ' || c.actor
)
FROM (VALUES ('marko', 'ZD403'), ('ana', 'ZD403'), ('iva', 'ZD403'), ('petra', 'ZD403'),
             ('tomo', 'ZD403'), ('anon', 'ZD401')) AS c (actor, code);
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT institution.decline_mentorship_request({rq}, NULL)::text $$), 1, 5), c.outcome,
  format('SRV-28: %s declines Ana''s request to Vesna: %s', c.actor, c.outcome)
)
FROM (VALUES (1, 'marko', 'ZD403'), (2, 'ana', 'ZD403'), (3, 'iva', 'ZD403'), (4, 'petra', 'ZD403'),
             (5, 'tomo', 'ZD403'), (6, 'vesna', 'true')) AS c (n, actor, outcome)
ORDER BY c.n;
-- SRV-1414: the student's own requests and the teachers a student may ask.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.student_mentorship_requests()', 'app.student_mentor_candidates()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1414: only the application role and the owner execute the student mentorship reads'
);
SELECT ok(has_function_privilege('ductus_app', 'app.student_mentorship_requests()', 'EXECUTE')
       AND has_function_privilege('ductus_app', 'app.student_mentor_candidates()', 'EXECUTE'),
  'SRV-1414: the application role can call both student mentorship reads');
SELECT is(
  pg_temp.ask(c.actor, $$ SELECT coalesce(string_agg(state, ','), '') FROM app.student_mentorship_requests()
                          WHERE request_id = {rq} $$),
  c.result, format('SRV-1414: %s reads Ana''s request among the own: %s', c.actor, c.result)
)
FROM (VALUES ('ana', 'declined'), ('dora', ''), ('boris', ''), ('iva', ''), ('nina', ''), ('tomo', ''),
             ('vesna', 'ZD403: forbidden'), ('marko', 'ZD403: forbidden'), ('petra', 'ZD403: forbidden'),
             ('anon', 'ZD401: not authenticated')) AS c (actor, result);
SELECT is(
  pg_temp.ask(c.actor, $$ SELECT coalesce(string_agg(p.name, ',' ORDER BY p.name), '')
                          FROM app.student_mentor_candidates() m JOIN person p ON p.id = m.teacher_id $$),
  c.result, format('SRV-1414: %s may ask: %s', c.actor, c.result)
)
FROM (VALUES ('ana', 'marko,vesna'), ('boris', 'marko,vesna'), ('nina', 'marko,vesna'), ('tomo', 'petra'),
             ('vesna', 'ZD403: forbidden'), ('petra', 'ZD403: forbidden'),
             ('anon', 'ZD401: not authenticated')) AS c (actor, result);

-- 1e. SRV-7B: the sources of a work (institution.work_source) only through
-- its three RPCs; the web role has no privilege or policy on the table. One
-- cell per actor on Z1 of K1 and Z3 of fak-b; the rest of the matrix (record
-- shape, DOI and ISBN, the bound, a teacher's source, seminar group,
-- collaborator, mentor) is in 149-work-source.sql.
CREATE FUNCTION pg_temp.source_json() RETURNS text LANGUAGE sql AS $$
  SELECT '{"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "type": "book", "year": 2024, '
         '"authors": [{"kind": "person", "family": "Izmišljenić", "given": "Mara"}], '
         '"title": "Kućno kompostiranje", "place": "Zagreb", "publisher": "Izmišljena naklada"}'
$$;
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT ''ok'' FROM institution.save_work_source(%s, %L::jsonb)',
                                     c.assignment, pg_temp.source_json())), 1, 5),
  c.outcome, format('SRV-7B: %s saves a source on %s: %s', c.actor, c.assignment, c.outcome)
)
FROM (VALUES
  ('ana', '{z1}', 'ok'), ('dora', '{z1}', 'ok'), ('vesna', '{z1}', 'ZD403'), ('marko', '{z1}', 'ZD403'),
  ('iva', '{z1}', 'ZD403'), ('boris', '{z1}', 'ZD403'), ('nina', '{z1}', 'ZD403'), ('tomo', '{z1}', 'ZD403'),
  ('lea', '{z1}', 'ZD403'), ('tomo', '{z3}', 'ok'), ('petra', '{z3}', 'ZD403'), ('anon', '{z1}', 'ZD401')
) AS c (actor, assignment, outcome);
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT count(*)::text FROM institution.work_sources(%s, %s)',
                                     c.assignment, c.student)), 1, 5), c.result,
  format('SRV-7B: %s reads the sources of %s on %s: %s', c.actor, c.student, c.assignment, c.result)
)
FROM (VALUES
  ('ana', '{z1}', 'NULL', '1'), ('ana', '{z1}', '{ana}', '1'), ('vesna', '{z1}', '{ana}', '1'),
  ('dora', '{z1}', '{ana}', 'ZD403'), ('marko', '{z1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'),
  ('boris', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'), ('petra', '{z3}', '{tomo}', '1'),
  ('vesna', '{z3}', '{tomo}', 'ZD403'), ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, result);
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT institution.delete_work_source({z1}, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')::text $$), 1, 5),
  c.outcome, format('SRV-7B: %s removes the source on Z1: %s', c.actor, c.outcome)
)
FROM (VALUES (1, 'vesna', 'ZD403'), (2, 'marko', 'ZD403'), (3, 'dora', 'true'), (4, 'dora', 'false'))
  AS c (n, actor, outcome)
ORDER BY c.n;
SELECT is(
  substr(pg_temp.ask(c.actor, format(
    'SELECT ''ok'' FROM institution.save_teacher_work_source(%s, %s, %L::jsonb, ''required'')',
    c.assignment, c.student, replace(pg_temp.source_json(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                     'cccccccc-cccc-4ccc-8ccc-cccccccccccc'))), 1, 5),
  c.outcome, format('SRV-7B: %s adds a required source to the work of %s on %s: %s', c.actor, c.student, c.assignment, c.outcome)
)
FROM (VALUES
  ('vesna', '{z1}', '{ana}', 'ok'), ('marko', '{z1}', '{ana}', 'ZD403'), ('ana', '{z1}', '{ana}', 'ZD403'),
  ('dora', '{z1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'), ('boris', '{z1}', '{ana}', 'ZD403'),
  ('nina', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'), ('petra', '{z3}', '{tomo}', 'ok'),
  ('vesna', '{z3}', '{tomo}', 'ZD403'), ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, outcome);
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT institution.delete_teacher_work_source({z1}, {ana}, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')::text $$), 1, 5),
  c.outcome, format('SRV-7B: %s removes the required source of Ana on Z1: %s', c.actor, c.outcome)
)
FROM (VALUES (1, 'ana', 'ZD403'), (2, 'marko', 'ZD403'), (3, 'vesna', 'true'), (4, 'vesna', 'false'))
  AS c (n, actor, outcome)
ORDER BY c.n;

-- 1f. SRV-9A: the versions of a work only through app.read_work_versions; its
-- reader of the evidence rows is never the web role's. This fixture has no
-- work, so every signed-in actor gets the one answer for a missing document;
-- the owner, the teacher, the cut, the pages and the access log are in
-- 152-work-versions.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.read_work_versions(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE')
     UNION ALL
     SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.work_version_rows(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-9A: only ductus_app and the owner execute the read; only the identity role and the owner the helper'
);
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT string_agg(outcome, ',') FROM app.read_work_versions('doc-nema') $$), 1, 9),
  c.outcome, format('SRV-9A: %s reads the versions of a missing work: %s', c.actor, c.outcome)
)
FROM (VALUES
  ('ana', 'not_found'), ('dora', 'not_found'), ('vesna', 'not_found'), ('marko', 'not_found'),
  ('iva', 'not_found'), ('boris', 'not_found'), ('nina', 'not_found'), ('tomo', 'not_found'),
  ('lea', 'not_found'), ('petra', 'not_found'), ('anon', 'ZD401: no')
) AS c (actor, outcome);

-- 1f2. SRV-1310: the source of the DOCX export of a work only through
-- app.read_work_export; its reader of the evidence rows is never the web
-- role's. The owner, the teacher, the version and the access log are in
-- 153-work-export.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.read_work_export(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE')
     UNION ALL
     SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.work_export_rows(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1310: only ductus_app and the owner execute the read; only the identity role and the owner the helper'
);
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT string_agg(outcome, ',') FROM app.read_work_export('doc-nema') $$), 1, 9),
  c.outcome, format('SRV-1310: %s reads the export source of a missing work: %s', c.actor, c.outcome)
)
FROM (VALUES
  ('ana', 'not_found'), ('dora', 'not_found'), ('vesna', 'not_found'), ('marko', 'not_found'),
  ('iva', 'not_found'), ('boris', 'not_found'), ('nina', 'not_found'), ('tomo', 'not_found'),
  ('lea', 'not_found'), ('petra', 'not_found'), ('anon', 'ZD401: no')
) AS c (actor, outcome);

-- 1f-bis. INT-21 C: the record of a restore (evidence.revision_restore) only
-- through app.record_revision_restore; the table has forced RLS and no right
-- for a runtime role, and the helper that writes is never the web role's. This
-- fixture has no work, so every signed-in actor gets the one answer for a
-- missing document, as for a malformed id; the owner (recorded,
-- already_recorded, no_matching_revision), the teacher, another student and
-- an owner of another work are in 227-revision-restore.sql.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND ARRAY(SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                         'ductus_identity', 'public']) r
               WHERE has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) = '{}'
    AND ARRAY(SELECT p.policyname::text FROM pg_policies p
      WHERE p.schemaname = 'evidence' AND p.tablename = c.relname
        AND p.roles = ARRAY['ductus_evidence'::name] AND p.cmd = 'ALL') = ARRAY['evidence_revision_restore_owner']
    AND (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'evidence' AND p.tablename = c.relname) = 1,
  'INT-21 C: evidence.revision_restore has forced RLS and only the evidence owner has access')
  FROM pg_class c WHERE c.oid = to_regclass('evidence.revision_restore');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.record_revision_restore(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE')
     UNION ALL
     SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.revision_restore_record(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'INT-21 C: only ductus_app and the owner execute the record; only the identity role and the owner the helper'
);
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT string_agg(outcome, ',') FROM app.record_revision_restore('doc-nema', 1) $$), 1, 9),
  c.outcome, format('INT-21 C: %s records a restore of a missing work: %s', c.actor, c.outcome)
)
FROM (VALUES
  ('ana', 'not_found'), ('dora', 'not_found'), ('vesna', 'not_found'), ('marko', 'not_found'),
  ('iva', 'not_found'), ('boris', 'not_found'), ('nina', 'not_found'), ('tomo', 'not_found'),
  ('lea', 'not_found'), ('petra', 'not_found'), ('anon', 'ZD401: no')
) AS c (actor, outcome);
SELECT is(
  pg_temp.ask('ana', format($$ SELECT string_agg(outcome, ',') FROM app.record_revision_restore(%L, 1) $$, d.id)),
  'not_found', 'INT-21 C: a malformed id gets the answer for a missing work: ' || d.label)
FROM (VALUES ('', 'empty'), (' doc-nema', 'a blank at its edge'), ('doc' || chr(1), 'a control character'))
  AS d (id, label);
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(outcome, ',') FROM app.record_revision_restore('doc-nema', 0) $$),
  'ZD422: invalid input', 'INT-21 C: a revision below 1 is refused before the access');

-- 1g. SRV-10B: the attachments of a work (institution.work_attachment) only
-- through its three RPCs; the web role has no privilege or policy on the
-- table. One cell per actor on Z1 of K1 and Z3 of fak-b; the rest (shape,
-- bounds, the same bytes twice, append-only, seminar group, collaborator,
-- mentor) is in 156-work-attachment.sql.
CREATE FUNCTION pg_temp.attach(p_actor text, p_assignment text, p_sha text) RETURNS text
LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format(
    'SELECT ''ok'' FROM institution.add_work_attachment(%s, ''image/png'', 2048, %L, %L, 640, 480)',
    p_assignment, p_sha, 'privitci/' || p_sha)), 1, 5)
$$;
SELECT is(pg_temp.attach(c.actor, c.assignment, repeat(c.digit, 64)), c.outcome,
  format('SRV-10B: %s adds an attachment on %s: %s', c.actor, c.assignment, c.outcome))
FROM (VALUES
  ('ana', '{z1}', 'a', 'ok'), ('dora', '{z1}', 'b', 'ok'), ('vesna', '{z1}', 'c', 'ZD403'),
  ('marko', '{z1}', 'c', 'ZD403'), ('iva', '{z1}', 'c', 'ZD403'), ('boris', '{z1}', 'c', 'ZD403'),
  ('nina', '{z1}', 'c', 'ZD403'), ('tomo', '{z1}', 'c', 'ZD403'), ('lea', '{z1}', 'c', 'ZD403'),
  ('tomo', '{z3}', 'd', 'ok'), ('petra', '{z3}', 'c', 'ZD403'), ('anon', '{z1}', 'c', 'ZD401')
) AS c (actor, assignment, digit, outcome);
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT count(*)::text FROM institution.work_attachments(%s, %s)',
                                     c.assignment, c.student)), 1, 5), c.result,
  format('SRV-10B: %s reads the attachments of %s on %s: %s', c.actor, c.student, c.assignment, c.result)
)
FROM (VALUES
  ('ana', '{z1}', 'NULL', '1'), ('ana', '{z1}', '{ana}', '1'), ('vesna', '{z1}', '{ana}', '1'),
  ('dora', '{z1}', '{ana}', 'ZD403'), ('marko', '{z1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'),
  ('boris', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'), ('petra', '{z3}', '{tomo}', '1'),
  ('vesna', '{z3}', '{tomo}', 'ZD403'), ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, result);
INSERT INTO ref VALUES ('att_ana', pg_temp.ask('ana', $$ SELECT id::text FROM institution.work_attachments({z1}) $$)),
                       ('att_tomo', pg_temp.ask('tomo', $$ SELECT id::text FROM institution.work_attachments({z3}) $$));
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT sha256 FROM institution.read_work_attachment(%s)', c.att)), 1, 5),
  c.result, format('SRV-10B: %s reads attachment %s by id: %s', c.actor, c.att, c.result)
)
FROM (VALUES
  ('ana', '{att_ana}', 'aaaaa'), ('vesna', '{att_ana}', 'aaaaa'), ('dora', '{att_ana}', 'ZD403'),
  ('marko', '{att_ana}', 'ZD403'), ('iva', '{att_ana}', 'ZD403'), ('boris', '{att_ana}', 'ZD403'),
  ('nina', '{att_ana}', 'ZD403'), ('lea', '{att_ana}', 'ZD403'), ('petra', '{att_ana}', 'ZD403'),
  ('tomo', '{att_ana}', 'ZD403'), ('petra', '{att_tomo}', 'ddddd'), ('vesna', '{att_tomo}', 'ZD403'),
  ('ana', '''eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee''', 'ZD403'), ('anon', '{att_ana}', 'ZD401')
) AS c (actor, att, result);

-- 1h. SRV-1102: the proofs of a source (institution.source_proof) only
-- through its three RPCs; the web role has no privilege or policy on the
-- table. One cell per actor on source A of Z1 of K1 and of Z3 of fak-b; the
-- rest (shape, a whole PDF, bounds, the removed source, seminar group,
-- mentor) is in 160-source-proof-access.sql.
INSERT INTO ref VALUES ('pf_src', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
SELECT is(substr(pg_temp.ask(c.actor, format('SELECT ''ok'' FROM institution.save_work_source(%s, %L::jsonb)',
                                             c.assignment, pg_temp.source_json())), 1, 5), 'ok',
  format('SRV-1102 fixture: %s has source A on %s', c.actor, c.assignment))
FROM (VALUES ('ana', '{z1}'), ('tomo', '{z3}')) AS c (actor, assignment);
SELECT is(
  substr(pg_temp.ask(c.actor, format(
    'SELECT ''ok'' FROM institution.add_source_proof(%s, {pf_src}, ''14'', NULL, ''\xffd8ffe0ffd9''::bytea)',
    c.assignment)), 1, 5),
  c.outcome, format('SRV-1102: %s attaches a proof to source A on %s: %s', c.actor, c.assignment, c.outcome)
)
FROM (VALUES
  ('ana', '{z1}', 'ok'), ('dora', '{z1}', 'ZD403'), ('vesna', '{z1}', 'ZD403'), ('marko', '{z1}', 'ZD403'),
  ('iva', '{z1}', 'ZD403'), ('boris', '{z1}', 'ZD403'), ('nina', '{z1}', 'ZD403'), ('tomo', '{z1}', 'ZD403'),
  ('lea', '{z1}', 'ZD403'), ('tomo', '{z3}', 'ok'), ('petra', '{z3}', 'ZD403'), ('anon', '{z1}', 'ZD401')
) AS c (actor, assignment, outcome);
SELECT is(
  substr(pg_temp.ask(c.actor, format('SELECT count(*)::text FROM institution.source_proofs(%s, {pf_src}, %s)',
                                     c.assignment, c.student)), 1, 5), c.result,
  format('SRV-1102: %s reads the proofs of %s on %s: %s', c.actor, c.student, c.assignment, c.result)
)
FROM (VALUES
  ('ana', '{z1}', 'NULL', '1'), ('vesna', '{z1}', '{ana}', '1'), ('dora', '{z1}', '{ana}', 'ZD403'),
  ('marko', '{z1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'), ('boris', '{z1}', '{ana}', 'ZD403'),
  ('nina', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'), ('lea', '{z1}', '{ana}', 'ZD403'),
  ('petra', '{z3}', '{tomo}', '1'), ('vesna', '{z3}', '{tomo}', 'ZD403'), ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, result);
INSERT INTO ref VALUES ('pf_ana', pg_temp.ask('ana', $$ SELECT id::text FROM institution.source_proofs({z1}, {pf_src}) $$));
SELECT is(
  substr(pg_temp.ask(c.actor, format(
    'SELECT sha256 FROM institution.read_source_proof_image({z1}, {pf_src}, {pf_ana}, %s)', c.student)), 1, 5),
  c.result, format('SRV-1102: %s reads the image of Ana''s proof: %s', c.actor, c.result)
)
FROM (VALUES
  ('ana', 'NULL', left(encode(sha256('\xffd8ffe0ffd9'::bytea), 'hex'), 5)),
  ('vesna', '{ana}', left(encode(sha256('\xffd8ffe0ffd9'::bytea), 'hex'), 5)),
  ('dora', '{ana}', 'ZD403'), ('dora', 'NULL', 'ZD403'), ('marko', '{ana}', 'ZD403'), ('iva', '{ana}', 'ZD403'),
  ('petra', '{ana}', 'ZD403'), ('lea', '{ana}', 'ZD403'), ('anon', '{ana}', 'ZD401')
) AS c (actor, student, result);
-- 1i. SRV-1108: deadline extensions (institution.deadline_extension) only
-- through their RPCs; the web role has no privilege or policy on the table.
-- One cell per actor on Z1 of K1; the rest (scope, effective deadline,
-- reasons, privacy of the reason, append-only) is in 166-deadline-extension-access.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, format(
    'SELECT ''ok'' FROM institution.extend_assignment_deadline({z1}, {ana}, now() + interval %L, ''justified'')',
    c.days || ' days')), 1, 5), c.outcome,
  format('SRV-1108: %s extends the deadline of Ana on Z1: %s', c.actor, c.outcome))
FROM (VALUES
  ('vesna', 400, 'ok'), ('marko', 401, 'ZD403'), ('iva', 401, 'ZD403'), ('ana', 401, 'ZD403'),
  ('dora', 401, 'ZD403'), ('boris', 401, 'ZD403'), ('nina', 401, 'ZD403'), ('tomo', 401, 'ZD403'),
  ('lea', 401, 'ZD403'), ('petra', 401, 'ZD403'), ('anon', 401, 'ZD401')
) AS c (actor, days, outcome);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM institution.deadline_extensions({z1})'), 1, 5), c.result,
  format('SRV-1108: %s lists the extensions of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '1'), ('marko', 'ZD403'), ('ana', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401'))
  AS c (actor, result);

-- 1i2. SRV-NF4-IZNIMKA-ZAPIS: the exception of a late submission for one
-- student (institution.late_submission_exception) only through its RPCs; the
-- teacher of Z1 grants and lists, only Ana reads her own, everyone else is the
-- same refusal. The rest is in 252-late-submission-exception.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT ''ok'' FROM institution.grant_late_submission_exception({z1}, {ana}, now() + interval ''500 days'', ''justified'')'), 1, 5), c.outcome,
  format('SRV-NF4-IZNIMKA-ZAPIS: %s grants Ana a late-submission exception on Z1: %s', c.actor, c.outcome))
FROM (VALUES
  ('vesna', 'ok'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'),
  ('dora', 'ZD403'), ('boris', 'ZD403'), ('nina', 'ZD403'), ('tomo', 'ZD403'),
  ('lea', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, outcome);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM institution.late_submission_exceptions({z1})'), 1, 5), c.result,
  format('SRV-NF4-IZNIMKA-ZAPIS: %s lists the late-submission exceptions of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '1'), ('marko', 'ZD403'), ('ana', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401'))
  AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM institution.student_late_submission_exceptions({z1})'), 1, 5), c.result,
  format('SRV-NF4-IZNIMKA-ZAPIS: %s reads only the own late-submission exceptions of Z1: %s', c.actor, c.result))
FROM (VALUES ('ana', '1'), ('dora', '0'), ('vesna', 'ZD403'), ('marko', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401'))
  AS c (actor, result);

-- 1i3. SRV-V19-GRUPA-BAZA: teams on an assignment (institution.assignment_team_setting,
-- work_team, work_team_member_event) only through the app.* RPCs. The teachers of Z1 read
-- and set the setting and list the teams, the students of Z1 read only their own state;
-- everyone else is the same refusal (ZD404: another course, another institution, no
-- relation). The rest is in 248-work-team.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT enabled::text FROM app.assignment_team_setting({z1})'), 1, 5), c.result,
  format('SRV-V19-GRUPA-BAZA: %s reads the team setting of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'false'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.teacher_teams({z1})'), 1, 5), c.result,
  format('SRV-V19-GRUPA-BAZA: %s lists the teams of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '2'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT row_kind FROM app.student_team({z1})'), 1, 5), c.result,
  format('SRV-V19-GRUPA-BAZA: %s reads the own team state on Z1: %s', c.actor, c.result))
FROM (VALUES ('ana', 'disab'), ('dora', 'disab'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'),
             ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.set_assignment_team_setting({z1}, false, 2, 6, ''student_choice'')'), 1, 5), c.result,
  format('SRV-V19-GRUPA-BAZA: %s sets the team setting of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '1'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.team_action({z1}, ''leave'', NULL)'), 1, 5), c.result,
  format('SRV-V19-GRUPA-BAZA: only a student of Z1 acts on a team (%s): %s', c.actor, c.result))
FROM (VALUES ('ana', 'ZD409'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('boris', 'ZD404'),
             ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);

-- 1i3b. SRV-V19-RECENZIJA-BAZA: anonymous peer review (institution.peer_review_round,
-- peer_review_allocation, peer_review, peer_review_withdrawal) only through the app.* RPCs.
-- The teachers of Z1 set the round, allocate, read the overview and withdraw; the students
-- of Z1 read only their own tasks and the reviews of their own work; everyone else is the
-- same refusal (ZD404: another course, another institution, no relation; an unknown task).
-- The rest is in 249-peer-review.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT state FROM app.peer_review_round({z1})'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s reads the review round of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'none'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.set_peer_review_round({z1}, now(), now() + interval ''1 day'', 0, ''[]'')'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s sets the review round of Z1 (refused input, the relation first): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD422'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.peer_review_overview({z1})'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s reads the review overview of Z1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.allocate_peer_review({z1})'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s allocates the review of Z1 (no round yet): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.withdraw_peer_review({z1}, gen_random_uuid(), ''Razlog.'')'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s withdraws a review of Z1 (an unknown one): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT round_state FROM app.peer_review_tasks({z1})'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s reads the own review tasks of Z1: %s', c.actor, c.result))
FROM (VALUES ('ana', 'none'), ('dora', 'none'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'),
             ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.peer_reviews_received({z1})'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s reads the received reviews of Z1: %s', c.actor, c.result))
FROM (VALUES ('ana', '0'), ('dora', '0'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'),
             ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.peer_review_work(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s reads the work of an unknown review task: %s', c.actor, c.result))
FROM (VALUES ('ana', 'ZD404'), ('dora', 'ZD404'), ('boris', 'ZD404'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.add_peer_review(gen_random_uuid(), ''[]'', NULL)'), 1, 5), c.result,
  format('SRV-V19-RECENZIJA-BAZA: %s writes a review of an unknown task: %s', c.actor, c.result))
FROM (VALUES ('ana', 'ZD404'), ('dora', 'ZD404'), ('boris', 'ZD404'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);

-- 1i3c. SRV-V18-UPITNIK-BAZA: questionnaires (institution.questionnaire, questionnaire_question,
-- questionnaire_response, questionnaire_answer, questionnaire_participation) only through the app.*
-- RPCs. The teachers of K1 make and read; the students of K1 answer once; everyone else, an unknown
-- id and a questionnaire that is not open for a student are the same refusal (ZD404). The rest,
-- including the sheet that carries no person, is in 247-questionnaire.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.teacher_questionnaires({k1})'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s lists the questionnaires of K1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.create_questionnaire({k1}, ''Naslov'', ''[]'')'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s makes a questionnaire in K1 (refused input, the relation first): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD422'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.teacher_questionnaire(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s reads an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.update_questionnaire(gen_random_uuid(), ''Naslov'', ''[]'')'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s edits an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.set_questionnaire_state(gen_random_uuid(), ''open'')'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s sets the state of an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.manual_questionnaire_response(gen_random_uuid(), ''[]'')'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s enters a sheet into an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.questionnaire_answer_rows(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s reads the answers of an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.questionnaire_response_ids(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s reads the sheets of an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.student_questionnaire(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s reads the form of an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.submit_questionnaire_response(gen_random_uuid(), ''[]'')'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s answers an unknown questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.student_questionnaires()'), 1, 5), c.result,
  format('SRV-V18-UPITNIK-BAZA: %s lists open questionnaires: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('marko', '0'), ('iva', '0'), ('ana', '0'), ('dora', '0'), ('boris', '0'), ('nina', '0'),
             ('tomo', '0'), ('lea', '0'), ('petra', '0'), ('anon', 'ZD401')) AS c (actor, result);

-- 1i3d. SRV-V18-KODIRANJE-BAZA: the coding material, the codebook and the marked passages of a
-- person (institution.qual_material, qual_code, qual_segment) only through the app.* RPCs, and
-- only the owner's: nobody has anything of another's, so the lists are empty, an unknown id is the
-- same refusal (ZD404) and refused input is told only to a person with a session. The rest
-- (the owner's own cells, the order of the codebook, the anchor) is in 248-qualitative-coding.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.qual_materials()'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s lists their coding materials: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('marko', '0'), ('iva', '0'), ('ana', '0'), ('dora', '0'),
             ('boris', '0'), ('nina', '0'), ('tomo', '0'), ('lea', '0'), ('petra', '0'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.qual_codes()'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s lists their codebook: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('marko', '0'), ('iva', '0'), ('ana', '0'), ('dora', '0'),
             ('boris', '0'), ('nina', '0'), ('tomo', '0'), ('lea', '0'), ('petra', '0'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.qual_export_segments(NULL)'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s exports their marked passages: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('marko', '0'), ('iva', '0'), ('ana', '0'), ('dora', '0'),
             ('boris', '0'), ('nina', '0'), ('tomo', '0'), ('lea', '0'), ('petra', '0'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.create_qual_material('''', ''note'', ''Tekst'')'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s keeps a material with no title (refused input, the session first): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD422'), ('marko', 'ZD422'), ('iva', 'ZD422'), ('ana', 'ZD422'), ('dora', 'ZD422'),
             ('boris', 'ZD422'), ('nina', 'ZD422'), ('tomo', 'ZD422'), ('lea', 'ZD422'), ('petra', 'ZD422'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.create_qual_code('''', '''')'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s makes a code with no name (refused input, the session first): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD422'), ('marko', 'ZD422'), ('iva', 'ZD422'), ('ana', 'ZD422'), ('dora', 'ZD422'),
             ('boris', 'ZD422'), ('nina', 'ZD422'), ('tomo', 'ZD422'), ('lea', 'ZD422'), ('petra', 'ZD422'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.qual_material(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s reads an unknown coding material: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.delete_qual_material(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s deletes an unknown coding material: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.update_qual_code(gen_random_uuid(), ''Naziv'', '''')'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s renames an unknown code: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.move_qual_code(gen_random_uuid(), 1)'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s moves an unknown code: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.delete_qual_code(gen_random_uuid(), true)'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s deletes an unknown code: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.create_qual_segment(gen_random_uuid(), gen_random_uuid(), 0, 0, 1, ''x'', NULL)'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s marks a passage of an unknown material: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.qual_segments(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s reads the passages of an unknown material: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.delete_qual_segment(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s removes an unknown passage: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT 1 FROM app.qual_export_segments(gen_random_uuid())'), 1, 5), c.result,
  format('SRV-V18-KODIRANJE-BAZA: %s exports an unknown material: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('iva', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'),
             ('boris', 'ZD404'), ('nina', 'ZD404'), ('tomo', 'ZD404'), ('lea', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);

-- 1i3e. SRV-ASIST-PREKIDAC: the assistant switch per course
-- (institution.course_assistant_setting) only through its RPCs: the teacher of
-- K1 reads and sets it, the students of Z1 read only the availability, everyone
-- else is refused. The rest is in 254-assistant-course-switch.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT enabled::text FROM app.course_assistant_switch_read({k1})'), 1, 5), c.result,
  format('SRV-ASIST-PREKIDAC: %s reads the assistant switch of K1: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'true'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
             ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT enabled::text FROM app.course_assistant_switch({k1}, true)'), 1, 5), c.result,
  format('SRV-ASIST-PREKIDAC: %s sets the assistant switch of K1 (to the value in force): %s', c.actor, c.result))
FROM (VALUES ('vesna', 'true'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
             ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT outcome FROM app.my_assistant_available({z1})'), 1, 9), c.result,
  format('SRV-ASIST-PREKIDAC: %s reads the assistant availability of Z1: %s', c.actor, c.result))
FROM (VALUES ('ana', 'found'), ('dora', 'found'), ('vesna', 'not_found'), ('marko', 'not_found'), ('boris', 'not_found'),
             ('iva', 'not_found'), ('tomo', 'not_found'), ('petra', 'not_found'), ('anon', 'ZD401: no')) AS c (actor, result);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.course_assistant_switch(uuid,boolean)', 'app.course_assistant_switch_read(uuid)',
       'app.my_assistant_available(uuid)', 'app.assistant_cost_published(uuid)', 'app.course_assistant_on(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-ASIST-PREKIDAC: only ductus_app and the owner execute the switch RPCs'
);
SELECT ok((SELECT bool_and(p.prosecdef AND has_function_privilege('ductus_app', f, 'EXECUTE') = (f NOT IN ('app.assistant_cost_published(uuid)', 'app.course_assistant_on(uuid)')))
             FROM unnest(ARRAY['app.course_assistant_switch(uuid,boolean)', 'app.course_assistant_switch_read(uuid)',
               'app.my_assistant_available(uuid)', 'app.assistant_cost_published(uuid)', 'app.course_assistant_on(uuid)']) f
             JOIN pg_proc p ON p.oid = f::regprocedure),
  'SRV-ASIST-PREKIDAC: the web role calls the three RPCs, not the two workers; all SECURITY DEFINER');

-- 1i. SRV-1108C: the effective deadline through app.student_effective_due_at
-- only for a student of the assignment, and only the caller's own (Ana's was
-- extended in 1h); null for everyone else. The rest is in
-- 167-submission-effective-due.sql.
SELECT is(
  coalesce(pg_temp.ask(c.actor, 'SELECT (app.student_effective_due_at({z1}) - now())::text'), 'null'), c.result,
  format('SRV-1108C: %s reads the own effective deadline of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('ana', '400 days'), ('dora', '30 days'), ('vesna', 'null'), ('marko', 'null'), ('iva', 'null'),
  ('boris', 'null'), ('nina', 'null'), ('tomo', 'null'), ('lea', 'null'), ('petra', 'null'), ('anon', 'null')
) AS c (actor, result);

-- 1i. SRV-1903: the withdrawal switch of an assignment
-- (institution.submission_withdrawal_setting) only through its RPCs, only for
-- the teacher of the assignment. The rest is in 205-submission-withdrawal.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT allowed::text FROM institution.submission_withdrawal_setting({z1})'), 1, 5),
  c.result, format('SRV-1903: %s reads the withdrawal switch of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'true'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT allowed::text FROM institution.set_submission_withdrawal({z1}, true)'), 1, 5),
  c.result, format('SRV-1903: %s sets the withdrawal switch of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'true'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);

-- 1i2. PIL-K-IZJAVA-SRV: the declaration switch of an assignment
-- (institution.assignment.declaration_required, its trail in
-- audit.declaration_required_event) only through its RPCs, only for the
-- teacher of the assignment. The rest is in 228-declaration-required.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT required::text FROM institution.declaration_required_setting({z1})'), 1, 5),
  c.result, format('PIL-K-IZJAVA-SRV: %s reads the declaration switch of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'false'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT required::text FROM institution.set_declaration_required({z1}, false)'), 1, 5),
  c.result, format('PIL-K-IZJAVA-SRV: %s sets the declaration switch of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'false'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);

-- 1i3. SRV-V13-MIG-VRSTA: the kind of document of an assignment
-- (institution.assignment.document_kind, evidence.document.document_kind).
-- Read like the rest of the assignment, written by nobody at runtime; a
-- foreign assignment is no row at all. The work rows are in
-- 046-evidence-open-work.sql.
SELECT is(
  pg_temp.ask(c.actor, $q$ SELECT coalesce((SELECT a.document_kind FROM institution.assignment a WHERE a.id = {z1}), 'no row') $q$),
  c.result, format('SRV-V13-MIG-VRSTA: %s reads the document kind of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'text'), ('marko', 'no row'), ('iva', 'no row'), ('ana', 'text'),
  ('dora', 'text'), ('tomo', 'no row'), ('petra', 'no row'), ('boris', 'no row')
) AS c (actor, result);
SELECT ok(pg_temp.ask(c.actor, $q$ UPDATE institution.assignment SET document_kind = 'slides' WHERE id = {z1} $q$)
    LIKE '42501: permission denied%',
  format('SRV-V13-MIG-VRSTA: %s cannot set the document kind of Z1', c.actor))
FROM (VALUES ('vesna'), ('iva')) AS c (actor);
SELECT is(
  (SELECT a.attnotnull::text || ' ' || pg_get_expr(d.adbin, d.adrelid) || ' ' || pg_get_constraintdef(k.oid)
     FROM pg_attribute a
     JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     JOIN pg_constraint k ON k.conrelid = a.attrelid AND k.conname = t.constraint_name
    WHERE a.attrelid = t.relation::regclass AND a.attname = 'document_kind'),
  $$true 'text'::text CHECK ((document_kind = ANY (ARRAY['text'::text, 'slides'::text])))$$,
  format('SRV-V13-MIG-VRSTA: %s.document_kind is text or slides, never null, text by default', t.relation))
FROM (VALUES ('institution.assignment', 'assignment_document_kind_check'),
             ('evidence.document', 'document_document_kind_check')) AS t (relation, constraint_name);
SELECT ok(NOT has_column_privilege('ductus_app', 'evidence.document'::regclass, 'document_kind', 'INSERT,UPDATE')
    AND NOT has_column_privilege('ductus_app', 'institution.assignment'::regclass, 'document_kind', 'INSERT,UPDATE'),
  'SRV-V13-MIG-VRSTA: the application role cannot write a document kind of an assignment or of a work');
SELECT ok(p.prosecdef AND 'search_path=""' = ANY(p.proconfig)
    AND has_function_privilege('ductus_evidence', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE'),
  'SRV-V13-MIG-VRSTA: app.assignment_document_kind is a definer bridge for the evidence role only')
  FROM pg_proc p WHERE p.oid = 'app.assignment_document_kind(uuid)'::regprocedure;
SELECT is(app.assignment_document_kind(pg_temp.id('z1')) || ' ' || app.assignment_document_kind(gen_random_uuid()),
  'text text', 'SRV-V13-MIG-VRSTA: the bridge answers text for a text assignment and for an unknown one');

-- 1i2a. SRV-NF4-KASNA-POLJE: whether a submission after the deadline is
-- allowed (institution.assignment.late_submission_allowed) is set only by the
-- teacher of the assignment and read only by a student of its course. The
-- rest is in 248-assignment-late-submission.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({z1}, true)'), 1, 5),
  c.result, format('SRV-NF4-KASNA-POLJE: %s sets late submission of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'true'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);
SELECT is(
  pg_temp.ask(c.actor, 'SELECT outcome FROM app.my_assignment_late_submission({z1})'),
  c.result, format('SRV-NF4-KASNA-POLJE: %s reads late submission of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('ana', 'found'), ('dora', 'found'), ('vesna', 'not_found'), ('marko', 'not_found'), ('boris', 'not_found'),
  ('iva', 'not_found'), ('tomo', 'not_found'), ('petra', 'not_found')
) AS c (actor, result);
-- 1i2b. SRV-NF4-KASNA-PROVEDBA: request_submission reads the field through
-- app.student_late_submission_allowed, as the evidence role, only for a
-- student of the assignment; null for everyone else. The rest is in
-- 249-late-submission-enforcement.sql.
SELECT is(
  coalesce(pg_temp.ask_as('ductus_evidence', c.actor, 'SELECT app.student_late_submission_allowed({z1})::text'), 'null'),
  c.result, format('SRV-NF4-KASNA-PROVEDBA: %s reads late submission of Z1 through the bridge: %s', c.actor, c.result))
FROM (VALUES
  ('ana', 'true'), ('dora', 'true'), ('vesna', 'null'), ('marko', 'null'), ('iva', 'null'),
  ('tomo', 'null'), ('petra', 'null'), ('anon', 'null')
) AS c (actor, result);
-- 1i2c. SRV-NF4-IZNIMKA-PREDAJA: request_submission (the evidence role) and
-- student.assignment-work.get (the web role) read the caller's own latest
-- late-submission exception through app.student_late_exception_until, only
-- for a student of the assignment (Ana's was recorded above); null for
-- everyone else, Dora included. The rest is in
-- 253-late-submission-exception-honoured.sql.
SELECT is(
  coalesce(pg_temp.ask_as(r.role, c.actor, 'SELECT (app.student_late_exception_until({z1}) > now())::text'), 'null'),
  c.result, format('SRV-NF4-IZNIMKA-PREDAJA: %s reads the own exception of Z1 as %s: %s', c.actor, r.role, c.result))
FROM (VALUES
  ('ana', 'true'), ('dora', 'null'), ('vesna', 'null'), ('marko', 'null'), ('iva', 'null'),
  ('tomo', 'null'), ('petra', 'null'), ('anon', 'null')
) AS c (actor, result)
CROSS JOIN (VALUES ('ductus_evidence'), ('ductus_app')) AS r (role);

-- 1i3. SRV-IZJAVA-PITANJE: the teacher's question with the declaration
-- (audit.declaration_question_event) only through its RPCs, only for the
-- teacher of the assignment; the answer (declaration.question_answer) only
-- for the teacher or mentor of the student's work, the owner reads hers in
-- read_statement. The rest is in 232-declaration-question.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT coalesce(question_text, ''none'') FROM institution.declaration_question_setting({z1})'), 1, 5),
  c.result, format('SRV-IZJAVA-PITANJE: %s reads the declaration question of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'none'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT coalesce(question_text, ''none'') FROM institution.set_declaration_question({z1}, NULL)'), 1, 5),
  c.result, format('SRV-IZJAVA-PITANJE: %s sets the declaration question of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'none'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT coalesce(answer::text, ''none'') FROM app.teacher_declaration_answer({z1}, {ana})'), 1, 5),
  c.result, format('SRV-IZJAVA-PITANJE: %s reads the declaration answer of Ana in Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'none'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('tomo', 'ZD403'), ('petra', 'ZD403'), ('anon', 'ZD401')
) AS c (actor, result);

SELECT is(pg_temp.ask(c.actor, 'SELECT count(*) FROM institution.student_deadline_history({z1})'), c.result,
  format('SRV-1509: %s reads only the own history of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('ana', '1'), ('dora', '0'), ('vesna', 'ZD403: forbidden'), ('marko', 'ZD403: forbidden'),
  ('iva', 'ZD403: forbidden'), ('boris', 'ZD403: forbidden'), ('nina', 'ZD403: forbidden'),
  ('tomo', 'ZD403: forbidden'), ('lea', 'ZD403: forbidden'), ('petra', 'ZD403: forbidden'),
  ('anon', 'ZD401: not authenticated')
) AS c (actor, result);

-- 1j. SRV-1110: the Merlin package (institution.merlin_package and the record
-- of its downloads, institution.merlin_package_download) only through their
-- RPCs; the web role has no privilege or policy on either table. One cell per
-- actor asking for the package of Z1 of K1; building, reading, downloading,
-- expiry and the append-only record are in 167-merlin-package-access.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, 'SELECT state FROM institution.request_merlin_package({z1}, ''kljuc-matrica'')'), 1, 6),
  c.result, format('SRV-1110: %s asks for the Merlin package of Z1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'queued'), ('marko', 'ZD403:'), ('iva', 'ZD403:'), ('ana', 'ZD403:'), ('dora', 'ZD403:'),
  ('boris', 'ZD403:'), ('nina', 'ZD403:'), ('tomo', 'ZD403:'), ('lea', 'ZD403:'), ('petra', 'ZD403:'),
  ('anon', 'ZD401:')
) AS c (actor, result);

-- 1k. SRV-1904 (P-D4): copying an assignment only through
-- institution.copy_assignment, which needs the caller to teach the source and
-- the target course. One cell per actor copying Z1 into K1; Vesna's opening
-- after the deadline passes the relation check and stops at the input, so the
-- matrix writes no assignment. The copy itself is in 206-assignment-copy.sql.
SELECT is(
  substr(pg_temp.ask(c.actor, $$ SELECT institution.copy_assignment({z1}, {k1}, gen_random_uuid(), now() + interval '2 days', now() + interval '1 day') $$), 1, 5),
  c.result, format('SRV-1904: %s copies Z1 into K1: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'ZD422'), ('marko', 'ZD403'), ('iva', 'ZD403'), ('ana', 'ZD403'), ('dora', 'ZD403'),
  ('boris', 'ZD403'), ('nina', 'ZD403'), ('tomo', 'ZD403'), ('lea', 'ZD403'), ('petra', 'ZD403'),
  ('anon', 'ZD401')
) AS c (actor, result);

-- SRV-1103: actor-level cases are in 161-work-milestone-access.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.read_work_milestones(text)', 'app.set_work_milestone_due(text,uuid,timestamptz)',
       'app.read_work_milestone_states(text)', 'app.submit_work_milestone(text,uuid)',
       'app.request_work_milestone_revision(text,uuid,text,timestamptz)', 'app.approve_work_milestone(text,uuid,text)',
       'app.change_work_milestone(text,uuid,text,timestamptz)', 'app.delete_work_milestone(text,uuid)',
       'app.read_milestone_template()', 'app.publish_milestone_template(integer,boolean,jsonb)',
       'app.read_work_milestone_plan(text)', 'app.add_work_milestone(text,text,timestamptz,text)',
       'app.apply_milestone_template_to_work(text)',
       'app.read_assignment_rubric_teacher(uuid)', 'app.read_assignment_rubric_student(uuid)',
       'app.publish_assignment_rubric(uuid,integer,jsonb)',
       'app.read_work_template(text)', 'app.publish_work_template(text,integer,jsonb,jsonb,text)',
       'app.set_assignment_template(uuid,boolean)', 'app.read_assignment_template(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-1103: only ductus_app and the owner execute the milestone RPCs'
);
-- SRV-MENTOR-2: actor-level cases are in 234-thesis-forms-consent.sql.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.read_thesis_forms()', 'app.publish_thesis_form(text,text,text[],boolean)',
       'app.read_thesis_setting()', 'app.set_thesis_setting(boolean)',
       'app.read_work_thesis_forms(text)', 'app.set_work_thesis_form_state(text,text,text)',
       'app.read_work_mentor_consent(text)', 'app.read_work_mentor_consent_events(text)',
       'app.set_work_mentor_consent(text,boolean,text)', 'app.read_work_thesis_stage(text)',
       'app.set_work_thesis_stage(text,text,timestamptz)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-MENTOR-2: only ductus_app and the owner execute the thesis form, consent and stage RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.open_practice_placement(uuid,text,date,date)',
       'app.add_practice_entry(uuid,date,numeric,text,uuid)', 'app.sign_practice_entries(uuid,date,text)',
       'app.practice_placements()', 'app.practice_entries(uuid)', 'app.practice_signoffs(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-V19-DNEVNIK-BAZA: only ductus_app and the owner execute the practice journal RPCs'
);
SELECT ok((SELECT bool_and(has_function_privilege('ductus_app', f, 'EXECUTE') AND p.prosecdef)
             FROM unnest(ARRAY['app.open_practice_placement(uuid,text,date,date)',
               'app.add_practice_entry(uuid,date,numeric,text,uuid)', 'app.sign_practice_entries(uuid,date,text)',
               'app.practice_placements()', 'app.practice_entries(uuid)', 'app.practice_signoffs(uuid)']) f
             JOIN pg_proc p ON p.oid = f::regprocedure),
  'SRV-V19-DNEVNIK-BAZA: the web role calls the practice journal RPCs, all SECURITY DEFINER');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.set_assignment_team_setting(uuid,boolean,integer,integer,text)',
       'app.assignment_team_setting(uuid)', 'app.team_action(uuid,text,uuid)', 'app.student_team(uuid)',
       'app.teacher_teams(uuid)', 'app.teacher_create_team(uuid)', 'app.teacher_team_member(uuid,uuid,uuid,text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-V19-GRUPA-BAZA: only ductus_app and the owner execute the team RPCs'
);
SELECT ok((SELECT bool_and(has_function_privilege('ductus_app', f, 'EXECUTE') AND p.prosecdef)
             FROM unnest(ARRAY['app.set_assignment_team_setting(uuid,boolean,integer,integer,text)',
               'app.assignment_team_setting(uuid)', 'app.team_action(uuid,text,uuid)', 'app.student_team(uuid)',
               'app.teacher_teams(uuid)', 'app.teacher_create_team(uuid)', 'app.teacher_team_member(uuid,uuid,uuid,text)']) f
             JOIN pg_proc p ON p.oid = f::regprocedure),
  'SRV-V19-GRUPA-BAZA: the web role calls the team RPCs, all SECURITY DEFINER');
-- The helper that reads the state of a part from the evidence is the identity role's alone.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute the team part-state helper'
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.work_team_part_states(uuid,uuid[])', 'EXECUTE') $$,
  'SRV-V19-GRUPA-BAZA: only the identity role and its owner execute the part-state helper'
);

SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.set_peer_review_round(uuid,timestamp with time zone,timestamp with time zone,integer,jsonb)',
       'app.peer_review_round(uuid)', 'app.allocate_peer_review(uuid)', 'app.peer_review_tasks(uuid)',
       'app.peer_review_work(uuid)', 'app.add_peer_review(uuid,jsonb,text)', 'app.peer_reviews_received(uuid)',
       'app.peer_review_overview(uuid)', 'app.withdraw_peer_review(uuid,uuid,text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-V19-RECENZIJA-BAZA: only ductus_app and the owner execute the review RPCs'
);
SELECT ok((SELECT bool_and(has_function_privilege('ductus_app', f, 'EXECUTE') AND p.prosecdef)
             FROM unnest(ARRAY['app.set_peer_review_round(uuid,timestamp with time zone,timestamp with time zone,integer,jsonb)',
       'app.peer_review_round(uuid)', 'app.allocate_peer_review(uuid)', 'app.peer_review_tasks(uuid)',
       'app.peer_review_work(uuid)', 'app.add_peer_review(uuid,jsonb,text)', 'app.peer_reviews_received(uuid)',
       'app.peer_review_overview(uuid)', 'app.withdraw_peer_review(uuid,uuid,text)']) f
             JOIN pg_proc p ON p.oid = f::regprocedure),
  'SRV-V19-RECENZIJA-BAZA: the web role calls the review RPCs, all SECURITY DEFINER');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.create_questionnaire(uuid,text,jsonb)', 'app.update_questionnaire(uuid,text,jsonb)', 'app.set_questionnaire_state(uuid,text)', 'app.teacher_questionnaires(uuid)', 'app.teacher_questionnaire(uuid)', 'app.student_questionnaires()', 'app.student_questionnaire(uuid)', 'app.submit_questionnaire_response(uuid,jsonb)', 'app.manual_questionnaire_response(uuid,jsonb)', 'app.questionnaire_answer_rows(uuid)', 'app.questionnaire_response_ids(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-V18-UPITNIK-BAZA: only ductus_app and the owner execute the questionnaire RPCs'
);
SELECT ok((SELECT bool_and(has_function_privilege('ductus_app', f, 'EXECUTE') AND p.prosecdef)
             FROM unnest(ARRAY['app.create_questionnaire(uuid,text,jsonb)', 'app.update_questionnaire(uuid,text,jsonb)', 'app.set_questionnaire_state(uuid,text)', 'app.teacher_questionnaires(uuid)', 'app.teacher_questionnaire(uuid)', 'app.student_questionnaires()', 'app.student_questionnaire(uuid)', 'app.submit_questionnaire_response(uuid,jsonb)', 'app.manual_questionnaire_response(uuid,jsonb)', 'app.questionnaire_answer_rows(uuid)', 'app.questionnaire_response_ids(uuid)']) f
             JOIN pg_proc p ON p.oid = f::regprocedure),
  'SRV-V18-UPITNIK-BAZA: the web role calls the questionnaire RPCs, all SECURITY DEFINER');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.create_qual_material(text,text,text)', 'app.qual_materials()', 'app.qual_material(uuid)', 'app.delete_qual_material(uuid)', 'app.create_qual_code(text,text)', 'app.qual_codes()', 'app.update_qual_code(uuid,text,text)', 'app.move_qual_code(uuid,integer)', 'app.delete_qual_code(uuid,boolean)', 'app.create_qual_segment(uuid,uuid,integer,integer,integer,text,text)', 'app.qual_segments(uuid)', 'app.delete_qual_segment(uuid)', 'app.qual_export_segments(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-V18-KODIRANJE-BAZA: only ductus_app and the owner execute the coding RPCs'
);
SELECT ok((SELECT bool_and(has_function_privilege('ductus_app', f, 'EXECUTE') AND p.prosecdef)
             FROM unnest(ARRAY['app.create_qual_material(text,text,text)', 'app.qual_materials()', 'app.qual_material(uuid)', 'app.delete_qual_material(uuid)', 'app.create_qual_code(text,text)', 'app.qual_codes()', 'app.update_qual_code(uuid,text,text)', 'app.move_qual_code(uuid,integer)', 'app.delete_qual_code(uuid,boolean)', 'app.create_qual_segment(uuid,uuid,integer,integer,integer,text,text)', 'app.qual_segments(uuid)', 'app.delete_qual_segment(uuid)', 'app.qual_export_segments(uuid)']) f
             JOIN pg_proc p ON p.oid = f::regprocedure),
  'SRV-V18-KODIRANJE-BAZA: the web role calls the coding RPCs, all SECURITY DEFINER');
-- The helpers that read the submissions and the text from the evidence are the identity role's alone.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.peer_review_submitted(uuid)', 'app.peer_review_blocks(uuid,uuid)',
                             'app.peer_review_document(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'SRV-V19-RECENZIJA-BAZA: only the identity role and its owner execute the evidence helpers of the review'
);

-- 2. Role by table by operation, as it is migrated. Each cell runs the
-- statement as that role and reports why it stopped.
CREATE FUNCTION pg_temp.probe(p_role text, p_actor text, p_table text, p_op text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_column text;
  v_result text;
BEGIN
  SELECT attname INTO STRICT v_column FROM pg_attribute
   WHERE attrelid = ('institution.' || p_table)::regclass AND attnum = 1;
  v_result := pg_temp.ask_as(p_role, p_actor, CASE p_op
    WHEN 'SELECT' THEN format('SELECT ''rows='' || count(*) FROM institution.%I', p_table)
    WHEN 'INSERT' THEN format(
      'WITH x AS (INSERT INTO institution.%I DEFAULT VALUES RETURNING 1) SELECT ''rows='' || count(*) FROM x', p_table)
    WHEN 'UPDATE' THEN format(
      'WITH x AS (UPDATE institution.%I SET %I = DEFAULT RETURNING 1) SELECT ''rows='' || count(*) FROM x', p_table, v_column)
    WHEN 'DELETE' THEN format(
      'WITH x AS (DELETE FROM institution.%I RETURNING 1) SELECT ''rows='' || count(*) FROM x', p_table)
  END);
  RETURN CASE
    WHEN v_result LIKE '42501: permission denied for schema %' THEN 'no schema privilege'
    WHEN v_result LIKE '42501: permission denied for table %' THEN 'no table privilege'
    WHEN v_result LIKE '42501: new row violates row-level security policy %' THEN 'refused by RLS'
    ELSE v_result
  END;
END
$$;

CREATE TEMP TABLE cell AS
SELECT r.role, t.tbl, o.op, r.n AS role_n, t.n AS tbl_n, o.n AS op_n
FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence',
                  'ductus_migrator', 'ductus_test_stranger']) WITH ORDINALITY AS r (role, n)
CROSS JOIN unnest(ARRAY['institution_settings', 'institution_role', 'course', 'course_enrollment_code',
                        'course_member', 'enrollment_attempt', 'assignment', 'assignment_version',
                        'notice_acknowledgment', 'faculty_work_rule', 'mentorship', 'notification',
                        'course_holder', 'course_assistant', 'seminar_group', 'seminar_group_teacher', 'seminar_group_member',
                        'course_editor', 'team_substitution', 'work_grant', 'mentorship_request',
                        'faculty_rule_version', 'work_language_override', 'work_accommodation',
                        'notice_read', 'work_source', 'source_note', 'work_attachment', 'source_proof', 'deadline_extension', 'late_submission_exception',
                        'merlin_package', 'merlin_package_download', 'consultation_slot', 'work_milestone',
                        'work_milestone_deadline', 'work_milestone_progress', 'work_milestone_event', 'milestone_template_version', 'assignment_rubric_version', 'work_template_version', 'assignment_template_pin', 'mentor_note', 'submission_withdrawal_setting',
                        'work_interview', 'work_interview_question', 'work_interview_explanation', 'work_interview_note',
                        'thesis_form', 'thesis_setting', 'work_thesis_form_event', 'work_mentor_consent_event', 'work_thesis_stage_event',
                        'mentorship_opening', 'practice_placement', 'practice_entry', 'practice_signoff',
                        'assignment_team_setting', 'work_team', 'work_team_member_event', 'peer_review_round', 'peer_review_allocation', 'peer_review', 'peer_review_withdrawal', 'questionnaire', 'questionnaire_question', 'questionnaire_response', 'questionnaire_answer', 'questionnaire_participation', 'qual_material', 'qual_code', 'qual_segment',
                        'course_assistant_setting'])
                        WITH ORDINALITY AS t (tbl, n)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) WITH ORDINALITY AS o (op, n);

SELECT is(
  pg_temp.probe(role, 'anon', tbl, op),
  CASE WHEN role = 'ductus_app' AND op = 'SELECT' AND tbl NOT IN ('enrollment_attempt', 'faculty_work_rule', 'notification', 'work_source', 'source_note', 'work_attachment', 'source_proof', 'deadline_extension', 'late_submission_exception', 'merlin_package', 'merlin_package_download', 'consultation_slot', 'work_milestone', 'work_milestone_deadline', 'work_milestone_progress', 'work_milestone_event', 'milestone_template_version', 'assignment_rubric_version', 'work_template_version', 'assignment_template_pin', 'course_assistant', 'submission_withdrawal_setting', 'work_interview', 'work_interview_question', 'work_interview_explanation', 'work_interview_note', 'thesis_form', 'thesis_setting', 'work_thesis_form_event', 'work_mentor_consent_event', 'work_thesis_stage_event', 'mentorship_opening', 'practice_placement', 'practice_entry', 'practice_signoff', 'assignment_team_setting', 'work_team', 'work_team_member_event', 'peer_review_round', 'peer_review_allocation', 'peer_review', 'peer_review_withdrawal', 'questionnaire', 'questionnaire_question', 'questionnaire_response', 'questionnaire_answer', 'questionnaire_participation', 'qual_material', 'qual_code', 'qual_segment', 'course_assistant_setting') THEN 'rows=0'
       WHEN role IN ('ductus_app', 'ductus_migrator') THEN 'no table privilege'
       ELSE 'no schema privilege' END,
  format('%s: %s on %s', role, op, tbl)
)
FROM cell ORDER BY role_n, tbl_n, op_n;

-- The owner role holds every privilege and, with RLS forced, reads through
-- its own policy. It cannot log in; only the functions act as it.
SELECT ok(
  has_table_privilege('ductus_identity', ('institution.' || tbl)::regclass, op),
  format('ductus_identity (owner): %s on %s', op, tbl)
)
FROM cell WHERE role = 'ductus_app' ORDER BY tbl_n, op_n;
SELECT is(
  pg_temp.ask_as('ductus_identity', 'anon', 'SELECT count(*) FROM institution.course'), '3',
  'ductus_identity reads through the owner policy'
);

-- 3. Who sees what through ductus_app. One line per actor: every row the
-- session can read in the eight readable tables. A version reads as
-- assignment.number, an acknowledgment as assignment.number.student.
CREATE FUNCTION pg_temp.sees(p_actor text) RETURNS text
LANGUAGE sql AS $f$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT concat_ws(' | ',
      'courses: ' || coalesce((SELECT string_agg(c.name, ' ' ORDER BY c.name) FROM institution.course c), '-'),
      'members: ' || coalesce((
        SELECT string_agg(k.name || '.' || p.name || CASE WHEN m.member_to IS NULL THEN '' ELSE '(ended)' END,
                          ' ' ORDER BY k.name, p.name)
        FROM institution.course_member m
        JOIN ref k ON k.val = m.course_id::text
        JOIN person p ON p.id = m.user_id), '-'),
      'codes: ' || (SELECT count(*) FROM institution.course_enrollment_code),
      'roles: ' || coalesce((
        SELECT string_agg(p.name || '.' || r.role, ' ' ORDER BY p.name)
        FROM institution.institution_role r JOIN person p ON p.id = r.user_id), '-'),
      'settings: ' || coalesce((SELECT string_agg(s.display_name, ' ') FROM institution.institution_settings s), '-'),
      'assignments: ' || coalesce((
        SELECT string_agg(z.name, ' ' ORDER BY z.name)
        FROM institution.assignment a JOIN ref z ON z.val = a.id::text), '-'),
      'versions: ' || coalesce((
        SELECT string_agg(z.name || '.' || v.version_no, ' ' ORDER BY z.name, v.version_no)
        FROM institution.assignment_version v JOIN ref z ON z.val = v.assignment_id::text), '-'),
      'acks: ' || coalesce((
        SELECT string_agg(z.name || '.' || n.version_no || '.' || p.name, ' ' ORDER BY z.name, n.version_no, p.name)
        FROM institution.notice_acknowledgment n
        JOIN ref z ON z.val = n.assignment_id::text
        JOIN person p ON p.id = n.student_id), '-'))
  $q$)
$f$;
-- What a session with no part in any course reads of part 2.
CREATE FUNCTION pg_temp.none() RETURNS text
LANGUAGE sql AS $$ SELECT ' | assignments: - | versions: - | acks: -' $$;

SELECT is(pg_temp.sees(v.actor), v.expected, v.actor || ': ' || v.note)
FROM (VALUES
  (1, 'vesna', 'courses: K1 | members: k1.ana k1.dora k1.vesna | codes: 2 | roles: - | settings: -'
               ' | assignments: z1 | versions: z1.1 z1.2 | acks: z1.1.ana z1.1.dora z1.2.ana',
   'teacher of K1 sees K1, all its members, its codes, its assignment with both versions and every acknowledgment'),
  (2, 'marko', 'courses: K2 | members: k2.marko | codes: 1 | roles: - | settings: -'
               ' | assignments: z2 | versions: z2.1 | acks: -',
   'teacher of another course sees nothing of K1, its assignment included'),
  (3, 'ana', 'courses: K1 | members: k1.ana k1.vesna | codes: 0 | roles: - | settings: -'
             ' | assignments: z1 | versions: z1.1 z1.2 | acks: z1.1.ana z1.2.ana',
   'student sees the course, the teacher, the own membership, the assignment and the own acknowledgments, not Dora and no code'),
  (4, 'dora', 'courses: K1 | members: k1.dora k1.vesna | codes: 0 | roles: - | settings: -'
              ' | assignments: z1 | versions: z1.1 z1.2 | acks: z1.1.dora',
   'the other student likewise sees nothing of Ana, her acknowledgments included'),
  (5, 'boris', 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(),
   'student of the same institution outside K1 sees nothing'),
  (6, 'nina', 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(),
   'unconfirmed teacher role opens nothing, not even the own role row'),
  (7, 'iva', 'courses: - | members: - | codes: 0 | roles: iva.admin marko.teacher nina.teacher vesna.teacher | settings: Fakultet A (test)'
             || pg_temp.none(),
   'administrator sees roles and settings of the own institution, no course, member, assignment or acknowledgment'),
  (8, 'lea', 'courses: - | members: - | codes: 0 | roles: lea.admin petra.teacher | settings: Fakultet B (test)'
             || pg_temp.none(),
   'administrator of another institution sees nothing of fak-a'),
  (9, 'petra', 'courses: K3 | members: k3.petra k3.tomo | codes: 1 | roles: - | settings: -'
               ' | assignments: z3 | versions: z3.1 | acks: z3.1.tomo',
   'teacher at another institution sees only K3 and what belongs to it'),
  (10, 'tomo', 'courses: K3 | members: k3.petra k3.tomo | codes: 0 | roles: - | settings: -'
               ' | assignments: z3 | versions: z3.1 | acks: z3.1.tomo',
   'student at another institution sees only K3 and what belongs to it'),
  (11, 'anon', 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(), 'no session sees nothing'),
  (12, 'expired', 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(), 'expired session of Ana sees nothing'),
  (13, 'closed', 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(), 'closed session of Ana sees nothing'),
  (14, 'unknown', 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(), 'token of no session sees nothing')
) AS v (n, actor, expected, note)
ORDER BY v.n;

-- The answer for a course one may not see is the answer for no course.
SELECT is(
  pg_temp.ask('boris', $$ SELECT count(*) FROM institution.course WHERE id = {k1} $$),
  pg_temp.ask('boris', $$ SELECT count(*) FROM institution.course WHERE id = {nobody} $$),
  'Boris: K1 by id reads the same as a course that does not exist'
);
SELECT is(
  pg_temp.ask('boris', $$ SELECT coalesce(institution.actor_course_role({k1}), 'null') $$),
  pg_temp.ask('boris', $$ SELECT coalesce(institution.actor_course_role({nobody}), 'null') $$),
  'Boris: actor_course_role is null for K1 and for a course that does not exist alike'
);
SELECT is(
  pg_temp.ask(v.actor, $$ SELECT concat_ws(' ', coalesce(institution.actor_course_role({k1}), 'null'),
                                 institution.actor_has_role('teacher')::text,
                                 institution.actor_has_role('admin')::text) $$),
  v.expected, v.actor || ': part in K1, teacher role, administrator role'
)
FROM (VALUES
  (1, 'vesna', 'teacher true false'), (2, 'ana', 'student false false'), (3, 'marko', 'null true false'),
  (4, 'iva', 'null false true'), (5, 'nina', 'null false false'), (6, 'lea', 'null false true'),
  (7, 'anon', 'null false false'), (8, 'expired', 'null false false'), (9, 'closed', 'null false false')
) AS v (n, actor, expected)
ORDER BY v.n;
-- The same for an assignment, its versions and its acknowledgments.
SELECT is(
  pg_temp.ask(v.actor, format($$ SELECT concat_ws(' ',
    (SELECT count(*) FROM institution.assignment WHERE id = %1$s),
    (SELECT count(*) FROM institution.assignment_version WHERE assignment_id = %1$s),
    (SELECT count(*) FROM institution.notice_acknowledgment WHERE assignment_id = %1$s),
    coalesce(institution.actor_assignment_role(%1$s), 'null'),
    institution.has_acknowledged_current(%1$s)::text) $$, v.assignment)),
  v.expected, format('%s: %s by id (assignment, versions, acknowledgments, part in it, current version acknowledged)', v.actor, v.assignment)
)
FROM (VALUES
  (1, 'vesna', '{z1}', '1 2 3 teacher false'), (2, 'ana', '{z1}', '1 2 2 student true'),
  (3, 'dora', '{z1}', '1 2 1 student false'), (4, 'boris', '{z1}', '0 0 0 null false'),
  (5, 'boris', '{nobody}', '0 0 0 null false'), (6, 'marko', '{z1}', '0 0 0 null false'),
  (7, 'iva', '{z1}', '0 0 0 null false'), (8, 'lea', '{z1}', '0 0 0 null false'),
  (9, 'tomo', '{z1}', '0 0 0 null false'), (10, 'ana', '{z2}', '0 0 0 null false'),
  (11, 'anon', '{z1}', '0 0 0 null false'), (12, 'expired', '{z1}', '0 0 0 null false'),
  (13, 'closed', '{z1}', '0 0 0 null false')
) AS v (n, actor, assignment, expected)
ORDER BY v.n;
SELECT is(
  pg_temp.ask('vesna', 'SELECT encode(code_hash, ''hex'') FROM institution.course_enrollment_code LIMIT 1'),
  '42501: permission denied for table course_enrollment_code',
  'Vesna: the hash of her own course''s code is not readable'
);

-- 4. Nobody raises the own role or writes a table directly (plan 10 and 13).
SELECT is(
  pg_temp.ask('ana', $$ UPDATE institution.course_member SET role = 'teacher' WHERE user_id = {ana} $$),
  '42501: permission denied for table course_member', 'Ana cannot make herself a teacher of K1'
);
SELECT is(
  pg_temp.ask('ana', $$ INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_at)
                        VALUES ({fak_a}, {ana}, 'teacher', now()) $$),
  '42501: permission denied for table institution_role', 'Ana cannot give herself the teacher role'
);
SELECT is(
  pg_temp.ask('boris', $$ INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
                          VALUES ({k1}, {fak_a}, {boris}, 'student') $$),
  '42501: permission denied for table course_member', 'Boris cannot add himself to K1 without the code'
);
SELECT is(
  pg_temp.ask('vesna', $$ DELETE FROM institution.course_member WHERE user_id = {ana} $$),
  '42501: permission denied for table course_member', 'Vesna cannot delete a membership row; history stays'
);
SELECT is(
  pg_temp.ask(v.actor, v.statement), '42501: permission denied for table ' || v.tbl,
  v.actor || ' cannot ' || v.what
)
FROM (VALUES
  (1, 'dora', 'notice_acknowledgment', 'acknowledge by writing the row herself',
   $$ INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id) VALUES ({z1}, 2, {dora}) $$),
  (2, 'ana', 'notice_acknowledgment', 'take her acknowledgment back',
   $$ DELETE FROM institution.notice_acknowledgment WHERE student_id = {ana} $$),
  (3, 'vesna', 'notice_acknowledgment', 'acknowledge in the name of a student',
   $$ INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id) VALUES ({z1}, 2, {dora}) $$),
  (4, 'vesna', 'assignment_version', 'rewrite a version of her own assignment',
   $$ UPDATE institution.assignment_version SET title = 'Drugi naslov' WHERE assignment_id = {z1} $$),
  (5, 'vesna', 'assignment', 'move the pointer of her assignment back to the first version',
   $$ UPDATE institution.assignment SET current_version = 1 WHERE id = {z1} $$),
  (6, 'marko', 'assignment', 'put an assignment into a course of another teacher',
   $$ INSERT INTO institution.assignment (course_id, created_by) VALUES ({k1}, {marko}) $$)
) AS v (n, actor, tbl, what, statement)
ORDER BY v.n;

-- SRV-7E: the app's settings RPC reads the session institution and gives
-- each account only the settings it may see.
INSERT INTO settings.value (level, institution_id, key, value) VALUES
  ('institution', pg_temp.id('fak_a'), 'citation.style', '"apa"'),
  ('institution', pg_temp.id('fak_a'), 'lekta.profile', '"demo-profile-a"'),
  ('institution', pg_temp.id('fak_a'), 'thresholds.paste_event_chars', '250'),
  ('institution', pg_temp.id('fak_b'), 'citation.style', '"chicago"');

SELECT is(pg_temp.ask(m.actor, $$
  SELECT string_agg(concat_ws(':', CASE WHEN editor_only THEN 'editor' ELSE 'full' END, key, value), ', ' ORDER BY key)
  FROM settings.read_institution_values()
$$), m.expected, format('SRV-7E: settings scope for %s', m.actor))
FROM (VALUES
  ('iva', 'full:citation.style:"apa", full:lekta.profile:"demo-profile-a", full:thresholds.paste_event_chars:250'),
  ('ana', 'editor:citation.style:"apa", editor:lekta.profile:"demo-profile-a"'),
  ('vesna', 'editor:citation.style:"apa", editor:lekta.profile:"demo-profile-a"'),
  ('lea', 'full:citation.style:"chicago"'),
  ('tomo', 'editor:citation.style:"chicago"'),
  ('nina', 'ZD403: not allowed'),
  ('boris', 'ZD403: not allowed'),
  ('closed', 'ZD401: not authenticated'),
  ('anon', 'ZD401: not authenticated')
) AS m(actor, expected);

SELECT ok((SELECT prosecdef AND proowner = 'ductus_identity'::regrole AND provolatile = 's'
                  AND proconfig = ARRAY['search_path=""']::text[]
           FROM pg_proc WHERE oid = 'settings.read_institution_values()'::regprocedure),
          'SRV-7E: settings RPC is a confined STABLE definer');

-- 5. Removal works at once: no cached decision (plan 19).
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('ana');
SELECT is(
  pg_temp.sees('ana'), 'courses: - | members: k1.ana(ended) | codes: 0 | roles: - | settings: -' || pg_temp.none(),
  'unenrolled student: K1, its teacher, its assignment and her acknowledgments are gone at once; only the own ended membership remains'
);
SELECT is(
  pg_temp.sees('vesna'), 'courses: K1 | members: k1.ana(ended) k1.dora k1.vesna | codes: 2 | roles: - | settings: -'
                         ' | assignments: z1 | versions: z1.1 z1.2 | acks: z1.1.ana z1.1.dora z1.2.ana',
  'the teacher still sees the ended membership and what that student acknowledged'
);
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('vesna');
SELECT is(
  pg_temp.sees('vesna'), 'courses: - | members: k1.vesna(ended) | codes: 0 | roles: - | settings: -' || pg_temp.none(),
  'removed teacher: course, members, codes, assignment, versions and acknowledgments are gone at once'
);
SELECT is(
  pg_temp.sees('dora'), 'courses: K1 | members: k1.dora | codes: 0 | roles: - | settings: -'
                        ' | assignments: z1 | versions: z1.1 z1.2 | acks: z1.1.dora',
  'a student no longer sees the removed teacher, and keeps the assignment'
);
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('marko');
SELECT is(
  pg_temp.sees('marko'), 'courses: - | members: k2.marko | codes: 0 | roles: - | settings: -' || pg_temp.none(),
  'teacher whose role the institution revoked: an open membership alone opens nothing, the assignment of K2 included'
);
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('iva');
SELECT is(
  pg_temp.sees('iva'), 'courses: - | members: - | codes: 0 | roles: - | settings: -' || pg_temp.none(),
  'administrator whose role was revoked sees nothing'
);

SELECT is(pg_temp.ask(a.actor, 'SELECT count(*)::text FROM settings.read_institution_values()'),
          'ZD403: not allowed', format('SRV-7E: settings denied immediately after revocation for %s', a.actor))
FROM unnest(ARRAY['ana', 'marko', 'iva']) AS a(actor);

-- 6. Grants by mistake (docs/TESTING.md 5). Every role gets the schema and
-- every privilege on every table; what still holds is RLS itself. Vesna is
-- made a teacher of K1 again so that her session has rows to aim at.
UPDATE institution.course_member SET member_to = NULL WHERE user_id = pg_temp.id('vesna');
GRANT USAGE ON SCHEMA institution
  TO ductus_app, ductus_worker, ductus_retention, ductus_auth, ductus_evidence, ductus_migrator, ductus_test_stranger;
GRANT ALL ON ALL TABLES IN SCHEMA institution
  TO ductus_app, ductus_worker, ductus_retention, ductus_auth, ductus_evidence, ductus_migrator, ductus_test_stranger;

SELECT is(
  pg_temp.probe(role, 'anon', tbl, op),
  CASE op WHEN 'INSERT' THEN 'refused by RLS' ELSE 'rows=0' END,
  format('mistaken grant, %s: %s on %s', role, op, tbl)
)
FROM cell ORDER BY role_n, tbl_n, op_n;
SELECT is(
  pg_temp.probe('ductus_app', 'boris', tbl, 'SELECT'), 'rows=0',
  format('mistaken grant, Boris: SELECT on %s still returns no row', tbl)
)
FROM cell WHERE role = 'ductus_app' AND op = 'SELECT' ORDER BY tbl_n;
SELECT is(
  pg_temp.probe('ductus_app', 'vesna', tbl, op),
  CASE op WHEN 'INSERT' THEN 'refused by RLS' ELSE 'rows=0' END,
  format('mistaken grant, Vesna as teacher of K1: %s on %s changes nothing', op, tbl)
)
FROM cell WHERE role = 'ductus_app' AND op <> 'SELECT' ORDER BY tbl_n, op_n;
SELECT is(
  (SELECT concat_ws(' ', (SELECT count(*) FROM institution.institution_settings),
                         (SELECT count(*) FROM institution.institution_role),
                         (SELECT count(*) FROM institution.course),
                         (SELECT count(*) FROM institution.course_enrollment_code),
                         (SELECT count(*) FROM institution.course_member),
                         (SELECT count(*) FROM institution.assignment),
                         (SELECT count(*) FROM institution.assignment_version),
                         (SELECT count(*) FROM institution.notice_acknowledgment))),
  '2 6 3 4 6 3 4 4',
  'after every probe the fixture rows are all still there'
);

SELECT * FROM finish();
ROLLBACK;
