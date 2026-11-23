-- migrate:up
-- PIL-P1-RITAM-PREDMET-SRV (Ductus#2052; Daniel 23. 11. 2026., „Može po predmetu
-- da”): the teacher's switch of the rhythm of typing also exists per course, and
-- the assignment may override it. Which one holds:
--
--   the switch of the assignment, if a teacher ever set it and did not clear it;
--   else the switch of the assignment's course, if a teacher of it set it;
--   else on (the default).
--
--   evidence.input_rhythm_course_setting        one row per course, as the
--                                                assignment's in 20261213110100
--   audit.input_rhythm_course_switch_event      append-only trail of every switch
--                                                of a course, written in the same
--                                                call as the change
--   audit.input_rhythm_switch_event.enabled     now null for a clearing of the
--                                                assignment's switch
--
--   app.input_rhythm_course_switch(course, on)  only a teacher of the course sets it
--   app.input_rhythm_course_switch_read(course) the same teacher reads it
--   app.input_rhythm_switch_clear(assignment)   the teacher of the assignment clears
--                                                its switch: the course holds again
--
-- The three answers of 20261213110100 (switch, switch_read, state) gain the
-- column source, 'assignment', 'course' or 'default': the level the state comes
-- from. Role, name and time are of who set that level; null for the default.
-- Recording and reading follow the state that holds. One answer, ZD403, for
-- every refusal, also for an unknown course or assignment (C-23).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT USAGE ON SCHEMA institution, identity TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.course, identity.user_account TO ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.input_rhythm_course_setting (
  institution_id uuid NOT NULL,
  course_id uuid NOT NULL,
  enabled boolean NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, course_id),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (changed_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX input_rhythm_course_setting_by_idx
  ON evidence.input_rhythm_course_setting (changed_by, institution_id);
ALTER TABLE evidence.input_rhythm_course_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.input_rhythm_course_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY input_rhythm_course_setting_owner ON evidence.input_rhythm_course_setting
  TO ductus_evidence USING (true) WITH CHECK (true);

-- Evidence-owned workers, called only by the identity-owned RPCs below.
CREATE FUNCTION app.input_rhythm_course_row(p_course_id uuid)
RETURNS TABLE (enabled boolean, changed_by uuid, changed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.enabled, s.changed_by, s.changed_at
    FROM app.current_actor() a
    JOIN evidence.input_rhythm_course_setting s
      ON s.institution_id = a.institution_id AND s.course_id = p_course_id
$$;

CREATE FUNCTION app.input_rhythm_course_put(p_course_id uuid, p_enabled boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO evidence.input_rhythm_course_setting AS s (institution_id, course_id, enabled, changed_by)
  SELECT a.institution_id, p_course_id, p_enabled, a.user_id
    FROM app.current_actor() a WHERE a.institution_id IS NOT NULL AND a.user_id IS NOT NULL
  ON CONFLICT (institution_id, course_id)
    DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = now()
  RETURNING s.enabled
$$;

-- Removes the assignment's own switch; how many rows went (0 or 1).
CREATE FUNCTION app.input_rhythm_assignment_clear(p_assignment_id uuid) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH d AS (
    DELETE FROM evidence.input_rhythm_assignment_setting s
     USING app.current_actor() a
     WHERE s.institution_id = a.institution_id AND s.assignment_id = p_assignment_id
    RETURNING 1)
  SELECT count(*)::integer FROM d
$$;

REVOKE ALL ON FUNCTION app.input_rhythm_course_row(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_course_put(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_assignment_clear(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_course_row(uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_course_put(uuid, boolean) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_assignment_clear(uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- A clearing of the assignment's switch is a row with enabled null.
ALTER TABLE audit.input_rhythm_switch_event ALTER COLUMN enabled DROP NOT NULL;

CREATE TABLE audit.input_rhythm_course_switch_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  course_id uuid NOT NULL,
  enabled boolean NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX input_rhythm_course_switch_event_course_idx
  ON audit.input_rhythm_course_switch_event (institution_id, course_id, occurred_at);
CREATE INDEX input_rhythm_course_switch_event_actor_idx
  ON audit.input_rhythm_course_switch_event (actor_id, institution_id);
CREATE TRIGGER input_rhythm_course_switch_event_append_only
  BEFORE UPDATE OR DELETE ON audit.input_rhythm_course_switch_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER input_rhythm_course_switch_event_no_truncate
  BEFORE TRUNCATE ON audit.input_rhythm_course_switch_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.input_rhythm_course_switch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.input_rhythm_course_switch_event FORCE ROW LEVEL SECURITY;
CREATE POLICY input_rhythm_course_switch_event_owner ON audit.input_rhythm_course_switch_event
  TO ductus_identity USING (true) WITH CHECK (true);

DROP FUNCTION app.input_rhythm_state(text);
DROP FUNCTION app.input_rhythm_switch_read(uuid);
DROP FUNCTION app.input_rhythm_switch(uuid, boolean);
DROP FUNCTION app.input_rhythm_setting_view(uuid);

-- The state that holds for an assignment: its own switch, else its course's, else on.
CREATE FUNCTION app.input_rhythm_setting_view(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH level AS (
    SELECT r.enabled, 'assignment'::text AS source, r.changed_by, r.changed_by_role, r.changed_at, 1 AS rank
      FROM app.input_rhythm_assignment_row(p_assignment_id) r
    UNION ALL
    SELECT c.enabled, 'course', c.changed_by, 'teacher', c.changed_at, 2
      FROM app.current_actor() a
      JOIN institution.assignment x ON x.id = p_assignment_id AND x.institution_id = a.institution_id
      CROSS JOIN LATERAL app.input_rhythm_course_row(x.course_id) c
    UNION ALL
    SELECT true, 'default', NULL, NULL, NULL, 3
  )
  SELECT l.enabled, l.source, l.changed_by_role,
         CASE WHEN n.user_id IS NOT NULL THEN n.given_name || ' ' || n.family_name END, l.changed_at
    FROM (SELECT * FROM level ORDER BY rank LIMIT 1) l
    LEFT JOIN app.current_actor() a ON true
    LEFT JOIN identity.person_name n ON n.user_id = l.changed_by AND n.institution_id = a.institution_id
$$;

-- The state of a course's switch: its own, else on.
CREATE FUNCTION app.input_rhythm_course_view(p_course_id uuid)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(r.enabled, true), CASE WHEN r.enabled IS NULL THEN 'default' ELSE 'course' END,
         CASE WHEN r.enabled IS NOT NULL THEN 'teacher' END,
         CASE WHEN n.user_id IS NOT NULL THEN n.given_name || ' ' || n.family_name END, r.changed_at
    FROM app.current_actor() a
    LEFT JOIN app.input_rhythm_course_row(p_course_id) r ON true
    LEFT JOIN identity.person_name n ON n.user_id = r.changed_by AND n.institution_id = a.institution_id
$$;

CREATE FUNCTION app.input_rhythm_on(p_assignment_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT v.enabled FROM app.input_rhythm_setting_view(p_assignment_id) v $$;

CREATE FUNCTION app.input_rhythm_switch(p_assignment_id uuid, p_enabled boolean)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_actor record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_role := app.input_rhythm_require_teacher(p_assignment_id);
  IF app.input_rhythm_assignment_put(p_assignment_id, p_enabled, v_role) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO audit.input_rhythm_switch_event (institution_id, assignment_id, enabled, actor_id, actor_role)
  VALUES (v_actor.institution_id, p_assignment_id, p_enabled, v_actor.user_id, v_role);
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(p_assignment_id);
END
$$;

-- The teacher of the assignment clears its own switch; the course's holds again.
-- Clearing a switch nobody set changes nothing and writes no audit row.
CREATE FUNCTION app.input_rhythm_switch_clear(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_actor record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  v_role := app.input_rhythm_require_teacher(p_assignment_id);
  IF app.input_rhythm_assignment_clear(p_assignment_id) > 0 THEN
    INSERT INTO audit.input_rhythm_switch_event (institution_id, assignment_id, enabled, actor_id, actor_role)
    VALUES (v_actor.institution_id, p_assignment_id, NULL, v_actor.user_id, v_role);
  END IF;
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(p_assignment_id);
END
$$;

CREATE FUNCTION app.input_rhythm_switch_read(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM app.input_rhythm_require_teacher(p_assignment_id);
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(p_assignment_id);
END
$$;

CREATE FUNCTION app.input_rhythm_state(p_document_id text)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(v_access.assignment_id);
END
$$;

-- Only a teacher of the course (institution.require_course_teacher) sets and reads its switch.
CREATE FUNCTION app.input_rhythm_course_switch(p_course_id uuid, p_enabled boolean)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
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
  IF app.input_rhythm_course_put(p_course_id, p_enabled) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO audit.input_rhythm_course_switch_event (institution_id, course_id, enabled, actor_id)
  VALUES (v_actor.institution_id, p_course_id, p_enabled, v_actor.user_id);
  RETURN QUERY SELECT * FROM app.input_rhythm_course_view(p_course_id);
END
$$;

CREATE FUNCTION app.input_rhythm_course_switch_read(p_course_id uuid)
RETURNS TABLE (enabled boolean, source text, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_course_teacher(p_course_id);
  RETURN QUERY SELECT * FROM app.input_rhythm_course_view(p_course_id);
END
$$;

-- As 20261213100300, also stopping while the course's switch holds and is off.
-- (app.input_rhythm_add and _of still check the assignment's own switch.)
CREATE OR REPLACE FUNCTION app.input_rhythm_record(p_document_id text, p_gaps_ms integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_gaps_ms IS NULL OR array_ndims(p_gaps_ms) IS DISTINCT FROM 1 OR cardinality(p_gaps_ms) < 1
     OR cardinality(p_gaps_ms) > 5000 OR EXISTS (
       SELECT 1 FROM unnest(p_gaps_ms) g WHERE g IS NULL OR g < 0 OR g > 3600000) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  IF NOT app.input_rhythm_on(v_access.assignment_id) THEN
    RETURN false;
  END IF;
  RETURN app.input_rhythm_add(v_access.assignment_id, v_access.student_id, p_gaps_ms);
END
$$;

CREATE OR REPLACE FUNCTION app.input_rhythm_read(p_document_id text)
RETURNS TABLE (id uuid, gaps_ms integer[], recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  IF NOT app.input_rhythm_on(v_access.assignment_id) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.input_rhythm_of(v_access.assignment_id, v_access.student_id);
END
$$;

REVOKE ALL ON FUNCTION app.input_rhythm_setting_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_course_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_on(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch_clear(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_course_switch(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_course_switch_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch_clear(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch_read(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_state(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_course_switch(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_course_switch_read(uuid) TO ductus_app;

REVOKE REFERENCES ON institution.course, identity.user_account FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE USAGE ON SCHEMA institution, identity FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (Ductus docs/BACKEND.md §6).
-- Restores the functions of 20261213110100 (without the column source) and the
-- bodies of app.input_rhythm_record and _read of 20261213100300. The column
-- audit.input_rhythm_switch_event.enabled keeps no NOT NULL: a clearing row
-- with enabled null may already be in the append-only trail, which no down
-- deletes.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION app.input_rhythm_record(p_document_id text, p_gaps_ms integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_gaps_ms IS NULL OR array_ndims(p_gaps_ms) IS DISTINCT FROM 1 OR cardinality(p_gaps_ms) < 1
     OR cardinality(p_gaps_ms) > 5000 OR EXISTS (
       SELECT 1 FROM unnest(p_gaps_ms) g WHERE g IS NULL OR g < 0 OR g > 3600000) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.input_rhythm_add(v_access.assignment_id, v_access.student_id, p_gaps_ms);
END
$$;
CREATE OR REPLACE FUNCTION app.input_rhythm_read(p_document_id text)
RETURNS TABLE (id uuid, gaps_ms integer[], recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.input_rhythm_of(v_access.assignment_id, v_access.student_id);
END
$$;
DROP FUNCTION app.input_rhythm_course_switch_read(uuid);
DROP FUNCTION app.input_rhythm_course_switch(uuid, boolean);
DROP FUNCTION app.input_rhythm_switch_clear(uuid);
DROP FUNCTION app.input_rhythm_state(text);
DROP FUNCTION app.input_rhythm_switch_read(uuid);
DROP FUNCTION app.input_rhythm_switch(uuid, boolean);
DROP FUNCTION app.input_rhythm_on(uuid);
DROP FUNCTION app.input_rhythm_course_view(uuid);
DROP FUNCTION app.input_rhythm_setting_view(uuid);
DROP TABLE audit.input_rhythm_course_switch_event;

CREATE FUNCTION app.input_rhythm_setting_view(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(r.enabled, true), r.changed_by_role,
         CASE WHEN n.user_id IS NOT NULL THEN n.given_name || ' ' || n.family_name END,
         r.changed_at
    FROM app.current_actor() a
    LEFT JOIN app.input_rhythm_assignment_row(p_assignment_id) r ON true
    LEFT JOIN identity.person_name n ON n.user_id = r.changed_by AND n.institution_id = a.institution_id
$$;
CREATE FUNCTION app.input_rhythm_switch(p_assignment_id uuid, p_enabled boolean)
RETURNS TABLE (enabled boolean, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_actor record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_role := app.input_rhythm_require_teacher(p_assignment_id);
  IF app.input_rhythm_assignment_put(p_assignment_id, p_enabled, v_role) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO audit.input_rhythm_switch_event (institution_id, assignment_id, enabled, actor_id, actor_role)
  VALUES (v_actor.institution_id, p_assignment_id, p_enabled, v_actor.user_id, v_role);
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(p_assignment_id);
END
$$;
CREATE FUNCTION app.input_rhythm_switch_read(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM app.input_rhythm_require_teacher(p_assignment_id);
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(p_assignment_id);
END
$$;
CREATE FUNCTION app.input_rhythm_state(p_document_id text)
RETURNS TABLE (enabled boolean, changed_by_role text, changed_by_name text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.input_rhythm_setting_view(v_access.assignment_id);
END
$$;
REVOKE ALL ON FUNCTION app.input_rhythm_setting_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch_read(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_state(text) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.input_rhythm_assignment_clear(uuid);
DROP FUNCTION app.input_rhythm_course_put(uuid, boolean);
DROP FUNCTION app.input_rhythm_course_row(uuid);
DROP TABLE evidence.input_rhythm_course_setting;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
