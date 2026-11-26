-- DAN-1564: every table of this database has a row in the list below, which
-- names the pgTAP file that holds the table's access tests. A table that a
-- later migration adds, in any schema, fails this file until it gets a row;
-- scripts/db/matrix-coverage.test.ts then holds the row to a file that exists
-- and names the table. The same file runs in each database (db/main/tests,
-- db/logs/tests, db/legal/tests) and differs only in the list.
--
-- The tables are read from the catalogue exactly as 000-rls-everywhere.sql
-- reads them (ordinary, partitioned and foreign tables of every schema, the
-- system's own and temporary ones left out), with the same single exception:
-- public.schema_migrations, the dbmate ledger, which 000-rls-everywhere.sql
-- (and 011 in main) holds. The preamble is that file's as well.
--
-- What this proves: no table is missing from the list. It does not prove that
-- the named file tests every role and every operation on the table.
--
-- The negative controls are made inside the transaction, seen, and dropped;
-- the file rolls back, so nothing stays.
BEGIN;
-- Nothing below resolves through the caller's search path: "$user" or any
-- schema before pgTAP's could hold a planted is_empty, ok or operator. The
-- path is pg_catalog, pg_temp (so the helper views below, which are also
-- named with pg_temp., come before anything in pgTAP's schema), then the
-- schema pgTAP lives in, and nothing else. pg_temp is never searched for
-- functions or operators.
SET LOCAL search_path TO pg_catalog, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA public;
SET LOCAL lc_messages TO 'C';
-- pgTAP's schema can also hold objects that are not pgTAP's (the migrator
-- owns each database and may create in public): a function there that is not
-- part of an extension and carries the name of a pgTAP or pg_catalog
-- function, or any such operator, could change what the assertions compute.
-- This raises rather than asserts, as a planted object could bend the
-- assertion itself.
DO $$
DECLARE
  tap_schema name;
  planted text;
BEGIN
  SELECT n.nspname INTO STRICT tap_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) e.extnamespace
  WHERE e.extname OPERATOR(pg_catalog.=) 'pgtap';
  PERFORM pg_catalog.set_config('search_path', pg_catalog.format('pg_catalog, pg_temp, %I', tap_schema), true);

  SELECT pg_catalog.string_agg(x.found, ', ') INTO planted FROM (
    SELECT p.oid::pg_catalog.regprocedure::text AS found FROM pg_catalog.pg_proc p
    WHERE p.pronamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND p.pronamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) p.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                  WHERE q.proname OPERATOR(pg_catalog.=) p.proname
                    AND (q.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace
                         OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                                    WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                                      AND d.objid OPERATOR(pg_catalog.=) q.oid
                                      AND d.deptype OPERATOR(pg_catalog.=) 'e')))
    UNION ALL
    SELECT o.oid::pg_catalog.regoperator::text FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND o.oprnamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_operator'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) o.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
  ) x;
  IF planted IS NOT NULL THEN
    RAISE EXCEPTION 'a function or operator beside pgTAP shadows pgTAP or pg_catalog: %', planted;
  END IF;
END
$$;

SELECT plan(9);

