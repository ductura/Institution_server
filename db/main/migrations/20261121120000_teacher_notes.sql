-- migrate:up
-- SRV-8B (wave 8, Ductus#2051 c.7047670771; plan "Val 8", INVENTAR-editor
-- E§3.5 comments2): the mentor's working records of D-130, private notes on a
-- student's work and saved comment templates. Ductus docs/PRODUCT.md §5
-- rule 5 makes them the one exception to "the student sees what the teacher
-- sees": they are not a view of the work, so the student never gets them from
-- the server, they never enter the summary, an export or the submission, and
-- they are not part of the access log (rule 17). The prototype hid them only
-- in the display; here the server separates them (INVENTAR-editor §6).
--
-- Like a comment (D-266, Ductus docs/ARCHITECTURE.md §5a), a note is its own
-- record next to the work with an optional text anchor the client shows as a
-- decoration for its author alone. Nothing here writes the document, a
-- revision, a segment, a receipt or a hash, so the mentor's input never
-- enters the hash chain of the work. No foreign key to evidence.document, as
-- comment_thread: the document is checked when the note is written and its
-- assignment and owner are copied then.
--
--   collaboration.teacher_note             private notes; forced RLS, owner
--                                          policy only
--   collaboration.comment_template         saved comment templates of one
--                                          teacher; forced RLS, owner policy
--   collaboration.create_teacher_note      the teacher of the work writes a
--                                          note, with or without an anchor
--   collaboration.list_teacher_notes       the caller's own notes on a work
--   collaboration.delete_teacher_note      the author removes a note
--   collaboration.delete_teacher_notes     retention only: every note of a
--                                          document goes with the document
--   collaboration.create_comment_template  a confirmed teacher saves one
--   collaboration.list_comment_templates   the caller's own templates
--   collaboration.delete_comment_template  the author removes one
--
-- Access comes from the relation, never from the role alone (C-23): a note is
-- written and read only by a teacher of that work (collaboration.actor_role,
-- decided on every call, so a removed teacher loses it at once), and only its
-- author ever reads it; another teacher of the same work does not. A note
-- carries no measure and nothing Ductus computed (D-130), only the mentor's
-- own text. A template names no student and no work; it belongs to its
-- author, so it does not go with a work (assumption in the PR).
--
-- The institution and the author come from the session, never from a
-- parameter. Errors carry no input: ZD401 no session, ZD403 no relation or
-- not the author (one answer for every refusal, also for a document, note or
-- template that does not exist), ZD422 invalid input or a bound reached (500
-- notes of one author on one document, 200 templates of one author).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE collaboration.teacher_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  author_id uuid NOT NULL,
  -- Null: a note on the work as a whole.
  anchor jsonb CHECK (anchor IS NULL OR collaboration.is_text_anchor(anchor)),
  body text NOT NULL CHECK (collaboration.is_comment_body(body)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (author_id <> owner_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX teacher_note_document_idx ON collaboration.teacher_note (document_id, institution_id, author_id);

CREATE TABLE collaboration.comment_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  author_id uuid NOT NULL,
  -- The four kinds of a comment in the prototype (comments2 KIND).
  kind text NOT NULL CHECK (kind IN ('must', 'sugg', 'q', 'praise')),
  body text NOT NULL CHECK (collaboration.is_comment_body(body)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX comment_template_author_idx ON collaboration.comment_template (author_id, institution_id);

ALTER TABLE collaboration.teacher_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.teacher_note FORCE ROW LEVEL SECURITY;
ALTER TABLE collaboration.comment_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.comment_template FORCE ROW LEVEL SECURITY;
CREATE POLICY teacher_note_owner ON collaboration.teacher_note TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY comment_template_owner ON collaboration.comment_template TO ductus_identity USING (true) WITH CHECK (true);

-- The teacher of the work writes a private note on it.
CREATE FUNCTION collaboration.create_teacher_note(p_document_id text, p_body text, p_anchor jsonb DEFAULT NULL)
RETURNS TABLE (note_id uuid, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR (p_anchor IS NOT NULL AND NOT coalesce(collaboration.is_text_anchor(p_anchor), false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One writer per author and document at a time, so the bound holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher_note:' || p_document_id || ':' || actor.user_id, 0));
  IF (SELECT count(*) >= 500 FROM collaboration.teacher_note n
       WHERE n.document_id = p_document_id AND n.institution_id = scope.institution_id
         AND n.author_id = actor.user_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.teacher_note AS n
      (institution_id, document_id, assignment_id, owner_id, author_id, anchor, body)
    VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, actor.user_id, p_anchor, p_body)
    RETURNING n.id, n.created_at;
END
$$;

-- The caller's own notes on one work, oldest first, then by id. Only while
-- the caller is a teacher of the work; another teacher's notes never come.
CREATE FUNCTION collaboration.list_teacher_notes(p_document_id text)
RETURNS TABLE (note_id uuid, body text, anchor jsonb, created_at timestamptz)
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
    SELECT n.id, n.body, n.anchor, n.created_at
      FROM collaboration.teacher_note n
     WHERE n.document_id = p_document_id AND n.institution_id = scope.institution_id
       AND n.author_id = actor.user_id
     ORDER BY n.created_at, n.id;
END
$$;

-- The author removes a note, while still a teacher of the work. A note of
-- someone else, of another institution or none is ZD403.
CREATE FUNCTION collaboration.delete_teacher_note(p_note_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  n record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT t.id, t.institution_id, t.assignment_id, t.owner_id INTO n
    FROM collaboration.teacher_note t
   WHERE t.id = p_note_id AND t.institution_id = actor.institution_id AND t.author_id = actor.user_id
     FOR UPDATE;
  IF n.id IS NULL OR collaboration.actor_role(n.institution_id, n.assignment_id, n.owner_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  DELETE FROM collaboration.teacher_note t WHERE t.id = n.id;
END
$$;

-- For the retention role only: called in the same transaction as deleting a
-- document under its retention rule or on a student's withdrawal (D-12), as
-- delete_live_state, so the notes go when the work goes (D-130). No rows:
-- nothing happens. Takes and returns no text.
CREATE FUNCTION collaboration.delete_teacher_notes(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.teacher_note n WHERE n.document_id = p_document_id AND n.institution_id = p_institution_id
$$;

-- A teacher whose teacher role in the institution is confirmed and not
-- revoked saves a template ("U Ducturi vrijede za sve Vaše studente").
CREATE FUNCTION collaboration.create_comment_template(p_body text, p_kind text DEFAULT 'must')
RETURNS TABLE (template_id uuid, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT EXISTS (
    SELECT 1 FROM institution.institution_role r
     WHERE r.institution_id = actor.institution_id AND r.user_id = actor.user_id AND r.role = 'teacher'
       AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR NOT coalesce(p_kind IN ('must', 'sugg', 'q', 'praise'), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('comment_template:' || actor.user_id, 0));
  IF (SELECT count(*) >= 200 FROM collaboration.comment_template t
       WHERE t.author_id = actor.user_id AND t.institution_id = actor.institution_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.comment_template AS t (institution_id, author_id, kind, body)
    VALUES (actor.institution_id, actor.user_id, p_kind, p_body)
    RETURNING t.id, t.created_at;
END
$$;

-- The caller's own templates, oldest first, then by id. They are the
-- caller's own text about no one, so no relation beyond authorship is asked.
CREATE FUNCTION collaboration.list_comment_templates()
RETURNS TABLE (template_id uuid, kind text, body text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  RETURN QUERY
    SELECT t.id, t.kind, t.body, t.created_at
      FROM collaboration.comment_template t
     WHERE t.author_id = actor.user_id AND t.institution_id = actor.institution_id
     ORDER BY t.created_at, t.id;
END
$$;

-- The author removes a template; anyone else's, or none, is ZD403.
CREATE FUNCTION collaboration.delete_comment_template(p_template_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  DELETE FROM collaboration.comment_template t
   WHERE t.id = p_template_id AND t.author_id = actor.user_id AND t.institution_id = actor.institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_teacher_note(text, text, jsonb),
  collaboration.list_teacher_notes(text),
  collaboration.delete_teacher_note(uuid),
  collaboration.delete_teacher_notes(text, uuid),
  collaboration.create_comment_template(text, text),
  collaboration.list_comment_templates(),
  collaboration.delete_comment_template(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_teacher_note(text, text, jsonb),
  collaboration.list_teacher_notes(text),
  collaboration.delete_teacher_note(uuid),
  collaboration.create_comment_template(text, text),
  collaboration.list_comment_templates(),
  collaboration.delete_comment_template(uuid)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_teacher_notes(text, uuid) TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_comment_template(uuid);
DROP FUNCTION collaboration.list_comment_templates();
DROP FUNCTION collaboration.create_comment_template(text, text);
DROP FUNCTION collaboration.delete_teacher_notes(text, uuid);
DROP FUNCTION collaboration.delete_teacher_note(uuid);
DROP FUNCTION collaboration.list_teacher_notes(text);
DROP FUNCTION collaboration.create_teacher_note(text, text, jsonb);
DROP TABLE collaboration.comment_template;
DROP TABLE collaboration.teacher_note;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
