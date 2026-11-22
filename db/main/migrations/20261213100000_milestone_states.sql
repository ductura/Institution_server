-- migrate:up
-- SRV-1520 (Ductus#2052, N-15 etape): the state of each milestone of one work.
-- SRV-1103 configured the milestones of an assignment (institution.work_milestone,
-- its own `state` column is not used here) and a deadline per work. This step
-- adds what happens to a milestone of one work:
--
--   not_submitted -> submitted -> revision_requested -> approved
--                         ^------------------'
--
--   institution.work_milestone_progress  one row per work and milestone that was ever
--                                        submitted (state submitted, revision_requested
--                                        or approved; not_submitted is the absence of a row)
--   institution.work_milestone_event     append only: every submission, revision request
--                                        and approval, with the actor, the revision and the time
--
-- Who may (C-23, from the relation, never from the role alone):
--   submit            the student owner of the work
--   request-revision  the mentor of the work (the teacher of an assignment of a mentorship)
--   approve           the same
-- Nobody else, a teacher of a course included, writes a transition (ZD403); a person
-- without any part in the work reads as ZD404, as in SRV-1103.
--
-- Submitting freezes the REVISION of the work (evidence.document.current_revision) as a
-- reference; no content is copied outside the evidence record. The deadline of a
-- milestone and the revision deadline are reminders: no RPC here locks writing or the
-- final submission. A milestone that was ever submitted cannot be deleted (ZD409); its
-- title and deadline can still be changed. Renaming and deleting a milestone changes the
-- configuration of the assignment, so they are allowed only on the assignment of a
-- mentorship (the work of one person); a course assignment keeps its configuration.
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed, ZD404 not there or no
-- part in the work, ZD409 wrong state or the milestone was submitted, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_milestone_progress (
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  milestone_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('submitted', 'revision_requested', 'approved')),
  submitted_revision bigint NOT NULL CHECK (submitted_revision BETWEEN 0 AND 9007199254740991),
  submitted_at timestamptz NOT NULL,
  revision_comment text CHECK (revision_comment IS NULL OR
    (char_length(revision_comment) BETWEEN 1 AND 2000 AND revision_comment ~ '[^[:space:]]')),
  revision_due_at timestamptz CHECK (revision_due_at >= '0001-01-01T00:00:00Z' AND revision_due_at < '10000-01-01T00:00:00Z'),
  revision_requested_at timestamptz,
  approved_at timestamptz,
  approval_message text CHECK (approval_message IS NULL OR
    (char_length(approval_message) BETWEEN 1 AND 1000 AND approval_message ~ '[^[:space:]]')),
  PRIMARY KEY (milestone_id, institution_id, document_id),
  FOREIGN KEY (milestone_id, institution_id) REFERENCES institution.work_milestone (id, institution_id),
  CHECK ((state = 'revision_requested') = (revision_requested_at IS NOT NULL AND revision_comment IS NOT NULL)
         OR (state <> 'revision_requested')),
  CHECK ((state = 'approved') = (approved_at IS NOT NULL))
);