CREATE VIEW pg_temp.matrix_row AS
  SELECT v.schema_name, v.table_name, v.matrix_file FROM (VALUES
    ('app', 'institution_config', '188-institution-config.sql'),
    ('app', 'registry_clerk', '184-student-data-export.sql'),
    ('app', 'student_data_export', '184-student-data-export.sql'),
    ('assistant', 'assignment_tool_setting', '173-assistant-tools.sql'),
    ('assistant', 'budget_counter', '170-assistant-access.sql'),
    ('assistant', 'conversation', '170-assistant-access.sql'),
    ('assistant', 'cost_config_version', '170-assistant-access.sql'),
    ('assistant', 'cost_ledger', '170-assistant-access.sql'),
    ('assistant', 'message', '170-assistant-access.sql'),
    ('assistant', 'request', '170-assistant-access.sql'),
    ('assistant', 'tool_loop_reservation', '173-assistant-tools.sql'),
    ('assistant', 'tool_step', '173-assistant-tools.sql'),
    ('audit', 'access_log', '080-audit-access-log.sql'),
    ('audit', 'assistant_cost_config_event', '171-assistant-rpcs.sql'),
    ('audit', 'assistant_course_switch_event', '255-assistant-course-switch.sql'),
    ('audit', 'assistant_tool_setting_event', '173-assistant-tools.sql'),
    ('audit', 'course_handover', '123-course-handover.sql'),
    ('audit', 'course_member_event', '083-audit-course-member-event.sql'),
    ('audit', 'declaration_question_event', '232-declaration-question.sql'),
    ('audit', 'declaration_required_event', '228-declaration-required.sql'),
    ('audit', 'enrollment_code_event', '082-audit-enrollment-code-event.sql'),
    ('audit', 'faculty_rule_event', '105-faculty-rule-version.sql'),
    ('audit', 'input_rhythm_course_switch_event', '030-institution-access-matrix.sql'),
    ('audit', 'input_rhythm_switch_event', '226-input-rhythm-switch.sql'),
    ('audit', 'institution_admin_event', '134-admin-appoints-admin.sql'),
    ('audit', 'institution_config_event', '188-institution-config.sql'),
    ('audit', 'late_submission_exception_event', '252-late-submission-exception.sql'),
    ('audit', 'mentorship_event', '104-mentorship-request.sql'),
    ('audit', 'network_engineer_event', '133-network-engineer-appointment.sql'),
    ('audit', 'origin_threshold_event', '224-faculty-thresholds.sql'),
    ('audit', 'teacher_role_event', '099-audit-teacher-role-event.sql'),
    ('audit', 'work_interview_event', '222-work-interview-access.sql'),
    ('collaboration', 'comment', '050-collaboration-comment.sql'),
    ('collaboration', 'comment_template', '158-teacher-notes-access.sql'),
    ('collaboration', 'comment_thread', '050-collaboration-comment.sql'),
    ('collaboration', 'consultation_addition', '163-consultation-record-access.sql'),
    ('collaboration', 'consultation_record', '163-consultation-record-access.sql'),
    ('collaboration', 'consultation_task', '236-mentorship-opening-consultations.sql'),
    ('collaboration', 'consultation_task_mark', '236-mentorship-opening-consultations.sql'),
    ('collaboration', 'direct_edit_setting', '200-teacher-direct-edit.sql'),
    ('collaboration', 'direct_edit_setting_change', '200-teacher-direct-edit.sql'),
    ('collaboration', 'import_confirmation', '208-import-event.sql'),
    ('collaboration', 'import_event', '208-import-event.sql'),
    ('collaboration', 'live_state', '051-collaboration-live-state.sql'),
    ('collaboration', 'revision_request', '110-collaboration-revision-request.sql'),
    ('collaboration', 'revision_request_version', '110-collaboration-revision-request.sql'),
    ('collaboration', 'revision_response', '110-collaboration-revision-request.sql'),
    ('collaboration', 'revision_send', '259-collaboration-revision-send.sql'),
    ('collaboration', 'self_note_key', '242-self-note-sealed.sql'),
    ('collaboration', 'suggestion', '260-collaboration-suggestion.sql'),
    ('collaboration', 'teacher_edit', '200-teacher-direct-edit.sql'),
    ('collaboration', 'teacher_note', '158-teacher-notes-access.sql'),
    ('collaboration', 'teacher_working_criterion', '165-teacher-working-criterion-access.sql'),
    ('collaboration', 'work_item_seen', '237-mentorship-self-note-overview.sql'),
    ('collaboration', 'work_message', '164-work-message-access.sql'),
    ('collaboration', 'work_review', '201-comment-delay-bank.sql'),
    ('collaboration', 'work_plan', '261-work-plan.sql'),
    ('collaboration', 'work_rubric_level', '251-work-rubric-level.sql'),
    ('collaboration', 'work_self_note', '237-mentorship-self-note-overview.sql'),
    ('declaration', 'conversation_attachment', '030-institution-access-matrix.sql'),
    ('declaration', 'external_attachment', '030-institution-access-matrix.sql'),
    ('declaration', 'question_answer', '030-institution-access-matrix.sql'),
    ('declaration', 'statement', '030-institution-access-matrix.sql'),
    ('evidence', 'assistant_match_attachment', '225-assistant-match.sql'),
    ('evidence', 'assistant_match_explanation', '230-assistant-match-explanation.sql'),
    ('evidence', 'assistant_match_finding', '225-assistant-match.sql'),
    ('evidence', 'assistant_match_setting', '225-assistant-match.sql'),
    ('evidence', 'document', '040-evidence-schema.sql'),
    ('evidence', 'document_checkpoint', '046-evidence-open-work.sql'),
    ('evidence', 'document_revision', '040-evidence-schema.sql'),
    ('evidence', 'domain', '040-evidence-schema.sql'),
    ('evidence', 'erasure', '180-erasure-tombstone.sql'),
    ('evidence', 'event_dispute', '186-event-dispute.sql'),
    ('evidence', 'fast_path_window', '085-fast-path-works.sql'),
    ('evidence', 'input_rhythm', '223-origin-rhythm.sql'),
    ('evidence', 'input_rhythm_assignment_setting', '030-institution-access-matrix.sql'),
    ('evidence', 'input_rhythm_course_setting', '030-institution-access-matrix.sql'),
    ('evidence', 'input_rhythm_setting', '030-institution-access-matrix.sql'),
    ('evidence', 'legal_hold', '030-institution-access-matrix.sql'),
    ('evidence', 'origin_change', '223-origin-rhythm.sql'),
    ('evidence', 'origin_segment', '246-origin-segments.sql'),
    ('evidence', 'package', '040-evidence-schema.sql'),
    ('evidence', 'project', '040-evidence-schema.sql'),
    ('evidence', 'receipt', '040-evidence-schema.sql'),
    ('evidence', 'reconstruction_checkpoint', '195-reconstruction-checkpoint.sql'),
    ('evidence', 'revision_restore', '227-revision-restore.sql'),
    ('evidence', 'segment', '040-evidence-schema.sql'),
    ('evidence', 'signing_key', '047-evidence-acceptance-signature.sql'),
    ('evidence', 'submission', '061-submission.sql'),
    ('evidence', 'submission_note', '147-submission-note.sql'),
    ('evidence', 'submission_receipt', '067-submission-receipt.sql'),
    ('evidence', 'submission_receipt_issuance', '063-submission-receipt-issuance.sql'),
    ('evidence', 'submission_request', '060-submission-request.sql'),
    ('evidence', 'submission_return', '206-work-return-for-revision.sql'),
    ('evidence', 'submission_withdrawal', '205-submission-withdrawal.sql'),
    ('evidence', 'submission_withdrawal_receipt', '205-submission-withdrawal.sql'),
    ('identity', 'app_admin', '130-account-kinds.sql'),
    ('identity', 'institution', '020-identity-session.sql'),
    ('identity', 'institution_issuer', '023-institution-issuer.sql'),
    ('identity', 'institution_seat', '142-institution-provisioning.sql'),
    ('identity', 'logout_token_jti', '109-backchannel-logout.sql'),
    ('identity', 'maintenance_window', '207-maintenance-window.sql'),
    ('identity', 'network_engineer_appointment', '130-account-kinds.sql'),
    ('identity', 'ops_alarm', '128-ops-alarm.sql'),
    ('identity', 'ops_alarm_fault', '128-ops-alarm.sql'),
    ('identity', 'person_name', '084-person-name.sql'),
    ('identity', 'problem_report', '122-problem-report.sql'),
    ('identity', 'problem_report_status_event', '232-problem-report-routing.sql'),
    ('identity', 'session', '020-identity-session.sql'),
    ('identity', 'staff_affiliation', '187-staff-affiliation.sql'),
    ('identity', 'teacher_eligibility', '024-teacher-eligibility.sql'),
    ('identity', 'user_account', '020-identity-session.sql'),
    ('identity', 'user_preference', '128-interface-locale.sql'),
    ('identity', 'webauthn_credential', '136-webauthn-credential.sql'),
    ('institution', 'assignment', '030-institution-access-matrix.sql'),
    ('institution', 'assignment_code_tests', '030-institution-access-matrix.sql'),
    ('institution', 'assignment_rubric_version', '030-institution-access-matrix.sql'),
    ('institution', 'assignment_team_setting', '030-institution-access-matrix.sql'),
    ('institution', 'assignment_template_pin', '030-institution-access-matrix.sql'),
    ('institution', 'assignment_version', '030-institution-access-matrix.sql'),
    ('institution', 'consultation_slot', '030-institution-access-matrix.sql'),
    ('institution', 'course', '030-institution-access-matrix.sql'),
    ('institution', 'course_assistant', '030-institution-access-matrix.sql'),
    ('institution', 'course_assistant_setting', '030-institution-access-matrix.sql'),
    ('institution', 'course_editor', '030-institution-access-matrix.sql'),
    ('institution', 'course_enrollment_code', '030-institution-access-matrix.sql'),
    ('institution', 'course_holder', '030-institution-access-matrix.sql'),
    ('institution', 'course_member', '030-institution-access-matrix.sql'),
    ('institution', 'course_required_source', '030-institution-access-matrix.sql'),
    ('institution', 'deadline_extension', '030-institution-access-matrix.sql'),
    ('institution', 'enrollment_attempt', '030-institution-access-matrix.sql'),
    ('institution', 'faculty_rule_version', '030-institution-access-matrix.sql'),
    ('institution', 'faculty_work_rule', '030-institution-access-matrix.sql'),
    ('institution', 'institution_role', '030-institution-access-matrix.sql'),
    ('institution', 'institution_settings', '030-institution-access-matrix.sql'),
    ('institution', 'late_submission_exception', '030-institution-access-matrix.sql'),
    ('institution', 'mentor_note', '030-institution-access-matrix.sql'),
    ('institution', 'mentor_working_style', '030-institution-access-matrix.sql'),
    ('institution', 'mentorship', '030-institution-access-matrix.sql'),
    ('institution', 'mentorship_opening', '030-institution-access-matrix.sql'),
    ('institution', 'mentorship_request', '030-institution-access-matrix.sql'),
    ('institution', 'merlin_package', '030-institution-access-matrix.sql'),
    ('institution', 'merlin_package_download', '030-institution-access-matrix.sql'),
    ('institution', 'milestone_template_version', '030-institution-access-matrix.sql'),
    ('institution', 'notice_acknowledgment', '030-institution-access-matrix.sql'),
    ('institution', 'notice_read', '030-institution-access-matrix.sql'),
    ('institution', 'notification', '030-institution-access-matrix.sql'),
    ('institution', 'origin_threshold', '030-institution-access-matrix.sql'),
    ('institution', 'peer_review', '030-institution-access-matrix.sql'),
    ('institution', 'peer_review_allocation', '030-institution-access-matrix.sql'),
    ('institution', 'peer_review_round', '030-institution-access-matrix.sql'),
    ('institution', 'peer_review_withdrawal', '030-institution-access-matrix.sql'),
    ('institution', 'practice_entry', '030-institution-access-matrix.sql'),
    ('institution', 'practice_placement', '030-institution-access-matrix.sql'),
    ('institution', 'practice_signoff', '030-institution-access-matrix.sql'),
    ('institution', 'qual_code', '030-institution-access-matrix.sql'),
    ('institution', 'qual_material', '030-institution-access-matrix.sql'),
    ('institution', 'qual_segment', '030-institution-access-matrix.sql'),
    ('institution', 'questionnaire', '030-institution-access-matrix.sql'),
    ('institution', 'questionnaire_answer', '030-institution-access-matrix.sql'),
    ('institution', 'questionnaire_participation', '030-institution-access-matrix.sql'),
    ('institution', 'questionnaire_question', '030-institution-access-matrix.sql'),
    ('institution', 'questionnaire_response', '030-institution-access-matrix.sql'),
    ('institution', 'roster_import', '030-institution-access-matrix.sql'),
    ('institution', 'roster_import_entry', '030-institution-access-matrix.sql'),
    ('institution', 'seminar_group', '030-institution-access-matrix.sql'),
    ('institution', 'seminar_group_member', '030-institution-access-matrix.sql'),
    ('institution', 'seminar_group_teacher', '030-institution-access-matrix.sql'),
    ('institution', 'source_note', '030-institution-access-matrix.sql'),
    ('institution', 'source_proof', '030-institution-access-matrix.sql'),
    ('institution', 'source_proof_request', '030-institution-access-matrix.sql'),
    ('institution', 'submission_withdrawal_setting', '030-institution-access-matrix.sql'),
    ('institution', 'team_substitution', '030-institution-access-matrix.sql'),
    ('institution', 'thesis_form', '030-institution-access-matrix.sql'),
    ('institution', 'thesis_setting', '030-institution-access-matrix.sql'),
    ('institution', 'work_accommodation', '030-institution-access-matrix.sql'),
    ('institution', 'work_attachment', '030-institution-access-matrix.sql'),
    ('institution', 'work_grant', '030-institution-access-matrix.sql'),
    ('institution', 'work_interview', '030-institution-access-matrix.sql'),
    ('institution', 'work_interview_explanation', '030-institution-access-matrix.sql'),
    ('institution', 'work_interview_note', '030-institution-access-matrix.sql'),
    ('institution', 'work_interview_question', '030-institution-access-matrix.sql'),
    ('institution', 'work_language_override', '030-institution-access-matrix.sql'),
    ('institution', 'work_literature_seen', '030-institution-access-matrix.sql'),
    ('institution', 'work_mentor_consent_event', '030-institution-access-matrix.sql'),
    ('institution', 'work_milestone', '030-institution-access-matrix.sql'),
    ('institution', 'work_milestone_deadline', '030-institution-access-matrix.sql'),
    ('institution', 'work_milestone_event', '030-institution-access-matrix.sql'),
    ('institution', 'work_milestone_progress', '030-institution-access-matrix.sql'),
    ('institution', 'work_source', '030-institution-access-matrix.sql'),
    ('institution', 'work_team', '030-institution-access-matrix.sql'),
    ('institution', 'work_team_member_event', '030-institution-access-matrix.sql'),
    ('institution', 'work_template_version', '030-institution-access-matrix.sql'),
    ('institution', 'work_thesis_committee_change', '030-institution-access-matrix.sql'),
    ('institution', 'work_thesis_committee_member', '030-institution-access-matrix.sql'),
    ('institution', 'work_thesis_form_event', '030-institution-access-matrix.sql'),
    ('institution', 'work_thesis_stage_event', '030-institution-access-matrix.sql'),
    ('institution', 'work_thesis_topic_decision', '030-institution-access-matrix.sql'),
    ('institution', 'work_thesis_topic_version', '030-institution-access-matrix.sql'),
    ('pgboss', 'bam', '106-pgboss-queue.sql'),
    ('pgboss', 'instance', '106-pgboss-queue.sql'),
    ('pgboss', 'job', '106-pgboss-queue.sql'),
    ('pgboss', 'job_common', '106-pgboss-queue.sql'),
    ('pgboss', 'job_dependency', '106-pgboss-queue.sql'),
    ('pgboss', 'queue', '106-pgboss-queue.sql'),
    ('pgboss', 'queue_stats', '106-pgboss-queue.sql'),
    ('pgboss', 'schedule', '106-pgboss-queue.sql'),
    ('pgboss', 'subscription', '106-pgboss-queue.sql'),
    ('pgboss', 'version', '106-pgboss-queue.sql'),
    ('pgboss', 'warning', '106-pgboss-queue.sql'),
    ('settings', 'change', '131-settings-levels.sql'),
    ('settings', 'value', '131-settings-levels.sql')
  ) AS v (schema_name, table_name, matrix_file);

