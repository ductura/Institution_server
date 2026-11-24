-- migrate:up
-- SRV-ADMIN-1 (NF-7 OA-3; owner decision 23. 11. 2026., item 4): the log of
-- what administrators and operators did in an institution, for a confirmed
-- administrator of that institution, read only. One row per action: when, in
-- which role, what kind of action, about which role (for a role action) and
-- the outcome. No row names a person, a student, a work, a case reference or
-- any free text; the log is a summary (permissions table v2,
-- view_access_logs: own_institution_summary).
--
-- The log is no new store. It reads the records the actions already leave,
-- each of them append-only or forward-only (audit.*_event with
-- audit.reject_change, the role rows, evidence.legal_hold with its
-- release-only trigger, app.student_data_export forward-only), so no entry
-- can be changed or removed through it, and an action recorded before this
-- migration is in the log as well. An action is only recorded once it took
-- effect, so every outcome is "completed"; a refused attempt rolls back and
-- leaves no row (the operator path keeps its own denial log).
--
-- Kinds of action and their sources:
--   role_confirmed / role_revoked  teacher (audit.teacher_role_event), network
--     engineer (audit.network_engineer_event), administrator (the admin role
--     rows; appointed by an administrator when audit.institution_admin_event
--     names the row, else by the operator; revoked only by the operator),
--     registry clerk (app.registry_clerk; the operator, on a written request);
--   rule_published                 audit.faculty_rule_event;
--   threshold_changed              audit.origin_threshold_event (set or cleared);
--   hold_placed / hold_released    evidence.legal_hold (released by a second
--     administrator, or by the operator on a request);
--   export_requested / export_approved  app.student_data_export (a registry
--     clerk requests, an administrator approves).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- The trail of the legal holds of the session's institution, without subject,
-- case or reason. Private: only the identity owner's log below calls it.
CREATE FUNCTION app.legal_hold_trail()
RETURNS TABLE (occurred_at timestamptz, action text, by_operator boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
  SELECT h.placed_at, 'hold_placed'::text, false
    FROM evidence.legal_hold h WHERE h.institution_id = v_actor.institution_id
  UNION ALL
  SELECT h.released_at, 'hold_released'::text, h.released_by IS NULL
    FROM evidence.legal_hold h WHERE h.institution_id = v_actor.institution_id AND h.released_at IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION app.legal_hold_trail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.legal_hold_trail() TO ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_identity;
-- The log of the session's institution, newest first. ZD403 for anybody but
-- a confirmed administrator of the institution, ZD401 without a session.
CREATE FUNCTION app.admin_action_log()
RETURNS TABLE (occurred_at timestamptz, actor_role text, action text, subject_role text, outcome text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  PERFORM 1 FROM institution.institution_role r
   WHERE r.institution_id = v_actor.institution_id AND r.user_id = v_actor.user_id AND r.role = 'admin'
     AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
  SELECT l.occurred_at, l.actor_role, l.action, l.subject_role, 'completed'::text
    FROM (
      SELECT e.occurred_at, 'institution_admin'::text AS actor_role, 'role_' || e.kind AS action,
             'teacher'::text AS subject_role
        FROM audit.teacher_role_event e WHERE e.institution_id = v_actor.institution_id
      UNION ALL
      SELECT r.confirmed_at,
             CASE WHEN EXISTS (SELECT 1 FROM audit.institution_admin_event ae
                                WHERE ae.role_id = r.id AND ae.institution_id = r.institution_id)
                  THEN 'institution_admin' ELSE 'operator' END,
             'role_confirmed', 'institution_admin'
        FROM institution.institution_role r
       WHERE r.institution_id = v_actor.institution_id AND r.role = 'admin' AND r.confirmed_at IS NOT NULL
      UNION ALL
      SELECT r.revoked_at, 'operator', 'role_revoked', 'institution_admin'
        FROM institution.institution_role r
       WHERE r.institution_id = v_actor.institution_id AND r.role = 'admin' AND r.revoked_at IS NOT NULL
      UNION ALL
      SELECT e.occurred_at, 'institution_admin',
             CASE e.kind WHEN 'appointed' THEN 'role_confirmed' ELSE 'role_revoked' END, 'network_engineer'
        FROM audit.network_engineer_event e WHERE e.institution_id = v_actor.institution_id
      UNION ALL
      SELECT c.appointed_at, 'operator', 'role_confirmed', 'registry_clerk'
        FROM app.registry_clerk c WHERE c.institution_id = v_actor.institution_id
      UNION ALL
      SELECT c.revoked_at, 'operator', 'role_revoked', 'registry_clerk'
        FROM app.registry_clerk c WHERE c.institution_id = v_actor.institution_id AND c.revoked_at IS NOT NULL
      UNION ALL
      SELECT e.occurred_at, 'institution_admin', 'rule_published', NULL
        FROM audit.faculty_rule_event e WHERE e.institution_id = v_actor.institution_id
      UNION ALL
      SELECT e.occurred_at, 'institution_admin', 'threshold_changed', NULL
        FROM audit.origin_threshold_event e WHERE e.institution_id = v_actor.institution_id
      UNION ALL
      SELECT h.occurred_at, CASE WHEN h.by_operator THEN 'operator' ELSE 'institution_admin' END, h.action, NULL
        FROM app.legal_hold_trail() h
      UNION ALL
      SELECT x.requested_at, 'registry_clerk', 'export_requested', NULL
        FROM app.student_data_export x WHERE x.institution_id = v_actor.institution_id
      UNION ALL
      SELECT x.approved_at, 'institution_admin', 'export_approved', NULL
        FROM app.student_data_export x
       WHERE x.institution_id = v_actor.institution_id AND x.approved_at IS NOT NULL
    ) AS l
   ORDER BY l.occurred_at DESC, l.action, l.actor_role, l.subject_role NULLS FIRST;
END
$$;
REVOKE ALL ON FUNCTION app.admin_action_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_action_log() TO ductus_app;
RESET ROLE;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only; staging and production migrate forward.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.admin_action_log();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.legal_hold_trail();
RESET ROLE;
