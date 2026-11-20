-- migrate:up
-- SRV-1103 (Ductus#2051; plan "Val 11", E§3.5 mentor2 "Etape", PO-22): the
-- milestones (etape) of one student's work and the change of the due date of
-- a given milestone. A milestone comes from the configured workflow of the
-- assignment (title, description, due date, state); this migration stores
-- them and offers the two things the interface needs: read the milestones of
-- a work, and let an authorised teacher change the DUE DATE of one. Nothing
-- else of a milestone is changed by any caller, and a work that is already
-- submitted has no change action: its milestones read as they were.
--
-- Only through the RPCs: no role but the owner holds a privilege on the
-- table, and its only policy is the owner's. Who may read or change comes
-- from the caller's relation to the work (collaboration.document_scope and
-- collaboration.actor_role, as work versions), never from a role alone (C-23):
-- the student of the work and a teacher of it read the same milestones and the
-- same due dates; only a teacher of the work changes a due date.
--
--   institution.work_milestone       the milestones; forced RLS
--   app.work_milestone_submitted     whether a work is submitted (evidence role)
--   app.read_work_milestones         the milestones of a work, for its student
--                                    or a teacher of it
--   app.set_work_milestone_due       a teacher changes the due date of one
--
-- Outcomes (one row): not_found for an unknown work, a work of another and a
-- milestone that is not the work's, one answer for all of them; forbidden for
-- the student of the work (a relation without the right to change); locked for
-- a submitted work. ZD401 no session, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_milestone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- The order of the milestones in the work, from the configured workflow.
  position integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title ~ '[^[:space:]]'),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  due_at timestamptz NOT NULL CHECK (isfinite(due_at) AND due_at BETWEEN '2000-01-01' AND '2100-01-01'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (assignment_id, student_id, position),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_milestone_student_idx ON institution.work_milestone (student_id);

ALTER TABLE institution.work_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_milestone FORCE ROW LEVEL SECURITY;
CREATE POLICY work_milestone_owner ON institution.work_milestone TO ductus_identity USING (true) WITH CHECK (true);

-- Only the due date moves: any other column of a row stays as written.
CREATE FUNCTION institution.work_milestone_due_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE'
     OR (NEW.id, NEW.institution_id, NEW.assignment_id, NEW.student_id, NEW.position, NEW.title,
         NEW.description, NEW.state, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.institution_id, OLD.assignment_id, OLD.student_id, OLD.position, OLD.title,
         OLD.description, OLD.state, OLD.created_at) THEN
    RAISE EXCEPTION 'only the due date of a milestone changes' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER work_milestone_due_only BEFORE UPDATE OR DELETE ON institution.work_milestone
  FOR EACH ROW EXECUTE FUNCTION institution.work_milestone_due_only();
CREATE TRIGGER work_milestone_no_truncate BEFORE TRUNCATE ON institution.work_milestone
  FOR EACH STATEMENT EXECUTE FUNCTION institution.work_milestone_due_only();

-- Whether the student's work on the assignment is submitted: a row in
-- evidence.submission (a request alone is not a submission). Owned by the
-- evidence role so that no other role needs a right on evidence tables.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION app.work_milestone_submitted(p_assignment_id uuid, p_student_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.current_actor() a
      JOIN evidence.submission s ON s.institution_id = a.institution_id
     WHERE s.assignment_id = p_assignment_id AND s.principal_id = p_student_id
  )
$$;
REVOKE ALL ON FUNCTION app.work_milestone_submitted(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_milestone_submitted(uuid, uuid) TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- The milestones of a work in order. A work the caller may not see reads as
-- missing. One STABLE read; writes nothing (milestones are no work content,
-- so a teacher's read is not an opening of the work).
CREATE FUNCTION app.read_work_milestones(p_document_id text)
RETURNS TABLE (outcome text, id uuid, title text, description text, due_at timestamptz, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  PERFORM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS NULL
     OR collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id) IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT 'found'::text, m.id, m.title, m.description, m.due_at, m.state
      FROM institution.work_milestone m
     WHERE m.institution_id = v_scope.institution_id AND m.assignment_id = v_scope.assignment_id
       AND m.student_id = v_scope.principal_id
     ORDER BY m.position;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'empty'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
  END IF;
END
$$;

-- A teacher of the work changes the due date of one milestone of it; the
-- answer is the updated milestone. The student of the work has no such right
-- (forbidden), and a submitted work has no such action (locked).
CREATE FUNCTION app.set_work_milestone_due(p_document_id text, p_milestone_id uuid, p_due_at timestamptz)
RETURNS TABLE (outcome text, id uuid, title text, description text, due_at timestamptz, state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
  v_row institution.work_milestone;
BEGIN
  PERFORM institution.require_actor();
  IF p_milestone_id IS NULL OR p_due_at IS NULL OR NOT isfinite(p_due_at)
     OR p_due_at NOT BETWEEN '2000-01-01' AND '2100-01-01' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_scope.institution_id
     AND m.assignment_id = v_scope.assignment_id AND m.student_id = v_scope.principal_id
   FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  IF v_role <> 'teacher' THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  IF app.work_milestone_submitted(v_scope.assignment_id, v_scope.principal_id) THEN
    RETURN QUERY SELECT 'locked'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY
    UPDATE institution.work_milestone m SET due_at = p_due_at, updated_at = statement_timestamp()
     WHERE m.id = v_row.id
    RETURNING 'updated'::text, m.id, m.title, m.description, m.due_at, m.state;
END
$$;

REVOKE ALL ON FUNCTION institution.work_milestone_due_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_milestones(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_milestone_due(text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_milestones(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_milestone_due(text, uuid, timestamptz) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.set_work_milestone_due(text, uuid, timestamptz);
DROP FUNCTION app.read_work_milestones(text);
DROP TABLE institution.work_milestone;
DROP FUNCTION institution.work_milestone_due_only();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.work_milestone_submitted(uuid, uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