CREATE VIEW pg_temp.catalogue_table AS
  SELECT n.nspname::text AS schema_name, c.relname::text AS table_name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'f')
    AND c.oid >= 16384 AND c.relpersistence <> 't'
    AND (n.nspname, c.relname) NOT IN (('public', 'schema_migrations'));

CREATE VIEW pg_temp.matrix_gap AS
  SELECT t.schema_name || '.' || t.table_name AS found FROM pg_temp.catalogue_table t
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.matrix_row r
                    WHERE r.schema_name = t.schema_name AND r.table_name = t.table_name);

CREATE VIEW pg_temp.matrix_stale AS
  SELECT r.schema_name || '.' || r.table_name AS found FROM pg_temp.matrix_row r
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.catalogue_table t
                    WHERE t.schema_name = r.schema_name AND t.table_name = r.table_name);

-- 1. The database as migrated.
SELECT is_empty('SELECT found FROM pg_temp.matrix_gap', 'every table has a row in the list of access tests');
SELECT is_empty('SELECT found FROM pg_temp.matrix_stale', 'every row of the list names a table that exists');
SELECT is((SELECT count(*)::int FROM pg_temp.matrix_row), 211, 'the list has the expected number of rows');
SELECT is_empty(
  'SELECT schema_name, table_name FROM pg_temp.matrix_row GROUP BY 1, 2 HAVING count(*) > 1',
  'no table has two rows');

