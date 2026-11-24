-- migrate:up
-- SRV-V17-TEMPLATE-ASSIGN (val 17, N-V17 predložak rada): an assignment gets the work template
-- of the institution, and the student reads its skeleton when starting the work.
--
-- The teacher of an assignment decides, for a course assignment, whether it uses the
-- institution's template (SRV-V17-TEMPLATE-ADMIN). Switching it on pins the latest version of
-- the template of the assignment's work type: the version is frozen on the assignment, so a
-- version added later changes nothing for work that already began. Switching it on again keeps
-- the pin it has; switching it off removes it. Nothing is copied: the pin names the version,
-- and the version rows stay append only in institution.work_template_version.
--
--   institution.assignment_template_pin  one row per assignment that uses the template:
--                                        (assignment, work type, version), pinned by a teacher
--   app.set_assignment_template          the teacher of the assignment's course switches the
--                                        template on or off; returns the pinned version, 0 off
--   app.read_assignment_template         a student of the assignment's course reads the pinned
--                                        version: no row when the assignment has no pin
--
-- Who may comes from relations only (C-23): the teacher of the course, a student of the course,
-- both in the caller's institution. A mentorship assignment (no course), an assignment that does
-- not exist, one of another course and one of another institution all get ZD403, one answer
-- (the HTTP edge makes it 404). The table is reached only through these two functions.
-- Errors carry no input: ZD401 no session, ZD403 no relation, ZD409 the institution has no
-- template for the work type yet, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.assignment_template_pin (
  assignment_id uuid PRIMARY KEY REFERENCES institution.assignment (id),
  institution_id uuid NOT NULL,
  work_type text NOT NULL,
  template_version integer NOT NULL CHECK (template_version >= 1),
  pinned_by uuid NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- Only a version that exists, of the assignment's own institution.
  FOREIGN KEY (institution_id, work_type, template_version)
    REFERENCES institution.work_template_version (institution_id, work_type, version),
  FOREIGN KEY (pinned_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE institution.assignment_template_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.assignment_template_pin FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_template_pin_owner ON institution.assignment_template_pin
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.assignment_template_pin FROM PUBLIC, ductus_app;

-- A pin is never changed in place: the version it freezes is the point of it. It is added or
-- removed (by the function below, as the owner), nothing else.
CREATE FUNCTION institution.reject_assignment_template_pin_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'assignment template pin is frozen' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER assignment_template_pin_frozen BEFORE UPDATE ON institution.assignment_template_pin
  FOR EACH ROW EXECUTE FUNCTION institution.reject_assignment_template_pin_update();
CREATE TRIGGER assignment_template_pin_no_truncate BEFORE TRUNCATE ON institution.assignment_template_pin
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_assignment_template_pin_update();

-- The teacher switches the institution's template on or off for a course assignment.
CREATE FUNCTION app.set_assignment_template(p_assignment_id uuid, p_use boolean) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_work_type text;
  v_pinned integer;
  v_latest integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_assignment_id IS NULL OR p_use IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- The work type of the current version, only of a course assignment of the caller's
  -- institution whose course the caller teaches; the row is locked so two switches queue.
  SELECT v.work_type INTO v_work_type
    FROM institution.assignment a
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version AND v.institution_id = a.institution_id
   WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id AND a.course_id IS NOT NULL
     AND institution.actor_course_role(a.course_id) = 'teacher'
     FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  IF NOT p_use THEN
    DELETE FROM institution.assignment_template_pin WHERE assignment_id = p_assignment_id;
    RETURN 0;
  END IF;

  -- Already pinned: the frozen version stays, a later one is not taken over.
  SELECT p.template_version INTO v_pinned
    FROM institution.assignment_template_pin p WHERE p.assignment_id = p_assignment_id;
  IF v_pinned IS NOT NULL THEN
    RETURN v_pinned;
  END IF;

  SELECT max(t.version) INTO v_latest
    FROM institution.work_template_version t
   WHERE t.institution_id = actor.institution_id AND t.work_type = v_work_type;
  IF v_latest IS NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.assignment_template_pin
    (assignment_id, institution_id, work_type, template_version, pinned_by)
  VALUES (p_assignment_id, actor.institution_id, v_work_type, v_latest, actor.user_id);
  RETURN v_latest;
END
$$;

-- A student of the assignment's course reads the version pinned on it; no row when there is
-- no pin. Everyone else, the teacher and the administrator included, is refused here: the
-- teacher knows the version from the switch and reads the template through the institution
-- route.
CREATE FUNCTION app.read_assignment_template(p_assignment_id uuid)
RETURNS TABLE (version integer, title_page jsonb, sections jsonb, citation_style text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM institution.assignment a
     WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id AND a.course_id IS NOT NULL
       AND institution.actor_course_role(a.course_id) = 'student'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT t.version, t.title_page, t.sections, t.citation_style
      FROM institution.assignment_template_pin p
      JOIN institution.work_template_version t
        ON t.institution_id = p.institution_id AND t.work_type = p.work_type AND t.version = p.template_version
     WHERE p.assignment_id = p_assignment_id;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_assignment_template_pin_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_assignment_template(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_assignment_template(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_assignment_template(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_assignment_template(uuid) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.read_assignment_template(uuid);
DROP FUNCTION app.set_assignment_template(uuid, boolean);
DROP TABLE institution.assignment_template_pin;
DROP FUNCTION institution.reject_assignment_template_pin_update();
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
