-- migrate:up
-- SRV-ED43-DORADA-POSALJI (Ductus#2058, BLOK ED-43, owner approval in chat on
-- 26 Nov 2026): the student owner of a work sends the revision to the teacher
-- for review ("Pošalji doradu"). A send is one append-only record per round:
-- the round (1, 2, 3 … per work), an optional message to the teacher (the
-- same rule as every revision text, at most 2000 characters) and the highest
-- counter of the open revision requests it answers. It never writes the
-- document, a revision, a segment, a receipt, a hash or a request.
--
-- When (the only reading of "an open revision request exists" that cannot
-- skip a round): a send needs a revision request of the work in state open or
-- reopened whose counter (row_seq, one global sequence) is above the counter
-- the previous send answered. Sending again with nothing new open is not
-- allowed (ZD409), never a second round.
--
-- Why the counter is safe (QA on #796): every writer of a request takes
-- lock_document_for_write (FOR SHARE on the document row) before it draws its
-- row_seq, and keeps it to its commit. A send takes the document row FOR NO
-- KEY UPDATE (lock_document_for_send), which waits for every such writer still
-- open and makes every later one wait for the send. So when the send reads the
-- requests, each row_seq of the work drawn before it is committed and visible,
-- and each one drawn after it is higher than any it saw: a request created or
-- reopened after a round always starts the next round, whatever order two
-- teachers commit in. The same lock serializes two sends of the same work.
--
-- Who (C-23, from the relation, never from the role alone): only the student
-- owner of the work (collaboration.actor_role = 'student'). A teacher of the
-- work is ZD403; everybody else, a work of another institution and a work that
-- does not exist are ZD404 (not found), so nobody learns that a work exists.
--
-- Errors in check order: ZD401 no session, ZD404 not found, ZD403 teacher,
-- ZD422 invalid message, ZD409 submitted work or no new open request.
-- The retention delete of the requests (delete_revision_requests, called with
-- the document and by the orphan purge) now also removes the sends.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;

-- The lock of a send, as lock_document_for_write (20261106160000) but FOR NO
-- KEY UPDATE: it conflicts with the FOR SHARE every request writer holds, and
-- not with the FOR KEY SHARE of a foreign key check. Owned by the evidence
-- role and executable only by the identity role. A document outside the
-- caller's institution is ZD403 (send_revision has answered ZD404 before).
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION collaboration.lock_document_for_send(p_document_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM 1
    FROM evidence.document d
    JOIN app.current_actor() a ON a.institution_id = d.institution_id
   WHERE d.id = p_document_id
     FOR NO KEY UPDATE OF d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION collaboration.lock_document_for_send(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.lock_document_for_send(text) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- No foreign key to evidence.document, as revision_request: scope, assignment
-- and owner are copied from the document when the round is sent.
CREATE TABLE collaboration.revision_send (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  round integer NOT NULL CHECK (round BETWEEN 1 AND 1000),
  message text CHECK (message IS NULL OR collaboration.is_revision_text(message)),
  answered_seq bigint NOT NULL CHECK (answered_seq BETWEEN 1 AND 9007199254740991),
  sent_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (document_id, institution_id, round),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

-- Forced RLS with only the owner's policy: no runtime role has any privilege
-- on the table; the web role writes through send_revision alone.
ALTER TABLE collaboration.revision_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.revision_send FORCE ROW LEVEL SECURITY;
CREATE POLICY revision_send_owner ON collaboration.revision_send
  TO ductus_identity USING (true) WITH CHECK (true);

-- The student owner sends the revision for review. Order: session, scope and
-- relation, input, the send lock on the document (waits for every request
-- writer and every other send of the work still open), submitted, the
-- previous round, the open requests, write.
CREATE FUNCTION collaboration.send_revision(p_document_id text, p_message text)
RETURNS TABLE (round integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
  v_role text;
  v_open bigint;
  v_last record;
  v_round integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_role <> 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_message IS NOT NULL AND NOT coalesce(collaboration.is_revision_text(p_message), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM collaboration.lock_document_for_send(p_document_id);
  IF app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  SELECT s.round, s.answered_seq INTO v_last
    FROM collaboration.revision_send s
   WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id
   ORDER BY s.round DESC LIMIT 1;
  SELECT max(q.row_seq) INTO v_open
    FROM collaboration.revision_request q
   WHERE q.document_id = p_document_id AND q.institution_id = scope.institution_id
     AND q.state IN ('open', 'reopened');
  IF v_open IS NULL OR v_open <= coalesce(v_last.answered_seq, 0) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  v_round := coalesce(v_last.round, 0) + 1;
  IF v_round > 1000 THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO collaboration.revision_send
    (institution_id, assignment_id, owner_id, document_id, round, message, answered_seq)
  VALUES (scope.institution_id, scope.assignment_id, scope.principal_id, p_document_id, v_round, p_message, v_open);
  RETURN QUERY SELECT v_round;
END
$$;
REVOKE ALL ON FUNCTION collaboration.send_revision(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.send_revision(text, text) TO ductus_app;

-- As 20261106160000, and the sends of the document first (no foreign key
-- links them to the requests; the order only keeps the step readable).
CREATE OR REPLACE FUNCTION collaboration.delete_revision_requests(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.revision_send s
   WHERE s.document_id = p_document_id AND s.institution_id = p_institution_id;
  -- No foreign key of the application cascades (033), so the children go first.
  DELETE FROM collaboration.revision_response s
   USING collaboration.revision_request r
   WHERE s.request_id = r.id AND s.institution_id = r.institution_id
     AND r.document_id = p_document_id AND r.institution_id = p_institution_id;
  DELETE FROM collaboration.revision_request_version v
   USING collaboration.revision_request r
   WHERE v.request_id = r.id AND v.institution_id = r.institution_id
     AND r.document_id = p_document_id AND r.institution_id = p_institution_id;
  DELETE FROM collaboration.revision_request r
   WHERE r.document_id = p_document_id AND r.institution_id = p_institution_id;
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION collaboration.delete_revision_requests(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  -- No foreign key of the application cascades (033), so the children go first.
  DELETE FROM collaboration.revision_response s
   USING collaboration.revision_request r
   WHERE s.request_id = r.id AND s.institution_id = r.institution_id
     AND r.document_id = p_document_id AND r.institution_id = p_institution_id;
  DELETE FROM collaboration.revision_request_version v
   USING collaboration.revision_request r
   WHERE v.request_id = r.id AND v.institution_id = r.institution_id
     AND r.document_id = p_document_id AND r.institution_id = p_institution_id;
  DELETE FROM collaboration.revision_request r
   WHERE r.document_id = p_document_id AND r.institution_id = p_institution_id;
$$;
DROP FUNCTION collaboration.send_revision(text, text);
DROP TABLE collaboration.revision_send;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
-- The evidence role has no usage on the schema any more; the migrator,
-- a member of the owner role, drops its function.
DROP FUNCTION collaboration.lock_document_for_send(text);
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
