-- DAN-825 (S-1J-d; scope on Ductus#1836, comment 6914563165): account kind x
-- action, one row per kind of server/roles/account-kinds.ts and action of
-- server/roles/permissions.ts. server/roles/account-kinds-matrix-db.test.ts
-- compares the rows with the code, so an action or kind without a row, or an
-- outcome against its scope, fails there.
--
-- Outcome of a row:
--   allowed    at least one probe of the action succeeds for a person of that kind
--   refused    every probe of the action answers ZD403, or "not_found" on a read
--   not_built  no RPC of the main database does the action yet, or the kind has
--              no login (app_admin, owner action V-7); the row says why
-- A probe is an RPC called as the web role ductus_app with the session of the
-- person, never through an administrator connection. Every probe is rolled
-- back, so no probe sees what another wrote. A probe that fails with any other
-- error proves nothing and fails the row. Every person below is invented
-- (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- One person of each kind that can sign in. Boris is in no course; Iva
-- appoints him network engineer through the RPC.
CREATE TEMP TABLE kind_person (kind text PRIMARY KEY, name text NOT NULL UNIQUE);
INSERT INTO kind_person VALUES
  ('student', 'ana'), ('teacher', 'vesna'), ('institution_admin', 'iva'), ('network_engineer', 'boris');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({boris})::text'), 'true', 'Boris is a network engineer');
-- Nina may be confirmed as a teacher; Dora's work in Z1 is the work of
-- another student (fak-a has its evidence domain).
INSERT INTO identity.teacher_eligibility (user_id, institution_id) VALUES (pg_temp.id('nina'), pg_temp.id('fak_a'));
INSERT INTO evidence.domain (id, institution_id, region)
VALUES ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1');
SELECT ok(pg_temp.ask('dora', 'SELECT institution.acknowledge_notice({z1}, 2, 1)::text') ~ '^[0-9]{4}-',
  'Dora acknowledges the current notice of Z1');
SELECT is(pg_temp.ask('dora', 'SELECT outcome FROM app.open_student_work({z1}, true)'), 'opened', 'Dora opens her work in Z1');
INSERT INTO ref SELECT 'dora_work', d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
WHERE p.principal_id = pg_temp.id('dora') AND p.assignment_id = pg_temp.id('z1');

-- Each person holds exactly the kind it stands for, read where 130 places it.
SELECT bag_eq(
  $$ SELECT k.kind, string_agg(x.kind, ',' ORDER BY x.kind) AS kinds FROM kind_person k
     JOIN person p ON p.name = k.name
     LEFT JOIN (
       SELECT user_id, 'student' FROM institution.course_member WHERE role = 'student' AND member_to IS NULL
       UNION SELECT user_id, 'teacher' FROM institution.institution_role
              WHERE role = 'teacher' AND confirmed_at IS NOT NULL AND revoked_at IS NULL
       UNION SELECT user_id, 'institution_admin' FROM institution.institution_role
              WHERE role = 'admin' AND confirmed_at IS NOT NULL AND revoked_at IS NULL
       UNION SELECT user_id, 'network_engineer' FROM identity.network_engineer_appointment WHERE revoked_at IS NULL
     ) AS x (user_id, kind) ON x.user_id = p.id
     GROUP BY k.kind $$,
  $$ SELECT kind, kind AS kinds FROM kind_person $$,
  'each person is of its kind and of no other');

-- The probes of each action. A new probe goes here; an action with a probe has
-- allowed or refused rows, one without has not_built rows.
CREATE TEMP TABLE probe (action text NOT NULL, n integer NOT NULL, sql text NOT NULL, PRIMARY KEY (action, n));
INSERT INTO probe VALUES
  ('read_own_work', 1, 'SELECT outcome FROM app.open_student_work({z1}, true)'),
  ('read_students_work', 1, 'SELECT outcome FROM app.read_replay_source({dora_work})'),
  ('read_students_work', 2, $$ SELECT outcome FROM collaboration.read_live_state({dora_work}, repeat('0', 64)) $$),
  ('manage_courses_and_members', 1, $$ SELECT institution.create_course('K9', '2026/2027', 'prohibited')::text $$),
  ('manage_courses_and_members', 2, $$ SELECT institution.create_enrollment_code({k1}, now() + interval '1 day') $$),
  ('manage_courses_and_members', 3, 'SELECT institution.remove_student({k1}, {dora})::text'),
  ('manage_courses_and_members', 4, 'SELECT institution.hand_over_course({k1}, {vesna})::text'),
  ('assign_student_teacher_roles', 1, 'SELECT institution.confirm_teacher_role({nina})::text'),
  ('assign_student_teacher_roles', 2, 'SELECT institution.revoke_teacher_role({marko})::text'),
  ('assign_admin_network_engineer_roles', 1, 'SELECT identity.appoint_network_engineer({marko})::text'),
  ('assign_admin_network_engineer_roles', 2, 'SELECT identity.revoke_network_engineer({boris})::text'),
  ('assign_admin_network_engineer_roles', 3, 'SELECT institution.admin_appoint_admin({marko})::text'),
  ('change_personal_settings', 1, $$ SELECT settings.set_value('personal', NULL, 'ui.size', '16')::text $$),
  ('change_course_settings', 1, $$ SELECT settings.set_value('course', {k1}, 'ui.size', '16')::text $$),
  ('change_institution_settings', 1, $$ SELECT settings.set_value('institution', NULL, 'ui.size', '16')::text $$),
  ('change_system_settings', 1, $$ SELECT settings.set_value('system', NULL, 'ui.size', '16')::text $$),
  ('change_network_security_settings', 1,
   $$ SELECT settings.set_value('network_security', NULL, 'network.size', '16')::text $$);

-- account-kinds-matrix: kind, action, outcome, why not built.
CREATE TEMP TABLE matrix (
  kind text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'refused', 'not_built')),
  reason text CHECK ((outcome = 'not_built') = (reason IS NOT NULL AND reason <> '')),
  PRIMARY KEY (kind, action)
);
INSERT INTO matrix VALUES
-- account-kinds-matrix:begin
  ('student', 'read_own_work', 'allowed', NULL),
  ('student', 'read_students_work', 'refused', NULL),
  ('student', 'manage_courses_and_members', 'refused', NULL),
  ('student', 'assign_student_teacher_roles', 'refused', NULL),
  ('student', 'assign_admin_network_engineer_roles', 'refused', NULL),
  ('student', 'change_personal_settings', 'allowed', NULL),
  ('student', 'change_course_settings', 'refused', NULL),
  ('student', 'change_institution_settings', 'refused', NULL),
  ('student', 'change_system_settings', 'refused', NULL),
  ('student', 'change_network_security_settings', 'refused', NULL),
  ('student', 'view_access_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('student', 'view_system_metrics', 'not_built', 'no RPC in the main database yet'),
  ('student', 'manage_ip_rules', 'not_built', 'no RPC in the main database yet'),
  ('student', 'export_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('student', 'backup_and_restore', 'not_built', 'no RPC in the main database yet'),
  ('student', 'edit_general_legal_texts', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('student', 'edit_institution_legal_addendum', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('student', 'delete_draft', 'not_built', 'no RPC yet (D-299)'),
  ('student', 'request_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('student', 'approve_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('student', 'request_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('student', 'execute_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('student', 'archive_course', 'not_built', 'no RPC yet (D-299)'),
  ('teacher', 'read_own_work', 'refused', NULL),
  ('teacher', 'read_students_work', 'allowed', NULL),
  ('teacher', 'manage_courses_and_members', 'allowed', NULL),
  ('teacher', 'assign_student_teacher_roles', 'refused', NULL),
  ('teacher', 'assign_admin_network_engineer_roles', 'refused', NULL),
  ('teacher', 'change_personal_settings', 'allowed', NULL),
  ('teacher', 'change_course_settings', 'allowed', NULL),
  ('teacher', 'change_institution_settings', 'refused', NULL),
  ('teacher', 'change_system_settings', 'refused', NULL),
  ('teacher', 'change_network_security_settings', 'refused', NULL),
  ('teacher', 'view_access_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('teacher', 'view_system_metrics', 'not_built', 'no RPC in the main database yet'),
  ('teacher', 'manage_ip_rules', 'not_built', 'no RPC in the main database yet'),
  ('teacher', 'export_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('teacher', 'backup_and_restore', 'not_built', 'no RPC in the main database yet'),
  ('teacher', 'edit_general_legal_texts', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('teacher', 'edit_institution_legal_addendum', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('teacher', 'delete_draft', 'not_built', 'no RPC yet (D-299)'),
  ('teacher', 'request_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('teacher', 'approve_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('teacher', 'request_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('teacher', 'execute_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('teacher', 'archive_course', 'not_built', 'no RPC yet (D-299)'),
  ('institution_admin', 'read_own_work', 'refused', NULL),
  ('institution_admin', 'read_students_work', 'refused', NULL),
  ('institution_admin', 'manage_courses_and_members', 'allowed', NULL),
  ('institution_admin', 'assign_student_teacher_roles', 'allowed', NULL),
  ('institution_admin', 'assign_admin_network_engineer_roles', 'allowed', NULL),
  ('institution_admin', 'change_personal_settings', 'allowed', NULL),
  ('institution_admin', 'change_course_settings', 'allowed', NULL),
  ('institution_admin', 'change_institution_settings', 'allowed', NULL),
  ('institution_admin', 'change_system_settings', 'refused', NULL),
  ('institution_admin', 'change_network_security_settings', 'refused', NULL),
  ('institution_admin', 'view_access_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('institution_admin', 'view_system_metrics', 'not_built', 'no RPC in the main database yet'),
  ('institution_admin', 'manage_ip_rules', 'not_built', 'no RPC in the main database yet'),
  ('institution_admin', 'export_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('institution_admin', 'backup_and_restore', 'not_built', 'no RPC in the main database yet'),
  ('institution_admin', 'edit_general_legal_texts', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('institution_admin', 'edit_institution_legal_addendum', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('institution_admin', 'delete_draft', 'not_built', 'no RPC yet (D-299)'),
  ('institution_admin', 'request_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('institution_admin', 'approve_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('institution_admin', 'request_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('institution_admin', 'execute_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('institution_admin', 'archive_course', 'not_built', 'no RPC yet (D-299)'),
  ('app_admin', 'read_own_work', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'read_students_work', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'manage_courses_and_members', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'assign_student_teacher_roles', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'assign_admin_network_engineer_roles', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'change_personal_settings', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'change_course_settings', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'change_institution_settings', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'change_system_settings', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'change_network_security_settings', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'view_access_logs', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'view_system_metrics', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'manage_ip_rules', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'export_logs', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'backup_and_restore', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'edit_general_legal_texts', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'edit_institution_legal_addendum', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'delete_draft', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'request_submitted_work_deletion', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'approve_submitted_work_deletion', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'request_personal_data_erasure', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'execute_personal_data_erasure', 'not_built', 'no login until owner action V-7'),
  ('app_admin', 'archive_course', 'not_built', 'no login until owner action V-7'),
  ('network_engineer', 'read_own_work', 'refused', NULL),
  ('network_engineer', 'read_students_work', 'refused', NULL),
  ('network_engineer', 'manage_courses_and_members', 'refused', NULL),
  ('network_engineer', 'assign_student_teacher_roles', 'refused', NULL),
  ('network_engineer', 'assign_admin_network_engineer_roles', 'refused', NULL),
  ('network_engineer', 'change_personal_settings', 'allowed', NULL),
  ('network_engineer', 'change_course_settings', 'refused', NULL),
  ('network_engineer', 'change_institution_settings', 'refused', NULL),
  ('network_engineer', 'change_system_settings', 'refused', NULL),
  ('network_engineer', 'change_network_security_settings', 'allowed', NULL),
  ('network_engineer', 'view_access_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('network_engineer', 'view_system_metrics', 'not_built', 'no RPC in the main database yet'),
  ('network_engineer', 'manage_ip_rules', 'not_built', 'no RPC in the main database yet'),
  ('network_engineer', 'export_logs', 'not_built', 'no RPC: the logs are in the logs database (S-1K)'),
  ('network_engineer', 'backup_and_restore', 'not_built', 'no RPC in the main database yet'),
  ('network_engineer', 'edit_general_legal_texts', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('network_engineer', 'edit_institution_legal_addendum', 'not_built', 'no RPC: legal texts are in the legal database (S-1N)'),
  ('network_engineer', 'delete_draft', 'not_built', 'no RPC yet (D-299)'),
  ('network_engineer', 'request_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('network_engineer', 'approve_submitted_work_deletion', 'not_built', 'no RPC yet (D-299)'),
  ('network_engineer', 'request_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('network_engineer', 'execute_personal_data_erasure', 'not_built', 'no RPC yet (D-299)'),
  ('network_engineer', 'archive_course', 'not_built', 'no RPC yet (D-299)')

-- account-kinds-matrix:end
;

-- Every state the probes could change, as one value.
CREATE FUNCTION pg_temp.print() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
    SELECT 'r' || row_to_json(x)::text FROM institution.institution_role x UNION ALL
    SELECT 'n' || row_to_json(x)::text FROM identity.network_engineer_appointment x UNION ALL
    SELECT 'e' || row_to_json(x)::text FROM audit.network_engineer_event x UNION ALL
    SELECT 'a' || row_to_json(x)::text FROM audit.institution_admin_event x UNION ALL
    SELECT 't' || row_to_json(x)::text FROM audit.teacher_role_event x UNION ALL
    SELECT 'c' || row_to_json(x)::text FROM institution.course x UNION ALL
    SELECT 'm' || row_to_json(x)::text FROM institution.course_member x UNION ALL
    SELECT 'k' || row_to_json(x)::text FROM institution.course_enrollment_code x UNION ALL
    SELECT 'h' || row_to_json(x)::text FROM institution.course_holder x UNION ALL
    SELECT 'v' || row_to_json(x)::text FROM settings.value x UNION ALL
    SELECT 's' || row_to_json(x)::text FROM settings.change x UNION ALL
    SELECT 'p' || row_to_json(x)::text FROM evidence.project x
  ) AS t (r)
$$;

-- One probe as ductus_app with the person's session, always rolled back:
-- "ok: <answer>" when it succeeded, "SQLSTATE: message" when it failed.
CREATE FUNCTION pg_temp.probe(p_actor text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_sql text := p_sql;
  v_token text;
  v_result text;
  r record;
BEGIN
  SELECT token INTO STRICT v_token FROM tok WHERE name = p_actor;
  FOR r IN SELECT name, val FROM ref LOOP
    v_sql := replace(v_sql, '{' || r.name || '}', quote_literal(r.val));
  END LOOP;
  BEGIN
    SET LOCAL ROLE ductus_app;
    PERFORM set_config('app.session_token', v_token, true);
    EXECUTE v_sql INTO v_result;
    RAISE EXCEPTION USING ERRCODE = 'ZT825', MESSAGE = coalesce(v_result, 'done');
  EXCEPTION
    WHEN SQLSTATE 'ZT825' THEN v_result := 'ok: ' || SQLERRM;
    WHEN OTHERS THEN v_result := SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('app.session_token', '', true);
  RETURN v_result;
END
$$;
CREATE FUNCTION pg_temp.verdict(p_answer text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_answer ~ '^ZD403: ' OR p_answer = 'ok: not_found' THEN 'refused'
              WHEN p_answer ~ '^ok: ' THEN 'allowed' ELSE 'error' END
$$;

-- 1. The matrix is whole: every kind of the matrix with every action of it.
SELECT is_empty(
  $$ SELECT k.kind, a.action FROM (SELECT DISTINCT kind FROM matrix) k CROSS JOIN (SELECT DISTINCT action FROM matrix) a
     EXCEPT SELECT kind, action FROM matrix $$,
  'every kind has a row for every action');
SELECT is((SELECT count(*) FROM matrix), 115::bigint, 'five kinds times 23 actions');
SELECT is_empty($$ SELECT action FROM probe EXCEPT SELECT action FROM matrix $$, 'every probe is of an action of the matrix');
-- A kind with a person and an action with a probe: allowed or refused, else not_built.
SELECT is_empty(
  $$ SELECT m.kind, m.action, m.outcome FROM matrix m
     WHERE (m.outcome <> 'not_built') IS DISTINCT FROM
           (EXISTS (SELECT 1 FROM kind_person k WHERE k.kind = m.kind) AND EXISTS (SELECT 1 FROM probe p WHERE p.action = m.action)) $$,
  'a row is probed exactly when its kind has a person and its action a probe');

-- 2. Each probed row, as the person of its kind.
CREATE TEMP TABLE before AS SELECT pg_temp.print() AS print;
CREATE TEMP TABLE answer AS
SELECT x.*, pg_temp.verdict(x.raw) AS verdict FROM (
  SELECT m.kind, m.action, m.outcome, p.n, pg_temp.probe(k.name, p.sql) AS raw
  FROM matrix m JOIN kind_person k USING (kind) JOIN probe p USING (action)
) AS x;
SELECT is(
  (SELECT CASE WHEN bool_or(a.verdict = 'error') THEN 'error: ' || string_agg(a.n || ' ' || a.raw, '; ' ORDER BY a.n)
               WHEN bool_or(a.verdict = 'allowed') THEN 'allowed'
               ELSE 'refused' END
     FROM answer a WHERE a.kind = m.kind AND a.action = m.action),
  m.outcome, m.kind || ' x ' || m.action || ': ' || m.outcome)
FROM matrix m WHERE m.outcome <> 'not_built'
ORDER BY m.kind, m.action;
-- A refused row is refused by every probe, not only by most.
SELECT is_empty(
  $$ SELECT kind, action, n, raw FROM answer WHERE outcome = 'refused' AND verdict <> 'refused' $$,
  'every probe of a refused row is refused');

-- 3. The probes left nothing behind.
SELECT is(pg_temp.print(), (SELECT print FROM before), 'no probe wrote anything');
SELECT * FROM finish();
ROLLBACK;
