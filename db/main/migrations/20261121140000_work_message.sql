-- migrate:up
-- SRV-1106 (Val 11, Ductus#2051; INVENTAR-editor E§3.5 mentor2 "Poruke", PO-22):
-- short messages next to a work, one conversation per work that its student and
-- the teachers of its assignment read and write alike. Like a comment (D-266,
-- Ductus docs/ARCHITECTURE.md §5a) a message is its own record next to the
-- work: nothing here writes the document, a revision, a segment, a receipt or
-- a hash, so a message never enters the hash chain of the work. No foreign key
-- to evidence.document: the document is checked when the message is written
-- and its assignment and owner are copied then.
--
--   collaboration.work_message         the messages; forced RLS, owner policy only
--   collaboration.create_work_message  the student of the work or a teacher of
--                                      its assignment writes one
--   collaboration.list_work_messages   the conversation of one work, oldest first
--   collaboration.delete_work_messages retention only: every message of a
--                                      document goes with the document
--
-- Access comes from the relation, never from the role alone (C-23): the same
-- relation as the comments, collaboration.actor_role, decided on every call,
-- so a teacher removed from the course loses the conversation at once. The
-- sender's role is the one the relation gave on the day of writing. The
-- institution and the author come from the session, never from a parameter.
-- Errors carry no input: ZD401 no session, ZD403 no relation (one answer for
-- every refusal, also for a document that does not exist), ZD422 invalid input
-- or the bound of 1000 messages of one work reached. Reading a conversation
-- writes no row of the access log: a message is not the student's text.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE collaboration.work_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the conversation: stable, and the same for every reader.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  author_id uuid NOT NULL,
  sender_role text NOT NULL CHECK (sender_role IN ('student', 'teacher')),
  body text NOT NULL CHECK (collaboration.is_comment_body(body)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((sender_role = 'student') = (author_id = owner_id)),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE UNIQUE INDEX work_message_seq_idx ON collaboration.work_message (seq);
CREATE INDEX work_message_document_idx ON collaboration.work_message (document_id, institution_id, seq);

ALTER TABLE collaboration.work_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.work_message FORCE ROW LEVEL SECURITY;
CREATE POLICY work_message_owner ON collaboration.work_message TO ductus_identity USING (true) WITH CHECK (true);

-- The student of the work or a teacher of its assignment writes a message.
CREATE FUNCTION collaboration.create_work_message(p_document_id text, p_body text)
RETURNS TABLE (message_id uuid, sender_role text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
  v_role text;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id);
  IF v_role IS NULL OR v_role NOT IN ('student', 'teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF NOT coalesce(collaboration.is_comment_body(p_body), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One writer per work at a time, so the bound holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('work_message:' || p_document_id, 0));
  IF (SELECT count(*) >= 1000 FROM collaboration.work_message m
       WHERE m.document_id = p_document_id AND m.institution_id = scope.institution_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.work_message AS m
      (institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body)
    VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id,
            actor.user_id, v_role, p_body)
    RETURNING m.id, m.sender_role, m.created_at;
END
$$;

-- The conversation of one work, oldest first by the order of writing: the
-- same rows for the student and every teacher of the work.
CREATE FUNCTION collaboration.list_work_messages(p_document_id text)
RETURNS TABLE (message_id uuid, sender_role text, body text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  scope record;
  v_role text;
BEGIN
  PERFORM 1 FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id);
  IF v_role IS NULL OR v_role NOT IN ('student', 'teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT m.id, m.sender_role, m.body, m.created_at
      FROM collaboration.work_message m
     WHERE m.document_id = p_document_id AND m.institution_id = scope.institution_id
     ORDER BY m.seq;
END
$$;

-- For the retention role only: called in the same transaction as deleting a
-- document under its retention rule or on a student's withdrawal (D-12), as
-- delete_teacher_notes, so the messages go when the work goes. No rows:
-- nothing happens. Takes and returns no text.
CREATE FUNCTION collaboration.delete_work_messages(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.work_message m WHERE m.document_id = p_document_id AND m.institution_id = p_institution_id
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_work_message(text, text),
  collaboration.list_work_messages(text),
  collaboration.delete_work_messages(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_work_message(text, text),
  collaboration.list_work_messages(text)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_work_messages(text, uuid) TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_work_messages(text, uuid);
DROP FUNCTION collaboration.list_work_messages(text);
DROP FUNCTION collaboration.create_work_message(text, text);
DROP TABLE collaboration.work_message;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
