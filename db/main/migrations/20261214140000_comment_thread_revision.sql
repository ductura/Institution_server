-- migrate:up
-- INT-15-SRV komentar-revizija-ugovor (Ductus#2055, Daniel 23. 11. 2026.): a
-- comment thread names the revision of the work it was written on. A
-- teacher's new thread must name one; a student's may. The revision must be a
-- revision of that document (1 or more) that the caller may see: for the
-- student who owns the work any revision up to the current one; for the
-- teacher of the work the same, but once the work is submitted (and the
-- submission not withdrawn) only up to the latest submitted revision, the text
-- the teacher reads (collaboration.read_live_state). It need not be the latest:
-- a teacher may comment on an earlier submitted version.
--
--   collaboration.comment_thread.revision    null for the threads written
--                                            before this and for drafts
--   collaboration.revision_visible           evidence role, identity may call
--   collaboration.create_comment/4           as create_comment/3, plus the revision
--   collaboration.create_general_comment/3   as create_general_comment/2, plus the revision
--   collaboration.list_comments              as before, plus the thread's revision
--                                            on every row: a reply inherits it
--
-- Access stays the relation (C-23): collaboration.actor_role first, so a
-- caller with no relation gets ZD403 whatever the revision, and a wrong
-- revision tells nothing about another work. Errors carry no input: ZD401 no
-- session, ZD403 no relation or no document (one answer), ZD422 invalid input,
-- a missing teacher revision or a revision the caller may not use.
--
-- The three- and two-argument functions stay as they were (revision null) for
-- their existing callers; the server calls only the new ones. Like a comment
-- itself (D-266) nothing here writes the document, a revision or a hash. The
-- table keeps its forced RLS and owner-only grants; no new table.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;

-- Whether p_revision is a revision of the document of the caller's
-- institution that a reader of the given role may name.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION collaboration.revision_visible(p_document_id text, p_revision bigint, p_teacher boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(p_revision >= 1, false)
     AND EXISTS (
       SELECT 1 FROM app.current_actor() a
         JOIN evidence.document_revision r ON r.institution_id = a.institution_id
        WHERE r.document_id = p_document_id AND r.revision = p_revision)
     AND (NOT p_teacher OR coalesce(p_revision <= (
       SELECT max(s.revision)
         FROM app.current_actor() a
         JOIN evidence.submission_request q ON q.institution_id = a.institution_id
         JOIN evidence.submission s ON s.submission_request_id = q.id AND s.institution_id = q.institution_id
        WHERE q.document_id = p_document_id AND NOT evidence.submission_withdrawn(s.id)), true))
$$;
REVOKE ALL ON FUNCTION collaboration.revision_visible(text, bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.revision_visible(text, bigint, boolean) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- Every existing thread has no revision, so the CHECK holds at once.
ALTER TABLE collaboration.comment_thread
  ADD COLUMN revision bigint,
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT comment_thread_revision_check CHECK (revision IS NULL OR revision BETWEEN 1 AND 9007199254740991);

-- The revision a new thread of this role may carry: a teacher must name one,
-- a student may; either way it must be visible (revision_visible).
CREATE FUNCTION collaboration.check_thread_revision(p_document_id text, p_role text, p_revision bigint) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  IF p_revision IS NULL THEN
    IF p_role = 'teacher' THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    RETURN;
  END IF;
  IF NOT collaboration.revision_visible(p_document_id, p_revision, p_role = 'teacher') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION collaboration.check_thread_revision(text, text, bigint) FROM PUBLIC;

CREATE FUNCTION collaboration.create_comment(p_document_id text, p_body text, p_anchor jsonb, p_revision bigint) RETURNS uuid
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
     OR NOT coalesce(collaboration.is_text_anchor(p_anchor), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM collaboration.check_thread_revision(p_document_id, v_role, p_revision);
  INSERT INTO collaboration.comment_thread (institution_id, document_id, assignment_id, owner_id, anchor, state, created_by, revision)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, p_anchor,
          CASE WHEN v_role = 'student' THEN 'answered' ELSE 'open' END, actor.user_id, p_revision)
  RETURNING id INTO v_thread;
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body)
  VALUES (v_thread, scope.institution_id, 1, actor.user_id, v_role, p_body);
  RETURN v_thread;
END
$$;

CREATE FUNCTION collaboration.create_general_comment(p_document_id text, p_body text, p_revision bigint) RETURNS uuid
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
  IF NOT coalesce(collaboration.is_comment_body(p_body), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM collaboration.check_thread_revision(p_document_id, v_role, p_revision);
  INSERT INTO collaboration.comment_thread (institution_id, document_id, assignment_id, owner_id, anchor, state, created_by, revision)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, NULL,
          CASE WHEN v_role = 'student' THEN 'answered' ELSE 'open' END, actor.user_id, p_revision)
  RETURNING id INTO v_thread;
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body)
  VALUES (v_thread, scope.institution_id, 1, actor.user_id, v_role, p_body);
  RETURN v_thread;
END
$$;

REVOKE ALL ON FUNCTION collaboration.create_comment(text, text, jsonb, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION collaboration.create_general_comment(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.create_comment(text, text, jsonb, bigint) TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.create_general_comment(text, text, bigint) TO ductus_app;

-- As 20261129100200 (published comments only), plus the thread's revision on
-- every row. The result gains a column, so it is dropped and created again.
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
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION collaboration.list_comments(text);
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
DROP FUNCTION collaboration.create_general_comment(text, text, bigint);
DROP FUNCTION collaboration.create_comment(text, text, jsonb, bigint);
DROP FUNCTION collaboration.check_thread_revision(text, text, bigint);
ALTER TABLE collaboration.comment_thread DROP CONSTRAINT comment_thread_revision_check, DROP COLUMN revision;
RESET ROLE;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION collaboration.revision_visible(text, bigint, boolean);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;
