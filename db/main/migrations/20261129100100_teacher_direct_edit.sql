-- migrate:up
-- SRV-1702 (M6.4, DAN-420; D-21, D-34, D-244; Ductus docs/backend/suradnja.md
-- 4.15, invariants 5 to 8): direct edits of a teacher on a student's work.
-- Suggestions are the default; the student owner alone turns direct edits on
-- and may turn them off at any time, at once and without the other side. While
-- they are on, a teacher of the work may publish a new last state of the work
-- on the live channel (live.document.put, If-Match with the ETag of the state
-- read), which the student's client applies as its own next state (D-34: an
-- edit the student's client applies; the student stays the one writer of the
-- document, its revisions, segments and receipts). Every accepted teacher edit
-- is recorded with source teacher and its author, so the record of the process
-- marks it as the teacher's.
--
--   collaboration.direct_edit_setting        current mode of a work, one row;
--                                            the lock every write takes first
--   collaboration.direct_edit_setting_change history of the mode, append only
--   collaboration.teacher_edit               accepted teacher edits, append only
--   collaboration.set_direct_edit            the student owner sets the mode
--   collaboration.read_direct_edit           the mode, the same for both sides
--   collaboration.list_direct_edit_record    the history and the teacher edits
--   collaboration.publish_teacher_direct_edit a teacher publishes a live state
--   collaboration.delete_direct_edit         retention only
--
-- The setting is per work (open question #1808-1 decided here for the pilot as
-- the narrower reading: one setting for every teacher of the work); only the
-- student changes it (#1808-3 open: until answered the teacher cannot). The
-- mode of an edit is read under the lock of the setting row when the edit is
-- written, never from the teacher's client: an edit after revocation is
-- refused (ZD403), turning direct edits on again does not act backwards.
-- Nothing here reads or writes schema evidence but through document_scope,
-- lock_document_for_write and document_submitted, as the revision requests.
-- Lock order: setting, document, live state; the commit and submission paths
-- take no lock of schema collaboration, so there is no cycle.
-- Errors carry no input: ZD401 no session, ZD403 no relation, not allowed,
-- not on, submitted or not there (one answer), ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- One sequence for the history and the teacher edits: one total order of the
-- record of a work, the same on every reading.
CREATE SEQUENCE collaboration.direct_edit_seq AS bigint
  MINVALUE 1 MAXVALUE 9007199254740991 NO CYCLE;

CREATE TABLE collaboration.direct_edit_setting (
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'suggestions' CHECK (mode IN ('suggestions', 'direct')),
  changed_at timestamptz,
  PRIMARY KEY (document_id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

CREATE TABLE collaboration.direct_edit_setting_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint NOT NULL DEFAULT nextval('collaboration.direct_edit_seq') UNIQUE,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  institution_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('suggestions', 'direct')),
  actor_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (document_id, institution_id) REFERENCES collaboration.direct_edit_setting (document_id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX direct_edit_setting_change_document_idx
  ON collaboration.direct_edit_setting_change (document_id, institution_id, seq);

CREATE TABLE collaboration.teacher_edit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint NOT NULL DEFAULT nextval('collaboration.direct_edit_seq') UNIQUE,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  author_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'teacher' CHECK (source = 'teacher'),
  -- The mode under which the edit was accepted, fixed at writing (4.15 t. 7).
  mode text NOT NULL DEFAULT 'direct' CHECK (mode = 'direct'),
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (author_id <> owner_id),
  CHECK (previous_hash <> content_hash),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX teacher_edit_document_idx ON collaboration.teacher_edit (document_id, institution_id, seq);

ALTER TABLE collaboration.direct_edit_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.direct_edit_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY direct_edit_setting_owner ON collaboration.direct_edit_setting TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE collaboration.direct_edit_setting_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.direct_edit_setting_change FORCE ROW LEVEL SECURITY;
CREATE POLICY direct_edit_setting_change_owner ON collaboration.direct_edit_setting_change TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE collaboration.teacher_edit ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.teacher_edit FORCE ROW LEVEL SECURITY;
CREATE POLICY teacher_edit_owner ON collaboration.teacher_edit TO ductus_identity USING (true) WITH CHECK (true);

-- The history and the teacher edits are never rewritten (4.15 t. 8): no
-- update, also not by the owner; they go only with the work (retention).
CREATE FUNCTION collaboration.refuse_direct_edit_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'append only' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER direct_edit_setting_change_append_only BEFORE UPDATE ON collaboration.direct_edit_setting_change
  FOR EACH ROW EXECUTE FUNCTION collaboration.refuse_direct_edit_rewrite();
CREATE TRIGGER teacher_edit_append_only BEFORE UPDATE ON collaboration.teacher_edit
  FOR EACH ROW EXECUTE FUNCTION collaboration.refuse_direct_edit_rewrite();

-- The student owner sets the mode: 'direct' turns direct edits on,
-- 'suggestions' revokes them. The value is absolute, so a repeated request
-- never gives a second change (unchanged); a revocation never waits for a
-- counter and acts at once: a teacher edit in flight holds the setting row
-- FOR SHARE, and every edit after this commit reads 'suggestions'. The time
-- answered is in the 5-minute window of P-03, as read_direct_edit gives it.
CREATE FUNCTION collaboration.set_direct_edit(p_document_id text, p_mode text)
RETURNS TABLE (outcome text, mode text, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
  v_current text;
  v_at timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('suggestions', 'direct') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- The setting row first (lock order: setting, document, live state).
  INSERT INTO collaboration.direct_edit_setting AS s (document_id, institution_id, assignment_id, owner_id)
  VALUES (p_document_id, scope.institution_id, scope.assignment_id, scope.principal_id)
  ON CONFLICT ON CONSTRAINT direct_edit_setting_pkey DO NOTHING;
  SELECT s.mode INTO v_current FROM collaboration.direct_edit_setting s
   WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id
     FOR UPDATE;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  IF app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_current = p_mode THEN
    RETURN QUERY SELECT 'unchanged'::text, s.mode, date_bin('5 minutes', s.changed_at, timestamptz '2000-01-01 00:00:00+00') FROM collaboration.direct_edit_setting s
      WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id;
    RETURN;
  END IF;
  UPDATE collaboration.direct_edit_setting s SET mode = p_mode, changed_at = v_at
   WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id;
  INSERT INTO collaboration.direct_edit_setting_change (document_id, institution_id, mode, actor_id, changed_at)
  VALUES (p_document_id, scope.institution_id, p_mode, actor.user_id, v_at);
  RETURN QUERY SELECT 'applied'::text, p_mode, date_bin('5 minutes', v_at, timestamptz '2000-01-01 00:00:00+00');
END
$$;

-- The mode of a work, the same row for the student and every teacher of the
-- work (4.15 t. 8). No row yet: suggestions, never changed. The time is
-- rounded down to the 5-minute window of P-03.
CREATE FUNCTION collaboration.read_direct_edit(p_document_id text)
RETURNS TABLE (mode text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
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
    SELECT coalesce(s.mode, 'suggestions'),
           date_bin('5 minutes', s.changed_at, timestamptz '2000-01-01 00:00:00+00')
      FROM (SELECT 1) one
      LEFT JOIN collaboration.direct_edit_setting s
        ON s.document_id = p_document_id AND s.institution_id = scope.institution_id;
END
$$;

-- The record of direct edits of a work in one order: each change of the mode
-- (always the student's) and each accepted teacher edit (source teacher, its
-- size in bytes). The same rows for both sides; no person id, no hash, no
-- text; times in the 5-minute window of P-03. At most the last 1000 entries,
-- oldest first.
CREATE FUNCTION collaboration.list_direct_edit_record(p_document_id text)
RETURNS TABLE (kind text, source text, mode text, body_bytes integer, at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
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
    SELECT r.kind, r.source, r.mode, r.body_bytes, date_bin('5 minutes', r.at, timestamptz '2000-01-01 00:00:00+00')
      FROM (
        SELECT * FROM (
          SELECT 'mode'::text AS kind, 'student'::text AS source, c.mode, NULL::integer AS body_bytes, c.changed_at AS at, c.seq
            FROM collaboration.direct_edit_setting_change c
           WHERE c.document_id = p_document_id AND c.institution_id = scope.institution_id
          UNION ALL
          SELECT 'teacher_edit', e.source, NULL, e.body_bytes, e.created_at, e.seq
            FROM collaboration.teacher_edit e
           WHERE e.document_id = p_document_id AND e.institution_id = scope.institution_id
        ) u ORDER BY u.seq DESC LIMIT 1000
      ) r
     ORDER BY r.seq;
END
$$;

-- A teacher of the work publishes a new last state of the work on the live
-- channel, only while the student has direct edits on. p_expected_hash is the
-- content hash (ETag) of the state the teacher read: the edit replaces exactly
-- that state, or it is a conflict and nothing is written. The teacher never
-- creates the first state of a work (conflict). An equal body is unchanged and
-- records nothing. An accepted edit is recorded with source teacher, its author
-- from the session, the hashes before and after and its size.
CREATE FUNCTION collaboration.publish_teacher_direct_edit(p_document_id text, p_expected_hash text, p_body text)
RETURNS TABLE (outcome text, write_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_mode text;
  v_hash text;
  v_new uuid := gen_random_uuid();
  v_current record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The mode under the lock of the setting row, never from the client (4.15 t. 7).
  SELECT s.mode INTO v_mode FROM collaboration.direct_edit_setting s
   WHERE s.document_id = p_document_id AND s.institution_id = scope.institution_id
     FOR SHARE;
  IF v_mode IS DISTINCT FROM 'direct' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  IF app.document_submitted(p_document_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 2097152
     OR p_expected_hash IS NULL OR p_expected_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');

  SELECT l.content_hash, l.write_token INTO v_current FROM collaboration.live_state l
   WHERE l.document_id = p_document_id AND l.institution_id = scope.institution_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_current.content_hash = v_hash THEN
    RETURN QUERY SELECT 'unchanged'::text, v_current.write_token;
  ELSIF v_current.content_hash = p_expected_hash THEN
    UPDATE collaboration.live_state l SET body = p_body, content_hash = v_hash, write_token = v_new
     WHERE l.document_id = p_document_id AND l.institution_id = scope.institution_id;
    INSERT INTO collaboration.teacher_edit
      (document_id, institution_id, assignment_id, owner_id, author_id, previous_hash, content_hash, body_bytes)
    VALUES (p_document_id, scope.institution_id, scope.assignment_id, scope.principal_id, actor.user_id,
            p_expected_hash, v_hash, octet_length(p_body));
    RETURN QUERY SELECT 'accepted'::text, v_new;
  ELSE
    -- The teacher never learns the student's write token.
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid;
  END IF;
END
$$;

-- For the retention role only: called in the same transaction as deleting a
-- document under its retention rule or on a student's withdrawal (D-12), as
-- delete_live_state. No foreign key cascades (033), so each table is named.
CREATE FUNCTION collaboration.delete_direct_edit(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.teacher_edit e WHERE e.document_id = p_document_id AND e.institution_id = p_institution_id;
  DELETE FROM collaboration.direct_edit_setting_change c WHERE c.document_id = p_document_id AND c.institution_id = p_institution_id;
  DELETE FROM collaboration.direct_edit_setting s WHERE s.document_id = p_document_id AND s.institution_id = p_institution_id;
$$;

REVOKE ALL ON FUNCTION
  collaboration.refuse_direct_edit_rewrite(),
  collaboration.set_direct_edit(text, text),
  collaboration.read_direct_edit(text),
  collaboration.list_direct_edit_record(text),
  collaboration.publish_teacher_direct_edit(text, text, text),
  collaboration.delete_direct_edit(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.set_direct_edit(text, text),
  collaboration.read_direct_edit(text),
  collaboration.list_direct_edit_record(text),
  collaboration.publish_teacher_direct_edit(text, text, text)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_direct_edit(text, uuid) TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_direct_edit(text, uuid);
DROP FUNCTION collaboration.publish_teacher_direct_edit(text, text, text);
DROP FUNCTION collaboration.list_direct_edit_record(text);
DROP FUNCTION collaboration.read_direct_edit(text);
DROP FUNCTION collaboration.set_direct_edit(text, text);
DROP TABLE collaboration.teacher_edit;
DROP TABLE collaboration.direct_edit_setting_change;
DROP TABLE collaboration.direct_edit_setting;
DROP FUNCTION collaboration.refuse_direct_edit_rewrite();
DROP SEQUENCE collaboration.direct_edit_seq;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
