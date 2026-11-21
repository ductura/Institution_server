-- migrate:up
-- SRV-1703 (M6.7, Ductus#2052; D-51, N-03, N-05, D-246): delayed publishing of
-- a teacher's comments and the teacher's record of the last review of a work.
-- The comment bank (N-03) is the teacher's saved comment templates of SRV-8B
-- (collaboration.comment_template, 20261121120000): they are private to their
-- author already, so this migration adds nothing there; the routes and the
-- pgTAP rows below only expose and prove them.
--
-- D-51: a teacher chooses when the student sees a group of comments. A
-- teacher's comment is written as a draft (published_at is null) that only its
-- author reads, and publish_comments gives every draft of the author on one
-- work to the student at one instant. A comment of a student, and a comment
-- written by create_comment or reply_comment, is published when written
-- (published_at defaults to the statement time), so those calls behave as
-- before. A student never sees, replies to, resolves or counts a thread that
-- has no published comment: it reads as a missing one. Like a comment itself
-- (D-266) none of this writes the document, a revision, a segment, a receipt
-- or a hash.
--
-- N-05: collaboration.work_review holds, for one teacher and one work, the
-- revision the teacher last reviewed. It is the teacher's working record like
-- a note (D-130): the student never reads it. The server compares that
-- revision with the current one through the version comparison of SRV-9E.
--
--   collaboration.comment.published_at            null = a draft
--   collaboration.thread_for_actor                a student reaches only a thread with a published comment
--   collaboration.list_comments                   the student's reading: published comments only; the teacher's too
--   collaboration.create_comment_draft            the teacher of the work opens a draft thread
--   collaboration.reply_comment_draft             the teacher drafts a reply on a thread of the named work
--   collaboration.list_comment_drafts             the caller's own drafts on a work
--   collaboration.discard_comment_draft           the author removes a draft
--   collaboration.publish_comments                the author publishes every draft on a work at once
--   collaboration.document_revision               the current revision of a work (evidence role, identity may call)
--   collaboration.work_review                     last reviewed revision; forced RLS, owner policy only
--   collaboration.mark_work_reviewed              the teacher records the current revision as reviewed
--   collaboration.get_work_review                 reviewed and current revision for the teacher
--   collaboration.delete_work_reviews             retention only
--
-- Access comes from the relation (C-23): collaboration.actor_role, decided on
-- every call. Errors carry no input: ZD401 no session, ZD403 no relation, not
-- the author or no such draft (one answer), ZD409 nothing to publish, a
-- resolved thread or a work with no revision yet, ZD422 invalid input or a
-- bound reached (500 drafts of one author on one work).
SET LOCAL ROLE ductus_migrator;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;

-- The one way from the collaboration schema to the revision of a work, as
-- document_scope: owned by the evidence role, executable by the identity role.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION collaboration.document_revision(p_document_id text, OUT institution_id uuid, OUT current_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT d.institution_id, d.current_revision FROM evidence.document d WHERE d.id = p_document_id
$$;
REVOKE ALL ON FUNCTION collaboration.document_revision(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.document_revision(text) TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- Existing comments were all visible; they stay published at their creation.
ALTER TABLE collaboration.comment ADD COLUMN published_at timestamptz DEFAULT statement_timestamp();
UPDATE collaboration.comment SET published_at = created_at;
-- Only a teacher's comment can be a draft.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE collaboration.comment
  ADD CONSTRAINT comment_draft_teacher_check CHECK (published_at IS NOT NULL OR author_role = 'teacher');
CREATE INDEX comment_draft_idx ON collaboration.comment (thread_id) WHERE published_at IS NULL;

-- As before, and a student reaches only a thread with a published comment.
CREATE OR REPLACE FUNCTION collaboration.thread_for_actor(p_thread_id uuid, p_lock boolean, OUT thread_id uuid, OUT state text, OUT role text)
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  actor record;
  t record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO t FROM collaboration.comment_thread c WHERE c.id = p_thread_id AND c.institution_id = actor.institution_id;
  role := collaboration.actor_role(t.institution_id, t.assignment_id, t.owner_id);
  IF t.id IS NULL OR role IS NULL
     OR (role = 'student' AND NOT EXISTS (
           SELECT 1 FROM collaboration.comment x WHERE x.thread_id = t.id AND x.published_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_lock THEN
    SELECT c.state INTO t.state FROM collaboration.comment_thread c WHERE c.id = t.id FOR UPDATE;
  END IF;
  thread_id := t.id;
  state := t.state;
END
$$;

-- As before, but only published comments: a draft is read by no one here. A
-- thread with no published comment has no row. Same columns as before.
CREATE OR REPLACE FUNCTION collaboration.list_comments(p_document_id text)
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

-- The teacher of the work opens a draft thread: the opening comment is a draft.
CREATE FUNCTION collaboration.create_comment_draft(p_document_id text, p_body text, p_anchor jsonb) RETURNS uuid
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
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR NOT coalesce(collaboration.is_text_anchor(p_anchor), false) THEN
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
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body, published_at)
  VALUES (v_thread, scope.institution_id, 1, actor.user_id, 'teacher', p_body, NULL);
  RETURN v_thread;
END
$$;

-- The teacher drafts a reply to a thread of the work. The thread's state moves
-- when the reply is published, not now.
CREATE FUNCTION collaboration.reply_comment_draft(p_document_id text, p_thread_id uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  t record;
  v_doc record;
  v_last integer;
  v_comment uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO t FROM collaboration.thread_for_actor(p_thread_id, true);
  IF t.role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- A draft reply goes only to a thread the student can already see, or to the
  -- caller's own draft thread: never into another teacher's unpublished one.
  SELECT c.document_id, c.institution_id, c.created_by INTO v_doc
    FROM collaboration.comment_thread c WHERE c.id = t.thread_id;
  -- The thread must belong to the work named in the path.
  IF v_doc.document_id IS DISTINCT FROM p_document_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_doc.created_by <> actor.user_id AND NOT EXISTS (
       SELECT 1 FROM collaboration.comment x WHERE x.thread_id = t.thread_id AND x.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_comment_body(p_body), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF t.state = 'resolved' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  -- The same bound and lock as a new draft: 500 drafts of one author on one work.
  PERFORM pg_advisory_xact_lock(hashtextextended('comment_draft:' || v_doc.document_id || actor.user_id, 0));
  IF (SELECT count(*) >= 500 FROM collaboration.comment c
       WHERE c.author_id = actor.user_id AND c.published_at IS NULL
         AND c.thread_id IN (SELECT x.id FROM collaboration.comment_thread x
                              WHERE x.document_id = v_doc.document_id AND x.institution_id = v_doc.institution_id)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT max(c.position) INTO v_last FROM collaboration.comment c WHERE c.thread_id = t.thread_id;
  IF v_last >= 10000 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.comment (thread_id, institution_id, position, author_id, author_role, body, published_at)
  VALUES (t.thread_id, actor.institution_id, v_last + 1, actor.user_id, 'teacher', p_body, NULL)
  RETURNING id INTO v_comment;
  RETURN v_comment;
END
$$;

-- The caller's own drafts on a work, in the order of their threads. Only a
-- teacher of the work has any; a student reads nothing here.
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

-- The author removes a draft, under the lock publish_comments takes, so a
-- comment published meanwhile is never deleted (404 instead). Only the draft
-- goes; but the opening draft of an unpublished thread takes the thread's
-- other drafts with it (all the author's own: reply_comment_draft allows no
-- one else), so a student never meets a thread with no opening.
CREATE FUNCTION collaboration.discard_comment_draft(p_comment_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  c record;
  t record;
  v_doc record;
  v_gone uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT x.thread_id, x.position INTO c FROM collaboration.comment x
   WHERE x.id = p_comment_id AND x.institution_id = actor.institution_id
     AND x.author_id = actor.user_id AND x.published_at IS NULL;
  IF c.thread_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT th.document_id INTO v_doc FROM collaboration.comment_thread th WHERE th.id = c.thread_id;
  -- The lock first, as publish_comments takes it, then the thread row.
  PERFORM pg_advisory_xact_lock(hashtextextended('comment_draft:' || v_doc.document_id || actor.user_id, 0));
  -- The relation to the work is decided now, so a teacher removed from the
  -- course changes nothing; the thread row is locked here.
  SELECT * INTO t FROM collaboration.thread_for_actor(c.thread_id, true);
  IF t.role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked again under the lock: it may have been published meanwhile.
  DELETE FROM collaboration.comment x
   WHERE x.id = p_comment_id AND x.author_id = actor.user_id AND x.published_at IS NULL
  RETURNING x.id INTO v_gone;
  IF v_gone IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF c.position = 1 AND NOT EXISTS (
       SELECT 1 FROM collaboration.comment x WHERE x.thread_id = c.thread_id AND x.published_at IS NOT NULL) THEN
    DELETE FROM collaboration.comment x WHERE x.thread_id = c.thread_id AND x.published_at IS NULL;
    DELETE FROM collaboration.comment_thread th WHERE th.id = c.thread_id;
  END IF;
END
$$;

-- The author gives every draft on the work to the student at one instant and
-- the count back. A teacher's published reply makes an answered thread open,
-- as reply_comment does. No draft is a conflict.
CREATE FUNCTION collaboration.publish_comments(p_document_id text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_count integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('comment_draft:' || p_document_id || actor.user_id, 0));
  WITH published AS (
    UPDATE collaboration.comment c SET published_at = statement_timestamp()
     WHERE c.author_id = actor.user_id AND c.published_at IS NULL AND c.institution_id = scope.institution_id
       AND c.thread_id IN (SELECT t.id FROM collaboration.comment_thread t
                            WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id)
    RETURNING c.thread_id, c.position
  ), reopened AS (
    UPDATE collaboration.comment_thread t SET state = 'open', updated_at = now()
     WHERE t.state = 'answered' AND t.id IN (SELECT p.thread_id FROM published p WHERE p.position > 1)
    RETURNING t.id
  )
  SELECT count(*) INTO v_count FROM published;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN v_count;
END
$$;

-- The last reviewed revision of one work by one teacher. No foreign key to
-- evidence.document (as comment_thread): the document is checked when the
-- mark is written and its assignment and owner are copied then.
CREATE TABLE collaboration.work_review (
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  teacher_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  reviewed_revision bigint NOT NULL CHECK (reviewed_revision BETWEEN 1 AND 9007199254740991),
  reviewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (document_id, institution_id, teacher_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (teacher_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
ALTER TABLE collaboration.work_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.work_review FORCE ROW LEVEL SECURITY;
CREATE POLICY work_review_owner ON collaboration.work_review TO ductus_identity USING (true) WITH CHECK (true);

-- A teacher of the work records its current revision as the one just reviewed.
CREATE FUNCTION collaboration.mark_work_reviewed(p_document_id text)
RETURNS TABLE (reviewed_revision bigint, reviewed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
  rev record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO rev FROM collaboration.document_revision(p_document_id);
  IF rev.current_revision < 1 THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.work_review AS w
      (institution_id, document_id, teacher_id, assignment_id, owner_id, reviewed_revision)
    VALUES (scope.institution_id, p_document_id, actor.user_id, scope.assignment_id, scope.principal_id, rev.current_revision)
    ON CONFLICT (document_id, institution_id, teacher_id)
    DO UPDATE SET reviewed_revision = greatest(w.reviewed_revision, EXCLUDED.reviewed_revision),
                  reviewed_at = EXCLUDED.reviewed_at
    RETURNING w.reviewed_revision, w.reviewed_at;
END
$$;

-- The caller's last reviewed revision (null: never) and the current one.
CREATE FUNCTION collaboration.get_work_review(p_document_id text)
RETURNS TABLE (reviewed_revision bigint, current_revision bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
  rev record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO rev FROM collaboration.document_revision(p_document_id);
  RETURN QUERY
    SELECT (SELECT w.reviewed_revision FROM collaboration.work_review w
             WHERE w.document_id = p_document_id AND w.institution_id = scope.institution_id AND w.teacher_id = actor.user_id),
           rev.current_revision;
END
$$;

-- For the retention role only, as delete_teacher_notes: the marks go when the
-- work goes. Takes and returns no text.
CREATE FUNCTION collaboration.delete_work_reviews(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.work_review w WHERE w.document_id = p_document_id AND w.institution_id = p_institution_id
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_comment_draft(text, text, jsonb),
  collaboration.reply_comment_draft(text, uuid, text),
  collaboration.list_comment_drafts(text),
  collaboration.discard_comment_draft(uuid),
  collaboration.publish_comments(text),
  collaboration.mark_work_reviewed(text),
  collaboration.get_work_review(text),
  collaboration.delete_work_reviews(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_comment_draft(text, text, jsonb),
  collaboration.reply_comment_draft(text, uuid, text),
  collaboration.list_comment_drafts(text),
  collaboration.discard_comment_draft(uuid),
  collaboration.publish_comments(text),
  collaboration.mark_work_reviewed(text),
  collaboration.get_work_review(text)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_work_reviews(text, uuid) TO ductus_retention;
GRANT EXECUTE ON FUNCTION collaboration.list_comments(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- Drafts exist only in this migration, so they go with it.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_work_reviews(text, uuid);
DROP FUNCTION collaboration.get_work_review(text);
DROP FUNCTION collaboration.mark_work_reviewed(text);
DROP TABLE collaboration.work_review;
DROP FUNCTION collaboration.publish_comments(text);
DROP FUNCTION collaboration.discard_comment_draft(uuid);
DROP FUNCTION collaboration.list_comment_drafts(text);
DROP FUNCTION collaboration.reply_comment_draft(text, uuid, text);
DROP FUNCTION collaboration.create_comment_draft(text, text, jsonb);
DELETE FROM collaboration.comment WHERE published_at IS NULL;
DELETE FROM collaboration.comment_thread t WHERE NOT EXISTS (SELECT 1 FROM collaboration.comment c WHERE c.thread_id = t.id);
DROP INDEX collaboration.comment_draft_idx;
ALTER TABLE collaboration.comment DROP CONSTRAINT comment_draft_teacher_check, DROP COLUMN published_at;
CREATE OR REPLACE FUNCTION collaboration.list_comments(p_document_id text)
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
    ORDER BY t.created_at, t.id, c.position;
END
$$;
CREATE OR REPLACE FUNCTION collaboration.thread_for_actor(p_thread_id uuid, p_lock boolean, OUT thread_id uuid, OUT state text, OUT role text)
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  actor record;
  t record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO t FROM collaboration.comment_thread c WHERE c.id = p_thread_id AND c.institution_id = actor.institution_id;
  role := collaboration.actor_role(t.institution_id, t.assignment_id, t.owner_id);
  IF t.id IS NULL OR role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_lock THEN
    SELECT c.state INTO t.state FROM collaboration.comment_thread c WHERE c.id = t.id FOR UPDATE;
  END IF;
  thread_id := t.id;
  state := t.state;
END
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION collaboration.document_revision(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;