CREATE TABLE institution.work_milestone_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  milestone_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('submitted', 'revision_requested', 'approved')),
  actor_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  due_at timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (milestone_id, institution_id) REFERENCES institution.work_milestone (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_milestone_event_work_idx
  ON institution.work_milestone_event (institution_id, document_id, milestone_id, occurred_at, id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
CREATE FUNCTION institution.reject_work_milestone_event_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER work_milestone_event_append_only BEFORE UPDATE OR DELETE ON institution.work_milestone_event
  FOR EACH ROW EXECUTE FUNCTION institution.reject_work_milestone_event_change();
CREATE TRIGGER work_milestone_event_no_truncate BEFORE TRUNCATE ON institution.work_milestone_event
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_work_milestone_event_change();

ALTER TABLE institution.work_milestone_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_milestone_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY work_milestone_progress_owner ON institution.work_milestone_progress
  TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE institution.work_milestone_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_milestone_event FORCE ROW LEVEL SECURITY;
CREATE POLICY work_milestone_event_owner ON institution.work_milestone_event
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.work_milestone_progress, institution.work_milestone_event FROM PUBLIC, ductus_app;

-- The caller's part in a work and in its assignment. ZD401 without a session, ZD404
-- for a work the caller has no part in or that does not exist.
CREATE FUNCTION institution.work_milestone_context(
  p_document_id text,
  OUT o_institution_id uuid, OUT o_assignment_id uuid, OUT o_user_id uuid, OUT o_role text, OUT o_mentor boolean
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT r.user_id INTO o_user_id FROM institution.require_actor() r;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  o_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR o_role IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  o_institution_id := v_scope.institution_id;
  o_assignment_id := v_scope.assignment_id;
  -- The assignment of a mentorship: its teacher role is the mentor.
  SELECT a.mentorship_id IS NOT NULL INTO o_mentor
    FROM institution.assignment a WHERE a.id = o_assignment_id AND a.institution_id = o_institution_id;
  o_mentor := coalesce(o_mentor, false);
END
$$;

-- The milestones of one work with the state of each, in workflow order.
CREATE FUNCTION app.read_work_milestone_states(p_document_id text)
RETURNS TABLE (
  id uuid, title text, description text, due_at timestamptz, state text, ever_submitted boolean,
  submitted_revision bigint, submitted_at timestamptz, revision_comment text, revision_due_at timestamptz,
  revision_requested_at timestamptz, approved_at timestamptz, approval_message text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  RETURN QUERY
    SELECT m.id, m.title, m.description, coalesce(d.due_at, m.due_at),
           coalesce(p.state, 'not_submitted'),
           EXISTS (SELECT 1 FROM institution.work_milestone_event e
                    WHERE e.institution_id = m.institution_id AND e.document_id = p_document_id
                      AND e.milestone_id = m.id AND e.kind = 'submitted'),
           p.submitted_revision, p.submitted_at,
           CASE WHEN p.state = 'revision_requested' THEN p.revision_comment END,
           CASE WHEN p.state = 'revision_requested' THEN p.revision_due_at END,
           CASE WHEN p.state = 'revision_requested' THEN p.revision_requested_at END,
           p.approved_at, p.approval_message
      FROM institution.work_milestone m
      LEFT JOIN institution.work_milestone_deadline d
        ON d.milestone_id = m.id AND d.institution_id = m.institution_id AND d.document_id = p_document_id
      LEFT JOIN institution.work_milestone_progress p
        ON p.milestone_id = m.id AND p.institution_id = m.institution_id AND p.document_id = p_document_id
     WHERE m.institution_id = v_ctx.o_institution_id AND m.assignment_id = v_ctx.o_assignment_id
     ORDER BY m.position;
END
$$;

-- The student owner sends a milestone for review: the revision of the work at this moment
-- is frozen as a reference. From not_submitted or revision_requested only.
CREATE FUNCTION app.submit_work_milestone(p_document_id text, p_milestone_id uuid)
RETURNS TABLE (
  id uuid, title text, description text, due_at timestamptz, state text, ever_submitted boolean,
  submitted_revision bigint, submitted_at timestamptz, revision_comment text, revision_due_at timestamptz,
  revision_requested_at timestamptz, approved_at timestamptz, approval_message text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_state text;
  v_revision bigint;
  v_at timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id
     AND m.assignment_id = v_ctx.o_assignment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  v_revision := collaboration.document_import_revision(p_document_id);
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  SELECT p.state INTO v_state FROM institution.work_milestone_progress p
   WHERE p.milestone_id = p_milestone_id AND p.institution_id = v_ctx.o_institution_id
     AND p.document_id = p_document_id
     FOR UPDATE;
  IF v_state IN ('submitted', 'approved') THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_milestone_progress
    (institution_id, document_id, milestone_id, state, submitted_revision, submitted_at)
  VALUES (v_ctx.o_institution_id, p_document_id, p_milestone_id, 'submitted', v_revision, v_at)
  ON CONFLICT (milestone_id, institution_id, document_id) DO UPDATE
    SET state = 'submitted', submitted_revision = EXCLUDED.submitted_revision,
        submitted_at = EXCLUDED.submitted_at, revision_comment = NULL, revision_due_at = NULL,
        revision_requested_at = NULL;
  INSERT INTO institution.work_milestone_event
    (institution_id, document_id, milestone_id, kind, actor_id, revision, occurred_at)
  VALUES (v_ctx.o_institution_id, p_document_id, p_milestone_id, 'submitted', v_ctx.o_user_id, v_revision, v_at);
  RETURN QUERY SELECT * FROM app.read_work_milestone_states(p_document_id) r WHERE r.id = p_milestone_id;
END
$$;

-- The mentor asks for a revision of a submitted milestone: a comment is required, the
-- revision deadline is a reminder.
CREATE FUNCTION app.request_work_milestone_revision(
  p_document_id text, p_milestone_id uuid, p_comment text, p_revision_due_at timestamptz
)
RETURNS TABLE (
  id uuid, title text, description text, due_at timestamptz, state text, ever_submitted boolean,
  submitted_revision bigint, submitted_at timestamptz, revision_comment text, revision_due_at timestamptz,
  revision_requested_at timestamptz, approved_at timestamptz, approval_message text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_progress institution.work_milestone_progress;
  v_at timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'teacher' OR NOT v_ctx.o_mentor THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_comment IS NULL OR NOT collaboration.is_comment_body(p_comment)
     OR (p_revision_due_at IS NOT NULL AND (p_revision_due_at < '0001-01-01T00:00:00Z'
                                            OR p_revision_due_at >= '10000-01-01T00:00:00Z')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id
     AND m.assignment_id = v_ctx.o_assignment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT * INTO v_progress FROM institution.work_milestone_progress p
   WHERE p.milestone_id = p_milestone_id AND p.institution_id = v_ctx.o_institution_id
     AND p.document_id = p_document_id
     FOR UPDATE;
  IF NOT FOUND OR v_progress.state <> 'submitted' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.work_milestone_progress p
     SET state = 'revision_requested', revision_comment = p_comment,
         revision_due_at = p_revision_due_at, revision_requested_at = v_at
   WHERE p.milestone_id = p_milestone_id AND p.institution_id = v_ctx.o_institution_id
     AND p.document_id = p_document_id;
  INSERT INTO institution.work_milestone_event
    (institution_id, document_id, milestone_id, kind, actor_id, revision, note, due_at, occurred_at)
  VALUES (v_ctx.o_institution_id, p_document_id, p_milestone_id, 'revision_requested', v_ctx.o_user_id,
          v_progress.submitted_revision, p_comment, p_revision_due_at, v_at);
  RETURN QUERY SELECT * FROM app.read_work_milestone_states(p_document_id) r WHERE r.id = p_milestone_id;
END
$$;

-- The mentor approves a submitted milestone, with an optional short message.
CREATE FUNCTION app.approve_work_milestone(p_document_id text, p_milestone_id uuid, p_message text)
RETURNS TABLE (
  id uuid, title text, description text, due_at timestamptz, state text, ever_submitted boolean,
  submitted_revision bigint, submitted_at timestamptz, revision_comment text, revision_due_at timestamptz,
  revision_requested_at timestamptz, approved_at timestamptz, approval_message text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_progress institution.work_milestone_progress;
  v_at timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'teacher' OR NOT v_ctx.o_mentor THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_message IS NOT NULL AND (NOT collaboration.is_comment_body(p_message) OR char_length(p_message) > 1000) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id
     AND m.assignment_id = v_ctx.o_assignment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT * INTO v_progress FROM institution.work_milestone_progress p
   WHERE p.milestone_id = p_milestone_id AND p.institution_id = v_ctx.o_institution_id
     AND p.document_id = p_document_id
     FOR UPDATE;
  IF NOT FOUND OR v_progress.state <> 'submitted' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.work_milestone_progress p
     SET state = 'approved', approved_at = v_at, approval_message = p_message
   WHERE p.milestone_id = p_milestone_id AND p.institution_id = v_ctx.o_institution_id
     AND p.document_id = p_document_id;
  INSERT INTO institution.work_milestone_event
    (institution_id, document_id, milestone_id, kind, actor_id, revision, note, occurred_at)
  VALUES (v_ctx.o_institution_id, p_document_id, p_milestone_id, 'approved', v_ctx.o_user_id,
          v_progress.submitted_revision, p_message, v_at);
  RETURN QUERY SELECT * FROM app.read_work_milestone_states(p_document_id) r WHERE r.id = p_milestone_id;
END
$$;

-- A teacher changes the title and/or the deadline of one milestone, also after it was
-- submitted. NULL leaves a field as it is; both NULL is invalid. The deadline rule is
-- that of app.set_work_milestone_due (no change after the final submission); a title
-- belongs to the configuration of the assignment, so only the mentor of a mentorship
-- may change it.
CREATE FUNCTION app.change_work_milestone(
  p_document_id text, p_milestone_id uuid, p_title text, p_due_at timestamptz
)
RETURNS TABLE (
  id uuid, title text, description text, due_at timestamptz, state text, ever_submitted boolean,
  submitted_revision bigint, submitted_at timestamptz, revision_comment text, revision_due_at timestamptz,
  revision_requested_at timestamptz, approved_at timestamptz, approval_message text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF (p_title IS NULL AND p_due_at IS NULL)
     OR (p_title IS NOT NULL AND (char_length(p_title) NOT BETWEEN 1 AND 200 OR p_title !~ '[^[:space:]]'
                                  OR p_title IS NOT NFC NORMALIZED OR p_title ~ '[[:cntrl:]]'))
     OR (p_due_at IS NOT NULL AND (p_due_at < '0001-01-01T00:00:00Z' OR p_due_at >= '10000-01-01T00:00:00Z')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_title IS NOT NULL AND NOT v_ctx.o_mentor THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  PERFORM 1 FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id
     AND m.assignment_id = v_ctx.o_assignment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_due_at IS NOT NULL AND app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF p_title IS NOT NULL THEN
    UPDATE institution.work_milestone m SET title = p_title
     WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id;
  END IF;
  IF p_due_at IS NOT NULL THEN
    INSERT INTO institution.work_milestone_deadline (institution_id, document_id, milestone_id, due_at)
    VALUES (v_ctx.o_institution_id, p_document_id, p_milestone_id, p_due_at)
    ON CONFLICT (milestone_id, institution_id, document_id) DO UPDATE SET due_at = EXCLUDED.due_at;
  END IF;
  RETURN QUERY SELECT * FROM app.read_work_milestone_states(p_document_id) r WHERE r.id = p_milestone_id;
END
$$;

-- The mentor deletes a milestone that was never submitted (by any work of the assignment).
CREATE FUNCTION app.delete_work_milestone(p_document_id text, p_milestone_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_milestone_context(p_document_id);
  IF v_ctx.o_role <> 'teacher' OR NOT v_ctx.o_mentor THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id
     AND m.assignment_id = v_ctx.o_assignment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_milestone_event e
              WHERE e.milestone_id = p_milestone_id AND e.institution_id = v_ctx.o_institution_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  DELETE FROM institution.work_milestone_deadline d
   WHERE d.milestone_id = p_milestone_id AND d.institution_id = v_ctx.o_institution_id;
  DELETE FROM institution.work_milestone m
   WHERE m.id = p_milestone_id AND m.institution_id = v_ctx.o_institution_id;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_work_milestone_event_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_milestone_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_milestone_states(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.submit_work_milestone(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.request_work_milestone_revision(text, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approve_work_milestone(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.change_work_milestone(text, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_work_milestone(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_milestone_states(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.submit_work_milestone(text, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.request_work_milestone_revision(text, uuid, text, timestamptz) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.approve_work_milestone(text, uuid, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.change_work_milestone(text, uuid, text, timestamptz) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.delete_work_milestone(text, uuid) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.delete_work_milestone(text, uuid);
DROP FUNCTION app.change_work_milestone(text, uuid, text, timestamptz);
DROP FUNCTION app.approve_work_milestone(text, uuid, text);
DROP FUNCTION app.request_work_milestone_revision(text, uuid, text, timestamptz);
DROP FUNCTION app.submit_work_milestone(text, uuid);
DROP FUNCTION app.read_work_milestone_states(text);
DROP FUNCTION institution.work_milestone_context(text);
DROP TABLE institution.work_milestone_event;
DROP TABLE institution.work_milestone_progress;
DROP FUNCTION institution.reject_work_milestone_event_change();
SET LOCAL ROLE ductus_migrator;
