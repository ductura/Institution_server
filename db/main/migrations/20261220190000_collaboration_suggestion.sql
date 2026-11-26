-- migrate:up
-- SRV-ED42-PRIJEDLOZI (Ductus#2058, PITANJE ED-42; owner approval in chat on
-- 26 Nov 2026): the store of a teacher's text suggestions (SRV-8F, D-34, C-9,
-- D-266 point 1; server/collaboration/suggestions). A suggestion is a record
-- of its own with an anchor, never a mark in the document and never a change
-- of it: the work's text changes only when its student owner accepts it and
-- publishes the result with its own live.document.put. Nothing here writes
-- the document, a revision, a segment, a receipt, the live state or a hash,
-- so a teacher's input never enters the hash chain of the work.
--
-- Who (C-23, from the relation, never from the role alone):
--   create  a teacher of the work (collaboration.actor_role = 'teacher');
--           the student owner is ZD403.
--   list    the teacher of the work and its student owner, the same rows.
--   decide  only the student owner (accept or reject); a teacher is ZD403.
-- Everybody else, a work or suggestion of another institution and one that
-- does not exist are ZD404, so nobody learns that it exists.
--
-- A suggestion is decided once: only a pending one moves (nextState in
-- server/collaboration/suggestions); a second decision is ZD409. A submitted
-- work takes no new suggestion and no decision (ZD409).
--
-- The anchor is checked against the live state by the HTTP edge before
-- create; the database binds the suggestion to that state by its hash
-- (base_hash) and refuses a create whose state has moved on (ZD409). On
-- accept the edge applies the suggestion to the current live state in the
-- same transaction and rolls the decision back when the anchor no longer
-- resolves, so an accepted suggestion always came with its text.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- isSuggestionText (suggestion.ts): NFC, at most 2000 characters, no control
-- character at all (a paragraph has no line break) and no bidi control. The
-- empty text removes the quote.
CREATE FUNCTION collaboration.is_suggestion_text(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_text IS NOT NULL AND p_text IS NFC NORMALIZED
    AND char_length(p_text) <= 2000
    AND p_text !~ '[[:cntrl:]]'
    AND p_text !~ E'[\u0080-\u009F‪-‮⁦-⁩]'
$$;

-- No foreign key to evidence.document, as revision_send: scope, assignment
-- and owner are copied from the document when the suggestion is made.
CREATE TABLE collaboration.suggestion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the list: creation order, also within one instant.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  author_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  anchor jsonb NOT NULL CHECK (collaboration.is_text_anchor(anchor)),
  text text NOT NULL CHECK (collaboration.is_suggestion_text(text)),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  decided_at timestamptz,
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK (text <> anchor->>'quote'),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX suggestion_document ON collaboration.suggestion (document_id, institution_id, seq);

-- Forced RLS with only the owner's policy: no runtime role has any privilege
-- on the table; the web role reads and writes through the three RPCs alone.
ALTER TABLE collaboration.suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY suggestion_owner ON collaboration.suggestion
  TO ductus_identity USING (true) WITH CHECK (true);

-- The most suggestions one work holds, in any state; the list is bounded by it.
CREATE FUNCTION collaboration.suggestion_max() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 500 $$;

-- A teacher of the work suggests a text for an anchored quote of the live
-- state whose hash is p_base_hash. Order: session, scope and relation, input,
-- the lock of the work, submitted, the live state, the bound, write. The lock
-- makes two creates of the same work wait for each other, so the bound is
-- counted with every earlier create committed and never passed.
CREATE FUNCTION collaboration.create_suggestion(
  p_document_id text, p_anchor jsonb, p_text text, p_base_hash text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_role text;
  v_hash text;
  v_id uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_role <> 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF NOT coalesce(collaboration.is_text_anchor(p_anchor), false)
     OR NOT coalesce(collaboration.is_suggestion_text(p_text), false)
     OR p_text = p_anchor->>'quote'
     OR coalesce(p_base_hash !~ '^[0-9a-f]{64}$', true) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'collaboration.suggestion:' || scope.institution_id || ':' || p_document_id, 0));
  IF app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  SELECT l.content_hash INTO v_hash FROM collaboration.live_state l
   WHERE l.document_id = p_document_id AND l.institution_id = scope.institution_id;
  IF v_hash IS DISTINCT FROM p_base_hash THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF (SELECT count(*) FROM collaboration.suggestion s
       WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id)
     >= collaboration.suggestion_max() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO collaboration.suggestion
    (institution_id, assignment_id, owner_id, author_id, document_id, anchor, text, base_hash)
  VALUES (scope.institution_id, scope.assignment_id, scope.principal_id, actor.user_id,
          p_document_id, p_anchor, p_text, p_base_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- One reading for the student owner and the teacher alike (PRODUCT 5, t. 5).
-- No person: is_own only tells a teacher her own suggestion. Times only to
-- the P-03 window of 5 minutes. Oldest first.
CREATE FUNCTION collaboration.list_suggestions(p_document_id text)
RETURNS TABLE (
  suggestion_id uuid, anchor jsonb, text text, state text, is_own boolean, base_hash text,
  created_window timestamptz, decided_window timestamptz
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
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN QUERY
    SELECT s.id, s.anchor, s.text, s.state, s.author_id = actor.user_id, s.base_hash,
           date_bin('5 minutes', s.created_at, timestamptz '2000-01-01 00:00:00+00'),
           date_bin('5 minutes', s.decided_at, timestamptz '2000-01-01 00:00:00+00')
      FROM collaboration.suggestion s
     WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id
     ORDER BY s.seq;
END
$$;

-- The student owner accepts or rejects a pending suggestion, once. Order:
-- session, the suggestion in the caller's institution and the relation,
-- input, the row lock, pending, submitted, the live state (accept), write.
-- Accept answers the live state it was decided on, for the edge to apply the
-- suggestion to in the same transaction; reject answers no state.
CREATE FUNCTION collaboration.decide_suggestion(p_suggestion_id uuid, p_action text)
RETURNS TABLE (document_id text, anchor jsonb, text text, live_hash text, live_body text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  v_row record;
  v_role text;
  -- Typed, not a record: a reject leaves them NULL, and the answer below
  -- never reads a record that was not assigned.
  v_live_hash text;
  v_live_body text;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT s.id, s.institution_id, s.assignment_id, s.owner_id, s.document_id, s.anchor, s.text
    INTO v_row
    FROM collaboration.suggestion s
   WHERE s.id = p_suggestion_id AND s.institution_id = actor.institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  v_role := collaboration.actor_role(v_row.institution_id, v_row.assignment_id, v_row.owner_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_role <> 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- Two decisions of the same suggestion wait for each other here; the
  -- second one finds it decided.
  PERFORM 1 FROM collaboration.suggestion s WHERE s.id = v_row.id FOR UPDATE;
  IF (SELECT s.state FROM collaboration.suggestion s WHERE s.id = v_row.id) <> 'pending' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  IF app.document_submitted(v_row.document_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  IF p_action = 'accept' THEN
    SELECT l.content_hash, l.body INTO v_live_hash, v_live_body FROM collaboration.live_state l
     WHERE l.document_id = v_row.document_id AND l.institution_id = v_row.institution_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
    END IF;
  END IF;
  UPDATE collaboration.suggestion s
     SET state = CASE p_action WHEN 'accept' THEN 'accepted' ELSE 'rejected' END,
         decided_at = statement_timestamp()
   WHERE s.id = v_row.id;
  RETURN QUERY SELECT v_row.document_id, v_row.anchor, v_row.text, v_live_hash, v_live_body;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_suggestion(text, jsonb, text, text),
  collaboration.list_suggestions(text),
  collaboration.decide_suggestion(uuid, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_suggestion(text, jsonb, text, text),
  collaboration.list_suggestions(text),
  collaboration.decide_suggestion(uuid, text)
TO ductus_app;

-- As 20261220180000, and the suggestions of the document first: the
-- retention delete of a work (with the document and by the orphan purge)
-- removes them with the other collaboration records.
CREATE OR REPLACE FUNCTION collaboration.delete_revision_requests(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.suggestion g
   WHERE g.document_id = p_document_id AND g.institution_id = p_institution_id;
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

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
-- The delete of 20261220180000, verbatim.
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
DROP FUNCTION collaboration.decide_suggestion(uuid, text);
DROP FUNCTION collaboration.list_suggestions(text);
DROP FUNCTION collaboration.create_suggestion(text, jsonb, text, text);
DROP FUNCTION collaboration.suggestion_max();
DROP TABLE collaboration.suggestion;
DROP FUNCTION collaboration.is_suggestion_text(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
