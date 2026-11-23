-- migrate:up
-- INT-15-SRV (Ductus#2055, c.7108278536): a comment thread names the revision
-- of the work it was written on. A teacher's new thread must name one; a
-- student's may. The revision must exist for that document and be one the
-- caller may see: the owning student any of their revisions, the teacher of
-- the work any revision up to the one they read (the newest standing
-- submission, or the current revision before there is one). It need not be the
-- newest: a teacher may comment on an older submitted version. A reply belongs
-- to its thread and so to the thread's revision. Threads written before this
-- migration, and drafts (create_comment_draft), keep a null revision.
--
-- Like a comment itself (D-266) none of this writes the document, a revision,
-- a segment, a receipt or a hash; the revision is only read.
--
--   collaboration.comment_thread.revision      null for older threads and drafts
--   collaboration.comment_revision_visible     evidence role, identity may call
--   collaboration.create_revision_comment      a thread, anchored or general, on a revision
--   collaboration.list_comments                as before, plus the thread's revision
--
-- Access comes from the relation (C-23): collaboration.actor_role, decided on
-- every call, before the revision is looked at, so a stranger learns nothing
-- of another's document or its revisions (ZD403 for both). Errors carry no
-- input: ZD401 no session, ZD403 no relation, ZD422 invalid input, a missing
-- revision of a teacher, or a revision that does not exist or that the caller
-- may not see (one answer).
SET LOCAL ROLE ductus_migrator;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;

-- The one look at the revisions of a work, as document_revision: owned by the
-- evidence role, executable by the identity role. The caller has already
-- decided the actor's role on the document.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION collaboration.comment_revision_visible(p_document_id text, p_institution_id uuid, p_revision bigint, p_role text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(p_revision >= 1, false)
     AND p_role IN ('teacher', 'student')
     AND EXISTS (
       SELECT 1 FROM evidence.document_revision r
        WHERE r.document_id = p_document_id AND r.institution_id = p_institution_id AND r.revision = p_revision)
     AND (p_role = 'student' OR p_revision <= coalesce(
       (SELECT max(s.revision) FROM evidence.submission_request q
          JOIN evidence.submission s ON s.submission_request_id = q.id AND s.institution_id = q.institution_id
         WHERE q.document_id = p_document_id AND q.institution_id = p_institution_id
           AND NOT evidence.submission_withdrawn(s.id)),
       (SELECT d.current_revision FROM evidence.document d
         WHERE d.id = p_document_id AND d.institution_id = p_institution_id)))
$$;
REVOKE ALL ON FUNCTION collaboration.comment_revision_visible(text, uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.comment_revision_visible(text, uuid, bigint, text) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- squawk-ignore adding-field-with-default,constraint-missing-not-valid
ALTER TABLE collaboration.comment_thread
  ADD COLUMN revision bigint CHECK (revision IS NULL OR revision BETWEEN 1 AND 9007199254740991);

-- The teacher of the work or the student who owns it opens a thread on a
-- revision; a null anchor makes it a general comment. Anyone else reads as a
-- missing document. The thread waits on the other side, as create_comment.
CREATE FUNCTION collaboration.create_revision_comment(p_document_id text, p_body text, p_anchor jsonb, p_revision bigint)
RETURNS uuid
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
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR (p_anchor IS NOT NULL AND NOT coalesce(collaboration.is_text_anchor(p_anchor), false))
     OR (v_role = 'teacher' AND p_revision IS NULL)
     OR (p_revision IS NOT NULL AND NOT collaboration.comment_revision_visible(
           p_document_id, scope.institution_id, p_revision, v_role)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.comment_thread (institution_id, document_id, assignment_id, owner_id, anchor, state, created_by, revision)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, p_anchor,
          CASE WHEN v_role = 'student' THEN 'answered' ELSE 'open' END, actor.user_id, p_revision)
  RETURNING id INTO v_thread;
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body)
  VALUES (v_thread, scope.institution_id, 1, actor.user_id, v_role, p_body);
  RETURN v_thread;
END
$$;
REVOKE ALL ON FUNCTION collaboration.create_revision_comment(text, text, jsonb, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.create_revision_comment(text, text, jsonb, bigint) TO ductus_app;

-- As 20261129100200, plus the revision of the thread on every row: a reply
-- carries the revision of the thread it answers. A new column changes the
-- result type, so the function is dropped and made again with its grant.
DROP FUNCTION collaboration.list_comments(text);
CREATE FUNCTION collaboration.list_comments(p_document_id text)
RETURNS TABLE (
  thread_id uuid, comment_id uuid, comment_position integer, author_role text, is_own boolean,
  body text, anchor jsonb, state text, created_window timestamptz, deleted_window timestamptz, revision bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT t.id, c.id, c.position, c.author_role, c.author_id = actor.user_id, c.body,
           CASE WHEN c.position = 1 THEN t.anchor END, t.state,
           date_bin('5 minutes', c.created_at, timestamptz '2000-01-01 00:00:00+00'),
           date_bin('5 minutes', c.deleted_at, timestamptz '2000-01-01 00:00:00+00'),
           t.revision
    FROM collaboration.comment_thread t
    JOIN collaboration.comment c ON c.thread_id = t.id AND c.institution_id = t.institution_id
    WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id
      AND c.published_at IS NOT NULL
    ORDER BY t.created_at, t.id, c.position;
END
$$;
REVOKE ALL ON FUNCTION collaboration.list_comments(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_comments(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.create_revision_comment(text, text, jsonb, bigint);
DROP FUNCTION collaboration.list_comments(text);
-- The read of 20261129100200, verbatim.
CREATE FUNCTION collaboration.list_comments(p_document_id text)
RETURNS TABLE (
  thread_id uuid, comment_id uuid, comment_position integer, author_role text, is_own boolean,
  body text, anchor jsonb, state text, created_window timestamptz, deleted_window timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT t.id, c.id, c.position, c.author_role, c.author_id = actor.user_id, c.body,
           CASE WHEN c.position = 1 THEN t.anchor END, t.state,
           date_bin('5 minutes', c.created_at, timestamptz '2000-01-01 00:00:00+00'),
           date_bin('5 minutes', c.deleted_at, timestamptz '2000-01-01 00:00:00+00')
    FROM collaboration.comment_thread t
    JOIN collaboration.comment c ON c.thread_id = t.id AND c.institution_id = t.institution_id
    WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id
      AND c.published_at IS NOT NULL
    ORDER BY t.created_at, t.id, c.position;
END
$$;
REVOKE ALL ON FUNCTION collaboration.list_comments(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_comments(text) TO ductus_app;
ALTER TABLE collaboration.comment_thread DROP COLUMN revision;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION collaboration.comment_revision_visible(text, uuid, bigint, text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;
