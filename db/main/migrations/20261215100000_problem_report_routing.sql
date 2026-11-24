-- migrate:up
-- SRV-ADMIN-1 (NF-7 OA-7; owner decision 23. 11. 2026., item 8): the problem
-- reports reach the people who answer them, by kind. A technical report goes
-- to a network engineer of the institution, a report about a course to the
-- teachers of that course, a report about the account and roles to a
-- confirmed administrator of the institution. A report about a course that
-- names no course goes to the administrator (A-5: the coordinator is the
-- faculty administrator), as nobody else can answer it.
--
-- The reader gets what the reporter wrote and the closed technical context of
-- the report, never who sent it. The state is "received" until somebody the
-- report reaches marks it "resolved" (or back); every change is a row of an
-- append-only trail with the role of the person who made it. The reader is
-- told the role and whether the change was their own, never a name.
--
-- Nothing here widens the table grants: ductus_app still reads only its own
-- reports (problem_report_own_read); the readers above go through the definer
-- functions, which take the account and the institution from the session.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- A course report may name the course it is about, in the reporter's institution.
ALTER TABLE identity.problem_report ADD COLUMN course_id uuid;
ALTER TABLE identity.problem_report
  ADD CONSTRAINT problem_report_course_only_for_course CHECK (course_id IS NULL OR category = 'course');
ALTER TABLE identity.problem_report ADD CONSTRAINT problem_report_course_fkey
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id);
ALTER TABLE identity.problem_report ADD CONSTRAINT problem_report_id_institution_key UNIQUE (id, institution_id);
CREATE INDEX problem_report_institution_created ON identity.problem_report (institution_id, created_at);
CREATE INDEX problem_report_course ON identity.problem_report (course_id) WHERE course_id IS NOT NULL;

