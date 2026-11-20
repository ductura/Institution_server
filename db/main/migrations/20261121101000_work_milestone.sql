-- migrate:up
-- SRV-1103: workflow milestones are configured per assignment. Each work can
-- override their deadlines independently. Neither RPC changes the workflow.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_milestone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title ~ '[^[:space:]]'),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  due_at timestamptz CHECK (due_at >= '0001-01-01T00:00:00Z' AND due_at < '10000-01-01T00:00:00Z'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'submitted', 'approved', 'returned')),
  UNIQUE (assignment_id, position),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id)
);

CREATE TABLE institution.work_milestone_deadline (
  document_id text NOT NULL,
  milestone_id uuid NOT NULL REFERENCES institution.work_milestone (id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL CHECK (due_at >= '0001-01-01T00:00:00Z' AND due_at < '10000-01-01T00:00:00Z'),
  PRIMARY KEY (milestone_id, document_id)
);

ALTER TABLE institution.work_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_milestone FORCE ROW LEVEL SECURITY;
CREATE POLICY work_milestone_owner ON institution.work_milestone
  TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE institution.work_milestone_deadline ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_milestone_deadline FORCE ROW LEVEL SECURITY;
CREATE POLICY work_milestone_deadline_owner ON institution.work_milestone_deadline
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.work_milestone, institution.work_milestone_deadline FROM PUBLIC, ductus_app;

CREATE FUNCTION app.read_work_milestones(p_document_id text)
RETURNS TABLE (id uuid, title text, description text, due_at timestamptz, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS NULL
     OR collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;

  RETURN QUERY SELECT m.id, m.title, m.description, coalesce(d.due_at, m.due_at), m.state
    FROM institution.work_milestone m
    LEFT JOIN institution.work_milestone_deadline d ON d.milestone_id = m.id AND d.document_id = p_document_id
   WHERE m.institution_id = v_scope.institution_id AND m.assignment_id = v_scope.assignment_id
   ORDER BY m.position;
END
$$;

CREATE FUNCTION app.set_work_milestone_due(p_document_id text, p_milestone_id uuid, p_due_at timestamptz)
RETURNS TABLE (id uuid, title text, description text, due_at timestamptz, state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
  v_milestone institution.work_milestone;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_role <> 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_due_at IS NULL OR p_due_at < '0001-01-01T00:00:00Z' OR p_due_at >= '10000-01-01T00:00:00Z' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  -- Take the same document lock as collaboration writes before checking final submission.
  PERFORM collaboration.lock_document_for_write(p_document_id);
  SELECT * INTO v_milestone FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_scope.institution_id
     AND m.assignment_id = v_scope.assignment_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;

  INSERT INTO institution.work_milestone_deadline (document_id, milestone_id, due_at)
  VALUES (p_document_id, p_milestone_id, p_due_at)
  ON CONFLICT (milestone_id, document_id) DO UPDATE SET due_at = EXCLUDED.due_at;
  RETURN QUERY SELECT v_milestone.id, v_milestone.title, v_milestone.description, p_due_at, v_milestone.state;
END
$$;

REVOKE ALL ON FUNCTION app.read_work_milestones(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_milestone_due(text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_milestones(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_milestone_due(text, uuid, timestamptz) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.set_work_milestone_due(text, uuid, timestamptz);
DROP FUNCTION app.read_work_milestones(text);
DROP TABLE institution.work_milestone_deadline;
DROP TABLE institution.work_milestone;
SET LOCAL ROLE ductus_migrator;
