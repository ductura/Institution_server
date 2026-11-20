-- SRV-8A (wave 8, Ductus#2028): a general comment on a work, a thread with no
-- text anchor. A comment stays its own record next to the work (D-266, Ductus
-- docs/ARCHITECTURE.md §5a); nothing here touches the document or its hash
-- chain. create_comment keeps refusing a missing anchor; a general comment has
-- its own function, with the same access rule: the teacher of the work or the
-- student who owns it, anyone else reads as a missing document.
--
-- list_comments already returns the anchor of a thread's first comment, so a
-- general thread lists with a null anchor and needs no change.
-- migrate:up
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Every existing thread has a valid anchor, so the new CHECK holds at once.
ALTER TABLE collaboration.comment_thread
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT comment_thread_anchor_check,
  -- squawk-ignore ban-drop-not-null
  ALTER COLUMN anchor DROP NOT NULL,
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT comment_thread_anchor_check CHECK (anchor IS NULL OR collaboration.is_text_anchor(anchor));

CREATE FUNCTION collaboration.create_general_comment(p_document_id text, p_body text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_role text;
  v_thread uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF NOT coalesce(collaboration.is_comment_body(p_body), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.comment_thread (institution_id, document_id, assignment_id, owner_id, anchor, state, created_by)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, NULL,
          CASE WHEN v_role = 'student' THEN 'answered' ELSE 'open' END, actor.user_id)
  RETURNING id INTO v_thread;
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body)
  VALUES (v_thread, scope.institution_id, 1, actor.user_id, v_role, p_body);
  RETURN v_thread;
END
$$;

REVOKE ALL ON FUNCTION collaboration.create_general_comment(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.create_general_comment(text, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION collaboration.create_general_comment(text, text);
-- General threads cannot survive the old NOT NULL: they go with their comments.
DELETE FROM collaboration.comment c USING collaboration.comment_thread t
  WHERE c.thread_id = t.id AND c.institution_id = t.institution_id AND t.anchor IS NULL;
DELETE FROM collaboration.comment_thread WHERE anchor IS NULL;
ALTER TABLE collaboration.comment_thread
  DROP CONSTRAINT comment_thread_anchor_check,
  ALTER COLUMN anchor SET NOT NULL,
  ADD CONSTRAINT comment_thread_anchor_check CHECK (collaboration.is_text_anchor(anchor));

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