-- The state trail: one row per change, never changed or removed.
CREATE TABLE identity.problem_report_status_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  report_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('received', 'resolved')),
  actor_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('network_engineer', 'course_teacher', 'institution_admin')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (report_id, institution_id) REFERENCES identity.problem_report (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX problem_report_status_event_report ON identity.problem_report_status_event (report_id, occurred_at);
CREATE INDEX problem_report_status_event_actor ON identity.problem_report_status_event (actor_id, institution_id);
CREATE TRIGGER problem_report_status_event_append_only BEFORE UPDATE OR DELETE ON identity.problem_report_status_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER problem_report_status_event_no_truncate BEFORE TRUNCATE ON identity.problem_report_status_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE identity.problem_report_status_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.problem_report_status_event FORCE ROW LEVEL SECURITY;
CREATE POLICY problem_report_status_event_owner ON identity.problem_report_status_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The positions of the session's account that receive reports. Private to the
-- owner; ZD401 without a live session.
CREATE FUNCTION identity.problem_report_reader(
  OUT user_id uuid, OUT institution_id uuid, OUT is_admin boolean, OUT is_engineer boolean, OUT is_teacher boolean)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  SELECT a.user_id, a.institution_id INTO user_id, institution_id FROM app.current_actor() a;
  IF user_id IS NULL OR institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  is_admin := EXISTS (SELECT 1 FROM institution.institution_role r
                       WHERE r.institution_id = problem_report_reader.institution_id
                         AND r.user_id = problem_report_reader.user_id AND r.role = 'admin'
                         AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL);
  is_engineer := EXISTS (SELECT 1 FROM identity.network_engineer_appointment n
                          WHERE n.institution_id = problem_report_reader.institution_id
                            AND n.user_id = problem_report_reader.user_id AND n.revoked_at IS NULL);
  is_teacher := EXISTS (SELECT 1 FROM institution.institution_role r
                         WHERE r.institution_id = problem_report_reader.institution_id
                           AND r.user_id = problem_report_reader.user_id AND r.role = 'teacher'
                           AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL);
END
$$;
REVOKE ALL ON FUNCTION identity.problem_report_reader() FROM PUBLIC;

-- Through which position a report reaches the account, or NULL when it does
-- not: the category decides, and a course report needs a team member of its
-- course. Private to the owner.
CREATE FUNCTION identity.problem_report_routed_to(
  p_category text, p_course_id uuid, p_user_id uuid, p_is_admin boolean, p_is_engineer boolean)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_category = 'technical' AND p_is_engineer THEN 'network_engineer'
    WHEN p_category = 'account' AND p_is_admin THEN 'institution_admin'
    WHEN p_category = 'course' AND p_course_id IS NULL AND p_is_admin THEN 'institution_admin'
    WHEN p_category = 'course' AND p_course_id IS NOT NULL
         AND institution.is_course_team_member(p_user_id, p_course_id) THEN 'course_teacher'
  END
$$;
REVOKE ALL ON FUNCTION identity.problem_report_routed_to(text, uuid, uuid, boolean, boolean) FROM PUBLIC;

-- A report about a course of the caller: a student of the course or a member of
-- its team. The same quota and checks as identity.submit_problem_report, which
-- writes the report; a course outside the caller's reach is ZD422, so the
-- answer never tells whether a course exists.
CREATE FUNCTION identity.submit_course_problem_report(
  p_course_id uuid,
  p_description text,
  p_route text,
  p_app_version text,
  p_browser_family text,
  p_browser_major integer,
  p_sync_state text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_reference text;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF p_course_id IS NULL OR NOT (
       EXISTS (SELECT 1 FROM institution.course_member m
                WHERE m.course_id = p_course_id AND m.institution_id = v_actor.institution_id
                  AND m.user_id = v_actor.user_id AND m.member_to IS NULL)
       OR (EXISTS (SELECT 1 FROM institution.course c
                    WHERE c.id = p_course_id AND c.institution_id = v_actor.institution_id)
           AND institution.is_course_team_member(v_actor.user_id, p_course_id))) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_reference := identity.submit_problem_report('course', p_description, p_route, p_app_version,
                                                p_browser_family, p_browser_major, p_sync_state);
  UPDATE identity.problem_report r SET course_id = p_course_id
   WHERE r.reference = v_reference AND r.user_id = v_actor.user_id;
  RETURN v_reference;
END
$$;
REVOKE ALL ON FUNCTION identity.submit_course_problem_report(uuid, text, text, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.submit_course_problem_report(uuid, text, text, text, text, integer, text) TO ductus_app;

-- The reports that reach the caller, newest first, with their state. ZD403
-- for an account that is neither a confirmed administrator, a network
-- engineer nor a confirmed teacher of the institution; ZD401 without a
-- session. No column names the reporter.
CREATE FUNCTION identity.routed_problem_reports()
RETURNS TABLE (
  reference text, category text, routed_to text, course_id uuid, description text, route text,
  app_version text, browser_family text, browser_major integer, sync_state text, created_at timestamptz,
  status text, status_changed_at timestamptz, status_changed_by_role text, status_changed_by_me boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reader record;
BEGIN
  SELECT * INTO v_reader FROM identity.problem_report_reader();
  IF NOT (v_reader.is_admin OR v_reader.is_engineer OR v_reader.is_teacher) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
  SELECT p.reference, p.category, routed.routed_to, p.course_id, p.description, p.route, p.app_version,
         p.browser_family, p.browser_major, p.sync_state, p.created_at,
         coalesce(e.status, 'received'), e.occurred_at, e.actor_role, coalesce(e.actor_id = v_reader.user_id, false)
    FROM identity.problem_report p
   CROSS JOIN LATERAL (SELECT identity.problem_report_routed_to(p.category, p.course_id, v_reader.user_id,
                                                                v_reader.is_admin, v_reader.is_engineer) AS routed_to) routed
    LEFT JOIN LATERAL (SELECT s.status, s.occurred_at, s.actor_role, s.actor_id
                         FROM identity.problem_report_status_event s
                        WHERE s.report_id = p.id AND s.institution_id = p.institution_id
                        ORDER BY s.occurred_at DESC, s.id DESC LIMIT 1) e ON true
   WHERE p.institution_id = v_reader.institution_id AND routed.routed_to IS NOT NULL
   ORDER BY p.created_at DESC, p.reference;
END
$$;
REVOKE ALL ON FUNCTION identity.routed_problem_reports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.routed_problem_reports() TO ductus_app;

-- Marks a report that reaches the caller "received" or "resolved" and returns
-- the time of its current state (NULL while it was never changed). The same
-- state again records nothing. ZD422 for a state outside the two or a
-- malformed reference, ZD403 as in the read, ZD404 for a report that does not
-- reach the caller (of another institution, another course, another kind).
CREATE FUNCTION identity.set_problem_report_status(p_reference text, p_status text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reader record;
  v_report record;
  v_routed text;
  v_current record;
  v_at timestamptz;
BEGIN
  SELECT * INTO v_reader FROM identity.problem_report_reader();
  IF NOT (v_reader.is_admin OR v_reader.is_engineer OR v_reader.is_teacher) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('received', 'resolved')
     OR p_reference IS NULL OR p_reference !~ '^PR-[0-9A-F]{10}$' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- Two changes of one report wait for each other here.
  SELECT p.id, p.institution_id, p.category, p.course_id INTO v_report
    FROM identity.problem_report p
   WHERE p.reference = p_reference AND p.institution_id = v_reader.institution_id
   FOR UPDATE;
  IF FOUND THEN
    v_routed := identity.problem_report_routed_to(v_report.category, v_report.course_id, v_reader.user_id,
                                                  v_reader.is_admin, v_reader.is_engineer);
  END IF;
  IF v_routed IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT s.status, s.occurred_at INTO v_current
    FROM identity.problem_report_status_event s
   WHERE s.report_id = v_report.id AND s.institution_id = v_report.institution_id
   ORDER BY s.occurred_at DESC, s.id DESC LIMIT 1;
  IF coalesce(v_current.status, 'received') = p_status THEN
    RETURN v_current.occurred_at;
  END IF;
  INSERT INTO identity.problem_report_status_event (institution_id, report_id, status, actor_id, actor_role)
  VALUES (v_report.institution_id, v_report.id, p_status, v_reader.user_id, v_routed)
  RETURNING occurred_at INTO v_at;
  RETURN v_at;
END
$$;
REVOKE ALL ON FUNCTION identity.set_problem_report_status(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.set_problem_report_status(text, text) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only; staging and production migrate forward.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.set_problem_report_status(text, text);
DROP FUNCTION identity.routed_problem_reports();
DROP FUNCTION identity.submit_course_problem_report(uuid, text, text, text, text, integer, text);
DROP FUNCTION identity.problem_report_routed_to(text, uuid, uuid, boolean, boolean);
DROP FUNCTION identity.problem_report_reader();
DROP TABLE identity.problem_report_status_event;
DROP INDEX identity.problem_report_course;
DROP INDEX identity.problem_report_institution_created;
ALTER TABLE identity.problem_report DROP CONSTRAINT problem_report_id_institution_key;
ALTER TABLE identity.problem_report DROP CONSTRAINT problem_report_course_fkey;
ALTER TABLE identity.problem_report DROP CONSTRAINT problem_report_course_only_for_course;
ALTER TABLE identity.problem_report DROP COLUMN course_id;
SET LOCAL ROLE ductus_migrator;
