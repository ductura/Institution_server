-- migrate:up
-- SRV-ADMIN-2B uvoz-popisa-dnevnik-radnji (Ductus#2055; added by the
-- orchestrator 24. 11. 2026. from the independent review of the SRV pull
-- requests): the administrators' action log (SRV-ADMIN-1, 20261215100100) had
-- no source for the import of a course's students (SRV-ADMIN-2, 20261215120000).
-- The confirmation of an import is now one more kind of action,
-- roster_import_confirmed: when, by which role, for which course and how many
-- accounts were enrolled, were already enrolled and were skipped.
--
-- No new store: the source is institution.roster_import, which only ever
-- gains its confirmation (trigger roster_import_fixed) and is never deleted,
-- so the entry is neither changed nor removed, and an import confirmed before
-- this migration is in the log as well. Only a confirmation that took effect
-- is a row; a preview, an expired preview and a repeated confirmation (which
-- answers the first result and writes nothing) are none.
--
-- No person: neither the administrator nor any student is named, and no CSV,
-- identifier or name of a row exists to read (roster_import keeps none). The
-- acting role is institution_admin, as for every administrator action of the
-- log. The course is its id, as the reader of the log is an administrator of
-- the institution of that course.
--
-- app.admin_action_log() gets four columns (course_id, enrolled,
-- already_enrolled, skipped; NULL for every other kind of action), so it is
-- dropped and made again with the same body, owner and grant. Nothing else
-- depends on it.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.admin_action_log();
-- The log of the session's institution, newest first. ZD403 for anybody but
-- a confirmed administrator of the institution, ZD401 without a session.
CREATE FUNCTION app.admin_action_log()
RETURNS TABLE (occurred_at timestamptz, actor_role text, action text, subject_role text, outcome text,
               course_id uuid, enrolled_count integer, already_enrolled_count integer, skipped_count integer)
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
  SELECT l.occurred_at, l.actor_role, l.action, l.subject_role, 'completed'::text,
         l.course_id, l.enrolled_count, l.already_enrolled_count, l.skipped_count
    FROM (
      SELECT b.occurred_at, b.actor_role, b.action, b.subject_role, NULL::uuid AS course_id,
             NULL::integer AS enrolled_count, NULL::integer AS already_enrolled_count,
             NULL::integer AS skipped_count
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
        ) AS b
      UNION ALL
      SELECT i.confirmed_at, 'institution_admin'::text, 'roster_import_confirmed'::text, NULL::text,
             i.course_id, i.enrolled_count, i.already_count, i.skipped_count
        FROM institution.roster_import i
       WHERE i.institution_id = v_actor.institution_id AND i.confirmed_at IS NOT NULL
    ) AS l
   ORDER BY l.occurred_at DESC, l.action, l.actor_role, l.subject_role NULLS FIRST, l.course_id NULLS FIRST;
END
$$;
REVOKE ALL ON FUNCTION app.admin_action_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_action_log() TO ductus_app;
RESET ROLE;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production migrate forward.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.admin_action_log();
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
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
