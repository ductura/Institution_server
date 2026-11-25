-- migrate:up
-- SRV-ASIST-PREKIDAC (Ductus#2055 c.7162920212, Daniel 25. 11. 2026., T4): the
-- switch "Asistent uključen" per course, on by default, set by a teacher of the
-- course. The assistant is available for an assignment when all three hold:
--   (a) a provider exists             decided in code (the route's composition);
--   (b) the institution has a published cost configuration
--                                     app.assistant_cost_published, the same
--                                     test as assistant.begin_request's
--                                     ai_disabled (20261201130000);
--   (c) the course did not switch it off
--                                     institution.course_assistant_setting.
--
--   institution.course_assistant_setting   one row per course a teacher set
--   audit.assistant_course_switch_event    append-only trail of every switch,
--                                          written in the same call
--   app.course_assistant_switch(course, on)  only a teacher of the course sets it
--   app.course_assistant_switch_read(course) the same teacher reads it
--   app.my_assistant_available(assignment)   a student of the assignment reads
--                                          (b) and (c); anyone else not_found
--
-- Errors carry no input: ZD401 no session, ZD403 no relation (also an unknown
-- course, C-23), ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app, audit TO ductus_identity;

SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.course_assistant_setting (
  institution_id uuid NOT NULL,
  course_id uuid NOT NULL,
  enabled boolean NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, course_id),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (changed_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX course_assistant_setting_by_idx
  ON institution.course_assistant_setting (changed_by, institution_id);
ALTER TABLE institution.course_assistant_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.course_assistant_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY course_assistant_setting_owner ON institution.course_assistant_setting
  TO ductus_identity USING (true) WITH CHECK (true);

CREATE TABLE audit.assistant_course_switch_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  course_id uuid NOT NULL,
  enabled boolean NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assistant_course_switch_event_course_idx
  ON audit.assistant_course_switch_event (institution_id, course_id, occurred_at);
CREATE INDEX assistant_course_switch_event_actor_idx
  ON audit.assistant_course_switch_event (actor_id, institution_id);
CREATE TRIGGER assistant_course_switch_event_append_only
  BEFORE UPDATE OR DELETE ON audit.assistant_course_switch_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER assistant_course_switch_event_no_truncate
  BEFORE TRUNCATE ON audit.assistant_course_switch_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.assistant_course_switch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.assistant_course_switch_event FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_course_switch_event_owner ON audit.assistant_course_switch_event
  TO ductus_identity USING (true) WITH CHECK (true);

-- (b): the latest service version has a cap, and the latest version of the
-- institution has every limit and the reservation. Exactly the condition under
-- which assistant.begin_request does not answer ai_disabled; 254 checks both
-- agree. Called only by the functions below, never by a role.
CREATE FUNCTION app.assistant_cost_published(p_institution_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT v.cap_micro IS NOT NULL
                     FROM assistant.cost_config_version v
                    WHERE v.institution_id IS NULL
                    ORDER BY v.version_no DESC LIMIT 1), false)
     AND coalesce((SELECT v.cap_micro IS NOT NULL AND v.student_day_micro IS NOT NULL
                          AND v.student_assignment_day_micro IS NOT NULL AND v.reserve_micro IS NOT NULL
                     FROM assistant.cost_config_version v
                    WHERE v.institution_id = p_institution_id
                    ORDER BY v.version_no DESC LIMIT 1), false)
$$;

-- (c): the course's own switch, else on.
CREATE FUNCTION app.course_assistant_on(p_institution_id uuid, p_course_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.enabled FROM institution.course_assistant_setting s
                    WHERE s.institution_id = p_institution_id AND s.course_id = p_course_id), true)
$$;

-- Only a teacher of the course (institution.require_course_teacher) sets it.
-- Setting the value in force writes nothing.
CREATE FUNCTION app.course_assistant_switch(p_course_id uuid, p_enabled boolean)
RETURNS TABLE (enabled boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  PERFORM institution.require_actor();
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_actor FROM institution.require_course_teacher(p_course_id);
  -- One writer per course at a time, so the trail follows the row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'institution.course_assistant_setting:' || p_course_id::text, 0));
  IF app.course_assistant_on(v_actor.institution_id, p_course_id) IS DISTINCT FROM p_enabled THEN
    INSERT INTO institution.course_assistant_setting AS s (institution_id, course_id, enabled, changed_by)
    VALUES (v_actor.institution_id, p_course_id, p_enabled, v_actor.user_id)
    ON CONFLICT (institution_id, course_id)
      DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = now();
    INSERT INTO audit.assistant_course_switch_event (institution_id, course_id, enabled, actor_id)
    VALUES (v_actor.institution_id, p_course_id, p_enabled, v_actor.user_id);
  END IF;
  RETURN QUERY SELECT p_enabled;
END
$$;

CREATE FUNCTION app.course_assistant_switch_read(p_course_id uuid)
RETURNS TABLE (enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_course_teacher(p_course_id);
  RETURN QUERY SELECT app.course_assistant_on(v_actor.institution_id, p_course_id);
END
$$;

-- (b) and (c) for a student of the assignment, as app.my_assignment_late_submission;
-- anyone else, an unknown and a null assignment: not_found.
CREATE FUNCTION app.my_assistant_available(p_assignment_id uuid)
RETURNS TABLE (outcome text, available boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_course uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  SELECT a.course_id INTO v_course FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id;
  IF v_course IS NULL OR institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::boolean;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'found'::text,
    app.assistant_cost_published(v_actor.institution_id)
    AND app.course_assistant_on(v_actor.institution_id, v_course);
END
$$;

REVOKE ALL ON FUNCTION app.assistant_cost_published(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.course_assistant_on(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.course_assistant_switch(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.course_assistant_switch_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.my_assistant_available(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.course_assistant_switch(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.course_assistant_switch_read(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.my_assistant_available(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app, audit FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (Ductus docs/BACKEND.md §6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.my_assistant_available(uuid);
DROP FUNCTION app.course_assistant_switch_read(uuid);
DROP FUNCTION app.course_assistant_switch(uuid, boolean);
DROP FUNCTION app.course_assistant_on(uuid, uuid);
DROP FUNCTION app.assistant_cost_published(uuid);
DROP TABLE audit.assistant_course_switch_event;
DROP TABLE institution.course_assistant_setting;
