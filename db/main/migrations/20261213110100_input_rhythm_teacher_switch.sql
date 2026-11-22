-- migrate:up
-- PIL-P1-RITAM-SRV (Ductus#2052; P-1 rule 4, Daniel 22. 11. 2026.): the switch of
-- the rhythm of typing belongs to the teacher, never to the student.
--
-- 20261213100300 gave the switch to the student (app.input_rhythm_set, one row
-- per student). The owner's decision is that only the teacher of the assignment
-- or of its course switches the recording off or on; the student only reads the
-- state. So the switch moves to the assignment:
--
--   evidence.input_rhythm_assignment_setting  one row per assignment; on by
--                                             default; it holds from the moment
--                                             of switching off: nothing is
--                                             recorded and nothing is read while
--                                             it is off.
--
--   audit.input_rhythm_switch_event          append-only trail of every switch,
--                                             written in the same call as the
--                                             change
--
--   app.input_rhythm_switch(assignment, on)  the teacher of the assignment (of
--                                             its course or its mentor) sets it
--   app.input_rhythm_switch_read(assignment) the same teacher reads it
--   app.input_rhythm_state(document)         the owner and the readers of a work
--                                             read it
--
-- Each of the three answers one row: the state, the role ('teacher' or
-- 'mentor') and the name of who changed it last, and when; role, name and time
-- are null while the default holds, the name also when none is known. The
-- student sees who switched the recording (Daniel 22. 11. 2026., review c.7087259790).
--
-- The student's own switch no longer counts and the web role no longer executes
-- app.input_rhythm_set; its table stays (no data is dropped here). One answer,
-- ZD403, for every refusal, also for an unknown assignment or document (C-23).
-- ZD401 no session, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT USAGE ON SCHEMA institution, identity TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.assignment, identity.user_account TO ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.input_rhythm_assignment_setting (
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  enabled boolean NOT NULL,
  changed_by uuid NOT NULL,
  changed_by_role text NOT NULL CHECK (changed_by_role IN ('teacher', 'mentor')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, assignment_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (changed_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX input_rhythm_assignment_setting_by_idx
  ON evidence.input_rhythm_assignment_setting (changed_by, institution_id);
ALTER TABLE evidence.input_rhythm_assignment_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.input_rhythm_assignment_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY input_rhythm_assignment_setting_owner ON evidence.input_rhythm_assignment_setting
  TO ductus_evidence USING (true) WITH CHECK (true);

-- Evidence-owned workers, called only by the identity-owned RPCs below.
CREATE FUNCTION app.input_rhythm_assignment_on(p_assignment_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.enabled FROM app.current_actor() a
                     JOIN evidence.input_rhythm_assignment_setting s
                       ON s.institution_id = a.institution_id AND s.assignment_id = p_assignment_id), true)
$$;

-- The row of the switch, if anyone ever changed it.
CREATE FUNCTION app.input_rhythm_assignment_row(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, changed_by uuid, changed_by_role text, changed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.enabled, s.changed_by, s.changed_by_role, s.changed_at
    FROM app.current_actor() a
    JOIN evidence.input_rhythm_assignment_setting s
      ON s.institution_id = a.institution_id AND s.assignment_id = p_assignment_id
$$;

CREATE FUNCTION app.input_rhythm_assignment_put(p_assignment_id uuid, p_enabled boolean, p_role text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO evidence.input_rhythm_assignment_setting AS s
    (institution_id, assignment_id, enabled, changed_by, changed_by_role)
  SELECT a.institution_id, p_assignment_id, p_enabled, a.user_id, p_role
    FROM app.current_actor() a WHERE a.institution_id IS NOT NULL AND a.user_id IS NOT NULL
  ON CONFLICT (institution_id, assignment_id)
    DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by,
                  changed_by_role = excluded.changed_by_role, changed_at = now()
  RETURNING s.enabled
$$;

-- As 20261213100300, deciding by the assignment's switch instead of the student's.
-- A burst whose call began before a concurrent switching off may still be
-- written once (the switch row is not locked here); no read returns it while
-- the switch is off, and the student may delete it.
CREATE OR REPLACE FUNCTION app.input_rhythm_add(p_assignment_id uuid, p_student_id uuid, p_gaps integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_gaps integer[];
  v_n integer := cardinality(p_gaps);
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL THEN RETURN false; END IF;
  IF NOT app.input_rhythm_assignment_on(p_assignment_id) THEN
    RETURN false;
  END IF;
  IF v_n > 130 THEN
    SELECT array_agg(p_gaps[1 + (i * v_n) / 130] ORDER BY i) INTO v_gaps FROM generate_series(0, 129) i;
  ELSE
    v_gaps := p_gaps;
  END IF;
  INSERT INTO evidence.input_rhythm (institution_id, assignment_id, student_id, gaps_ms, delete_after)
  VALUES (v_institution, p_assignment_id, p_student_id, v_gaps,
          now() + make_interval(months => app.input_rhythm_retention_months()));
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION app.input_rhythm_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (id uuid, gaps_ms integer[], recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.id, r.gaps_ms, r.recorded_at
    FROM app.current_actor() a
    JOIN evidence.input_rhythm r
      ON r.institution_id = a.institution_id AND r.assignment_id = p_assignment_id AND r.student_id = p_student_id
   WHERE app.input_rhythm_assignment_on(p_assignment_id)
   ORDER BY r.seq
$$;

REVOKE ALL ON FUNCTION app.input_rhythm_assignment_on(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_assignment_row(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_assignment_put(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_assignment_on(uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_assignment_row(uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_assignment_put(uuid, boolean, text) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- Every switch, append-only; written by app.input_rhythm_switch in the same
-- call as the change of the setting.
CREATE TABLE audit.input_rhythm_switch_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  enabled boolean NOT NULL,
  actor_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('teacher', 'mentor')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX input_rhythm_switch_event_assignment_idx
  ON audit.input_rhythm_switch_event (institution_id, assignment_id, occurred_at);
CREATE INDEX input_rhythm_switch_event_actor_idx ON audit.input_rhythm_switch_event (actor_id, institution_id);
CREATE TRIGGER input_rhythm_switch_event_append_only BEFORE UPDATE OR DELETE ON audit.input_rhythm_switch_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER input_rhythm_switch_event_no_truncate BEFORE TRUNCATE ON audit.input_rhythm_switch_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.input_rhythm_switch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.input_rhythm_switch_event FORCE ROW LEVEL SECURITY;
CREATE POLICY input_rhythm_switch_event_owner ON audit.input_rhythm_switch_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The caller's part in the assignment as its teacher: 'mentor' for the mentor
-- of a mentorship work, 'teacher' for a teacher of its course. Every other
-- caller, and an unknown assignment, is ZD403.
CREATE FUNCTION app.input_rhythm_require_teacher(p_assignment_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF p_assignment_id IS NULL
     OR institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN (SELECT CASE WHEN s.mentorship_id IS NOT NULL THEN 'mentor' ELSE 'teacher' END
            FROM institution.assignment s WHERE s.id = p_assignment_id);
END
$$;

-- The state of the switch of an assignment as the three RPCs answer it.
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

REVOKE ALL ON FUNCTION app.input_rhythm_require_teacher(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_setting_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_switch_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_switch_read(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_state(text) TO ductus_app;
-- The student no longer switches the recording.
REVOKE EXECUTE ON FUNCTION app.input_rhythm_set(boolean) FROM ductus_app;

REVOKE REFERENCES ON institution.assignment, identity.user_account FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE USAGE ON SCHEMA institution, identity FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_set(boolean) TO ductus_app;
DROP FUNCTION app.input_rhythm_state(text);
DROP FUNCTION app.input_rhythm_switch_read(uuid);
DROP FUNCTION app.input_rhythm_switch(uuid, boolean);
DROP FUNCTION app.input_rhythm_setting_view(uuid);
DROP FUNCTION app.input_rhythm_require_teacher(uuid);
DROP TABLE audit.input_rhythm_switch_event;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION app.input_rhythm_add(p_assignment_id uuid, p_student_id uuid, p_gaps integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_gaps integer[];
  v_n integer := cardinality(p_gaps);
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL THEN RETURN false; END IF;
  IF NOT coalesce((SELECT s.enabled FROM evidence.input_rhythm_setting s
                    WHERE s.institution_id = v_institution AND s.user_id = p_student_id), true) THEN
    RETURN false;
  END IF;
  IF v_n > 130 THEN
    SELECT array_agg(p_gaps[1 + (i * v_n) / 130] ORDER BY i) INTO v_gaps FROM generate_series(0, 129) i;
  ELSE
    v_gaps := p_gaps;
  END IF;
  INSERT INTO evidence.input_rhythm (institution_id, assignment_id, student_id, gaps_ms, delete_after)
  VALUES (v_institution, p_assignment_id, p_student_id, v_gaps,
          now() + make_interval(months => app.input_rhythm_retention_months()));
  RETURN true;
END
$$;
CREATE OR REPLACE FUNCTION app.input_rhythm_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (id uuid, gaps_ms integer[], recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.id, r.gaps_ms, r.recorded_at
    FROM app.current_actor() a
    JOIN evidence.input_rhythm r
      ON r.institution_id = a.institution_id AND r.assignment_id = p_assignment_id AND r.student_id = p_student_id
   WHERE coalesce((SELECT s.enabled FROM evidence.input_rhythm_setting s
                    WHERE s.institution_id = a.institution_id AND s.user_id = p_student_id), true)
   ORDER BY r.seq
$$;
DROP FUNCTION app.input_rhythm_assignment_put(uuid, boolean, text);
DROP FUNCTION app.input_rhythm_assignment_row(uuid);
DROP FUNCTION app.input_rhythm_assignment_on(uuid);
DROP TABLE evidence.input_rhythm_assignment_setting;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