-- 2. Negative controls: each table without a row is caught.
CREATE SCHEMA test_matrix_probe;
CREATE TABLE test_matrix_probe.plain (id int);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap', ARRAY['test_matrix_probe.plain'],
  'a table without a row, in a new schema, is caught');
DROP TABLE test_matrix_probe.plain;

CREATE TABLE public.test_matrix_probe_plain (id int);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap', ARRAY['public.test_matrix_probe_plain'],
  'a table without a row in public is caught');
DROP TABLE public.test_matrix_probe_plain;

CREATE TABLE test_matrix_probe.schema_migrations (version text);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap', ARRAY['test_matrix_probe.schema_migrations'],
  'the exception holds for public.schema_migrations only, not for the name in another schema');
DROP TABLE test_matrix_probe.schema_migrations;

CREATE TABLE test_matrix_probe.parent (id int) PARTITION BY RANGE (id);
CREATE TABLE test_matrix_probe.part PARTITION OF test_matrix_probe.parent FOR VALUES FROM (0) TO (10);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap',
  ARRAY['test_matrix_probe.parent', 'test_matrix_probe.part'],
  'a partitioned table and its partition each need a row of their own');
DROP TABLE test_matrix_probe.parent;
DROP SCHEMA test_matrix_probe;

SELECT is_empty('SELECT found FROM pg_temp.matrix_gap UNION ALL SELECT found FROM pg_temp.matrix_stale',
  'the list is whole again once the controls are taken back');

SELECT * FROM finish();
ROLLBACK;
