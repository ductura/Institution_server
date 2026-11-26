-- migrate:up
-- SRV-F4-EDI-R20 (F4, EDI-R20; Ductus#2058): the kind of a comment and a
-- general draft. A teacher's comment may carry a kind, one of the kinds of the
-- comment bank (must, sugg, q, praise; Q-6, decided by the orchestrator on
-- 26 Nov 2026), chosen when the draft is written and shown to the student
-- when it is published. The kind is optional: a comment without one reads as
-- before. A general comment (a thread with no text anchor, SRV-8A) could not be
-- drafted; create_comment_draft_v2 may, with an anchor that is null.
--
-- Additive: create_comment_draft keeps its signature and behaviour (no kind,
-- an anchor is required); list_comments and list_comment_drafts get one more
-- column, kind, and nothing else changes. Like a comment itself (D-266) none of
-- this writes the document, a revision, a segment, a receipt or a hash.
--
--   collaboration.comment.kind                null = no kind
--   collaboration.create_comment_draft_v2     the teacher opens a draft thread, anchored or general, with a kind
--   collaboration.list_comment_drafts         as before, plus kind
--   collaboration.list_comments               as before, plus kind
--
-- Access is as for create_comment_draft: the teacher of the work only
-- (collaboration.actor_role, decided on every call). ZD403 no relation, ZD422
-- invalid input (text, anchor, kind) or the bound of 500 drafts of one author
-- on one work.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

ALTER TABLE collaboration.comment ADD COLUMN kind text;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE collaboration.comment
  ADD CONSTRAINT comment_kind_check CHECK (kind IS NULL OR kind IN ('must', 'sugg', 'q', 'praise'));

-- As create_comment_draft, with a kind and an anchor that may be null (a general draft).
CREATE FUNCTION collaboration.create_comment_draft_v2(p_document_id text, p_body text, p_anchor jsonb, p_kind text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_thread uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- A json null arrives as SQL null or as the json value null: both are general.
  IF p_anchor IS NOT NULL AND jsonb_typeof(p_anchor) = 'null' THEN
    p_anchor := NULL;
  END IF;
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR (p_anchor IS NOT NULL AND NOT coalesce(collaboration.is_text_anchor(p_anchor), false))
     OR (p_kind IS NOT NULL AND NOT coalesce(p_kind IN ('must', 'sugg', 'q', 'praise'), false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('comment_draft:' || p_document_id || actor.user_id, 0));
  IF (SELECT count(*) >= 500 FROM collaboration.comment c
       WHERE c.author_id = actor.user_id AND c.published_at IS NULL
         AND c.thread_id IN (SELECT t.id FROM collaboration.comment_thread t
                              WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.comment_thread (institution_id, document_id, assignment_id, owner_id, anchor, created_by)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, p_anchor, actor.user_id)
  RETURNING id INTO v_thread;
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body, published_at, kind)
  VALUES (v_thread, scope.institution_id, 1, actor.user_id, 'teacher', p_body, NULL, p_kind);
  RETURN v_thread;
END
$$;

-- The caller's own drafts, as before, plus the kind. A new column changes the
-- result type, so the function is dropped and made again with its grant.
DROP FUNCTION collaboration.list_comment_drafts(text);
CREATE FUNCTION collaboration.list_comment_drafts(p_document_id text)
RETURNS TABLE (
  thread_id uuid, comment_id uuid, comment_position integer, body text, anchor jsonb, state text, created_window timestamptz, kind text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT t.id, c.id, c.position, c.body, t.anchor, t.state,
           date_bin('5 minutes', c.created_at, timestamptz '2000-01-01 00:00:00+00'), c.kind
    FROM collaboration.comment_thread t
    JOIN collaboration.comment c ON c.thread_id = t.id AND c.institution_id = t.institution_id
    WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id
      AND c.published_at IS NULL AND c.author_id = actor.user_id
    ORDER BY t.created_at, t.id, c.position;
END
$$;

-- The published comments, as before (20261214140000), plus the kind.
DROP FUNCTION collaboration.list_comments(text);
CREATE FUNCTION collaboration.list_comments(p_document_id text)
RETURNS TABLE (
  thread_id uuid, comment_id uuid, comment_position integer, author_role text, is_own boolean,
  body text, anchor jsonb, state text, created_window timestamptz, deleted_window timestamptz, revision bigint, kind text
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
           t.revision, c.kind
    FROM collaboration.comment_thread t
    JOIN collaboration.comment c ON c.thread_id = t.id AND c.institution_id = t.institution_id
    WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id
      AND c.published_at IS NOT NULL
    ORDER BY t.created_at, t.id, c.position;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_comment_draft_v2(text, text, jsonb, text),
  collaboration.list_comment_drafts(text),
  collaboration.list_comments(text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_comment_draft_v2(text, text, jsonb, text),
  collaboration.list_comment_drafts(text),
  collaboration.list_comments(text)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- A comment with a kind or a general draft exists only after this migration.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.create_comment_draft_v2(text, text, jsonb, text);
DROP FUNCTION collaboration.list_comment_drafts(text);
CREATE FUNCTION collaboration.list_comment_drafts(p_document_id text)
RETURNS TABLE (
  thread_id uuid, comment_id uuid, comment_position integer, body text, anchor jsonb, state text, created_window timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT t.id, c.id, c.position, c.body, t.anchor, t.state,
           date_bin('5 minutes', c.created_at, timestamptz '2000-01-01 00:00:00+00')
    FROM collaboration.comment_thread t
    JOIN collaboration.comment c ON c.thread_id = t.id AND c.institution_id = t.institution_id
    WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id
      AND c.published_at IS NULL AND c.author_id = actor.user_id
    ORDER BY t.created_at, t.id, c.position;
END
$$;
REVOKE ALL ON FUNCTION collaboration.list_comment_drafts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_comment_drafts(text) TO ductus_app;
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
ALTER TABLE collaboration.comment DROP CONSTRAINT comment_kind_check, DROP COLUMN kind;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
