-- migrate:up
-- SRV-1521 (Ductus#2052, N-15 etape): the template of milestones of an institution.
--
-- A faculty keeps one template of milestones, versioned like its rules
-- (app.institution_config, SRV-1405): a list of {title, relativeDue?, submits} and the
-- flag require_final_stage_approval (default false; the final submission, N-09, is
-- independent of the approval of the last milestone, O2). A version is only ever added;
-- the administrator of the institution reads and replaces it (expected version, ZD409
-- when another one was added in between).
--
--   title        1..200 characters, as the title of a milestone
--   relativeDue  optional whole number of days (1..1095) after the work is created
--   submits      'topic_text' (the topic text of the work) or 'current_version' (the
--                version of the work at the moment of sending)
--
-- The template is applied when a mentorship assignment (the work of one person) is
-- created: an AFTER INSERT trigger copies the latest version into
-- institution.work_milestone, so the milestones are then the configuration of that work
-- alone and the mentor changes them per work (rename, deadline and delete are SRV-1520;
-- add and "use the template again" are here). A later version of the template never
-- changes a work that already has its milestones. No template, no milestones.
--
-- Who may (C-23, from the relation, never from the role alone):
--   read and replace the template  an administrator of the institution
--   add a milestone, apply the template again to one work  the mentor of that work
--   read the plan of milestones of a work  the student owner and the teachers of it
-- Applying the template again replaces the milestones of the work, so it is refused once
-- any milestone of the work was ever submitted (ZD409); adding is refused after the final
-- submission (ZD409), as is any change of a deadline (SRV-1103).
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed, ZD404 not there or no part in
-- the work, ZD409 conflict, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- What a milestone of a work sends; the existing rows keep the version of the work.
ALTER TABLE institution.work_milestone
  ADD COLUMN submits text NOT NULL DEFAULT 'current_version'
  CHECK (submits IN ('topic_text', 'current_version'));

CREATE TABLE institution.milestone_template_version (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  version integer NOT NULL CHECK (version >= 1),
  require_final_stage_approval boolean NOT NULL,
  milestones jsonb NOT NULL CHECK (jsonb_typeof(milestones) = 'array' AND jsonb_array_length(milestones) <= 20),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (institution_id, version),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE institution.milestone_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.milestone_template_version FORCE ROW LEVEL SECURITY;
CREATE POLICY milestone_template_version_owner ON institution.milestone_template_version
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.milestone_template_version FROM PUBLIC, ductus_app;

-- Append only, for every role: a stored version never changes and never goes.
CREATE FUNCTION institution.reject_milestone_template_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'milestone template version is immutable' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER milestone_template_version_immutable BEFORE UPDATE OR DELETE ON institution.milestone_template_version
  FOR EACH ROW EXECUTE FUNCTION institution.reject_milestone_template_change();
CREATE TRIGGER milestone_template_version_no_truncate BEFORE TRUNCATE ON institution.milestone_template_version
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_milestone_template_change();

-- The title of a milestone, as app.change_work_milestone checks it.
CREATE FUNCTION institution.is_milestone_title(p_title text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_title IS NOT NULL AND pg_catalog.char_length(p_title) BETWEEN 1 AND 200
    AND p_title ~ '[^[:space:]]' AND p_title IS NFC NORMALIZED AND p_title !~ '[[:cntrl:]]'
$$;

-- The list of a template: at most 20 objects, each exactly {title, submits} plus an
-- optional relativeDue (a whole number of days, 1..1095), nothing else.
CREATE FUNCTION institution.is_milestone_template_list(p_list jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
  v_key text;
BEGIN
  IF p_list IS NULL OR pg_catalog.jsonb_typeof(p_list) <> 'array' OR pg_catalog.jsonb_array_length(p_list) > 20
     OR pg_catalog.octet_length(p_list::text) > 16384 THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_list) e LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      RETURN false;
    END IF;
    FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_item) k LOOP
      IF v_key NOT IN ('title', 'relativeDue', 'submits') THEN
        RETURN false;
      END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(v_item -> 'title') IS DISTINCT FROM 'string'
       OR NOT institution.is_milestone_title(v_item ->> 'title')
       OR pg_catalog.jsonb_typeof(v_item -> 'submits') IS DISTINCT FROM 'string'
       OR (v_item ->> 'submits') NOT IN ('topic_text', 'current_version') THEN
      RETURN false;
    END IF;
    IF v_item ? 'relativeDue' THEN
      IF pg_catalog.jsonb_typeof(v_item -> 'relativeDue') <> 'number'
         OR (v_item ->> 'relativeDue')::numeric <> pg_catalog.trunc((v_item ->> 'relativeDue')::numeric)
         OR (v_item ->> 'relativeDue')::numeric NOT BETWEEN 1 AND 1095 THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

-- Copies the latest template of the institution into the milestones of an assignment
-- that has none. Nothing without a template. Returns the number of milestones made.
-- p_from is the moment the work was created (institution.assignment.created_at), so a
-- relativeDue counts from the creation of the work, however late the template is applied
-- again. relativeDue is a whole number, written 14 or 14.0, so it goes through numeric.
CREATE FUNCTION institution.apply_milestone_template(p_assignment_id uuid, p_from timestamptz)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_list jsonb;
  v_made integer;
BEGIN
  SELECT a.institution_id INTO v_institution FROM institution.assignment a WHERE a.id = p_assignment_id;
  SELECT t.milestones INTO v_list FROM institution.milestone_template_version t
   WHERE t.institution_id = v_institution ORDER BY t.version DESC LIMIT 1;
  IF v_list IS NULL THEN
    RETURN 0;
  END IF;
  INSERT INTO institution.work_milestone (institution_id, assignment_id, position, title, due_at, submits)
  SELECT v_institution, p_assignment_id, e.n::integer, e.item ->> 'title',
         CASE WHEN e.item ? 'relativeDue'
              THEN p_from + ((e.item ->> 'relativeDue')::numeric::integer * interval '1 day') END,
         e.item ->> 'submits'
    FROM pg_catalog.jsonb_array_elements(v_list) WITH ORDINALITY AS e(item, n);
  GET DIAGNOSTICS v_made = ROW_COUNT;
  RETURN v_made;
END
$$;

-- A mentorship assignment is the work of one person: it gets the template when it is made.
CREATE FUNCTION institution.assignment_apply_milestone_template() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.apply_milestone_template(NEW.id, NEW.created_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER assignment_apply_milestone_template AFTER INSERT ON institution.assignment
  FOR EACH ROW WHEN (NEW.mentorship_id IS NOT NULL)
  EXECUTE FUNCTION institution.assignment_apply_milestone_template();

-- The versions of the template of the caller's institution, in ascending order, for an
-- administrator of it.
CREATE FUNCTION app.read_milestone_template()
RETURNS TABLE (
  version integer, require_final_stage_approval boolean, milestones jsonb, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT t.version, t.require_final_stage_approval, t.milestones, t.created_at
      FROM institution.milestone_template_version t
     WHERE t.institution_id = v_institution
     ORDER BY t.version;
END
$$;

-- The administrator adds the next version. p_expected_version is the latest version the
-- administrator saw (0 when there was none); another version added in between gives
-- ZD409. The institution row is locked, so versions are numbered without gaps.
CREATE FUNCTION app.publish_milestone_template(
  p_expected_version integer, p_require_final_stage_approval boolean, p_milestones jsonb
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_latest integer;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_require_final_stage_approval IS NULL
     OR NOT institution.is_milestone_template_list(p_milestones) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM identity.institution i WHERE i.id = v_institution FOR UPDATE;
  SELECT coalesce(max(t.version), 0) INTO v_latest
    FROM institution.milestone_template_version t WHERE t.institution_id = v_institution;
  IF v_latest <> p_expected_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.milestone_template_version
    (institution_id, version, require_final_stage_approval, milestones, created_by)
  VALUES (v_institution, v_latest + 1, p_require_final_stage_approval, p_milestones, v_user);
  RETURN v_latest + 1;
END
$$;

-- The milestones of one work as it is configured, in workflow order: for the student
-- owner and the teachers of the work. The deadline is the one of this work.
CREATE FUNCTION app.read_work_milestone_plan(p_document_id text)
RETURNS TABLE (id uuid, "position" integer, title text, due_at timestamptz, submits text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  RETURN QUERY
    SELECT m.id, m.position, m.title, coalesce(d.due_at, m.due_at), m.submits
      FROM institution.work_milestone m
      LEFT JOIN institution.work_milestone_deadline d
        ON d.milestone_id = m.id AND d.institution_id = m.institution_id AND d.document_id = p_document_id
     WHERE m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id
     ORDER BY m.position;
END
$$;

-- The mentor adds a milestone at the end of the plan of the work. Not after the final
-- submission; at most 100 milestones.
CREATE FUNCTION app.add_work_milestone(
  p_document_id text, p_title text, p_due_at timestamptz, p_submits text
)
RETURNS TABLE (id uuid, "position" integer, title text, due_at timestamptz, submits text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_position integer;
  v_count integer;
  v_row record;
  v_next integer := 0;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'teacher' OR NOT v_ctx.o_mentor THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT institution.is_milestone_title(p_title) OR p_submits IS NULL
     OR p_submits NOT IN ('topic_text', 'current_version')
     OR (p_due_at IS NOT NULL AND (p_due_at < '0001-01-01T00:00:00Z' OR p_due_at >= '10000-01-01T00:00:00Z')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  PERFORM 1 FROM institution.assignment a
   WHERE a.id = v_ctx.o_assignment_id AND a.institution_id = v_ctx.o_institution_id FOR UPDATE;
  IF app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  -- The limit is 100 milestones, not position 100: deleting a milestone leaves a gap.
  SELECT count(*)::integer, coalesce(max(m.position), 0) + 1 INTO v_count, v_position
    FROM institution.work_milestone m
   WHERE m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id;
  IF v_count >= 100 THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF v_position > 100 THEN
    -- Close the gaps, keeping the order. Each row moves to a free slot at or below its own
    -- position, in ascending order, so the unique position never collides.
    FOR v_row IN SELECT m.id, m.position FROM institution.work_milestone m
                  WHERE m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id
                  ORDER BY m.position LOOP
      v_next := v_next + 1;
      IF v_row.position <> v_next THEN
        UPDATE institution.work_milestone m SET position = v_next
         WHERE m.id = v_row.id AND m.institution_id = v_ctx.o_institution_id;
      END IF;
    END LOOP;
    v_position := v_next + 1;
  END IF;
  INSERT INTO institution.work_milestone (institution_id, assignment_id, position, title, due_at, submits)
  VALUES (v_ctx.o_institution_id, v_ctx.o_assignment_id, v_position, p_title, p_due_at, p_submits);
  RETURN QUERY SELECT * FROM app.read_work_milestone_plan(p_document_id);
END
$$;

-- The mentor replaces the milestones of the work with the latest template of the
-- institution. Only while no milestone of the work was ever submitted and the work is not
-- submitted; without a template there is nothing to apply (ZD409).
CREATE FUNCTION app.apply_milestone_template_to_work(p_document_id text)
RETURNS TABLE (id uuid, "position" integer, title text, due_at timestamptz, submits text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_created timestamptz;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'teacher' OR NOT v_ctx.o_mentor THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  PERFORM 1 FROM institution.assignment a
   WHERE a.id = v_ctx.o_assignment_id AND a.institution_id = v_ctx.o_institution_id FOR UPDATE;
  IF app.document_submitted(p_document_id)
     OR NOT EXISTS (SELECT 1 FROM institution.milestone_template_version t
                     WHERE t.institution_id = v_ctx.o_institution_id)
     OR EXISTS (SELECT 1 FROM institution.work_milestone_event e
                 JOIN institution.work_milestone m ON m.id = e.milestone_id AND m.institution_id = e.institution_id
                WHERE m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  DELETE FROM institution.work_milestone_deadline d
   USING institution.work_milestone m
   WHERE d.milestone_id = m.id AND d.institution_id = m.institution_id
     AND m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id;
  DELETE FROM institution.work_milestone m
   WHERE m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id;
  SELECT a.created_at INTO v_created FROM institution.assignment a
   WHERE a.id = v_ctx.o_assignment_id AND a.institution_id = v_ctx.o_institution_id;
  PERFORM institution.apply_milestone_template(v_ctx.o_assignment_id, v_created);
  RETURN QUERY SELECT * FROM app.read_work_milestone_plan(p_document_id);
END
$$;

REVOKE ALL ON FUNCTION institution.reject_milestone_template_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_milestone_title(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_milestone_template_list(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.apply_milestone_template(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.assignment_apply_milestone_template() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_milestone_template() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_milestone_template(integer, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_milestone_plan(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.add_work_milestone(text, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_milestone_template_to_work(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_milestone_template() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.publish_milestone_template(integer, boolean, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_work_milestone_plan(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.add_work_milestone(text, text, timestamptz, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.apply_milestone_template_to_work(text) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.apply_milestone_template_to_work(text);
DROP FUNCTION app.add_work_milestone(text, text, timestamptz, text);
DROP FUNCTION app.read_work_milestone_plan(text);
DROP FUNCTION app.publish_milestone_template(integer, boolean, jsonb);
DROP FUNCTION app.read_milestone_template();
DROP TRIGGER assignment_apply_milestone_template ON institution.assignment;
DROP FUNCTION institution.assignment_apply_milestone_template();
DROP FUNCTION institution.apply_milestone_template(uuid, timestamptz);
DROP FUNCTION institution.is_milestone_template_list(jsonb);
DROP FUNCTION institution.is_milestone_title(text);
DROP TABLE institution.milestone_template_version;
DROP FUNCTION institution.reject_milestone_template_change();
ALTER TABLE institution.work_milestone DROP COLUMN submits;
SET LOCAL ROLE ductus_migrator;
