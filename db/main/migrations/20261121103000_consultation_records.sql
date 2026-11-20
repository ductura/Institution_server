-- SRV-1105 (Ductus#2051, wave 11, N-12, D-47, PO-22): the shared record of a
-- consultation about one work, and the additions to it. A record is its own
-- row next to the work: it never writes the document, a revision or a
-- receipt (D-266). The teacher of the work's assignment and the student who
-- owns the work read and write the same record, with the relation of the
-- comments (collaboration.document_scope and actor_role); every other caller
-- gets the answer for a missing work (C-23). A record names the revision it
-- is about, and that revision must belong to the same work. A record and an
-- addition are never changed or deleted: the text is only added to.
-- Errors: ZD401 no session, ZD403 not allowed or not there (same answer),
-- ZD422 invalid input.
--
-- The one way from a record to the evidence schema is a helper of the
-- evidence role, executable only by the identity role, as document_scope is.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- Whether `p_revision` is a revision of `p_document_id` in the caller's institution.
CREATE FUNCTION collaboration.consultation_revision_exists(p_document_id text, p_revision bigint)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.current_actor() a
      JOIN evidence.document_revision r ON r.institution_id = a.institution_id
     WHERE r.document_id = p_document_id AND r.revision = p_revision
  )
$$;
REVOKE ALL ON FUNCTION collaboration.consultation_revision_exists(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.consultation_revision_exists(text, bigint) TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- NFC, no control character but newline and tab, no bidirectional override
-- or isolate; between p_min and p_max characters; with a non-space if p_min > 0.
CREATE FUNCTION collaboration.is_consultation_text(p_text text, p_min integer, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_text IS NOT NULL AND p_text IS NFC NORMALIZED
    AND char_length(p_text) BETWEEN p_min AND p_max
    AND (p_min = 0 OR p_text ~ '[^[:space:]]')
    AND translate(p_text, E'\n\t', '') !~ '[[:cntrl:]]'
    AND p_text !~ E'[‪-‮⁦-⁩]'
$$;

-- No foreign key to evidence.document or its revision: deleting a document
-- under its retention rule must not depend on a record. The work and the
-- revision are checked when the record is created; assignment and owner are
-- copied from the document then.
CREATE TABLE collaboration.consultation_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  held_on date NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  topic text NOT NULL CHECK (collaboration.is_consultation_text(topic, 1, 200)),
  agreement text NOT NULL CHECK (collaboration.is_consultation_text(agreement, 0, 2000)),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX consultation_record_document_idx ON collaboration.consultation_record (document_id, institution_id);

CREATE TABLE collaboration.consultation_addition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  body text NOT NULL CHECK (collaboration.is_consultation_text(body, 1, 2000)),
  author_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (record_id, institution_id) REFERENCES collaboration.consultation_record (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX consultation_addition_record_idx ON collaboration.consultation_addition (record_id, institution_id);

-- Forced RLS with only the owner's policy: the web role has no privilege on
-- either table and reads through the functions below alone, which never
-- return other people's ids or exact times.
ALTER TABLE collaboration.consultation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.consultation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE collaboration.consultation_addition ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.consultation_addition FORCE ROW LEVEL SECURITY;
CREATE POLICY consultation_record_owner ON collaboration.consultation_record TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY consultation_addition_owner ON collaboration.consultation_addition TO ductus_identity USING (true) WITH CHECK (true);

-- The records of a work, oldest meeting first, with their additions in the
-- order they were made. The same rows for the teacher and the student.
CREATE FUNCTION collaboration.list_consultation_records(p_document_id text)
RETURNS TABLE (record_id uuid, held_on date, revision bigint, topic text, agreement text,
               addition_id uuid, addition_body text, addition_minute timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT r.id, r.held_on, r.revision, r.topic, r.agreement,
           x.id, x.body, pg_catalog.date_trunc('minute', x.created_at, 'UTC')
      FROM collaboration.consultation_record r
      LEFT JOIN collaboration.consultation_addition x
        ON x.record_id = r.id AND x.institution_id = r.institution_id
     WHERE r.document_id = p_document_id AND r.institution_id = scope.institution_id
     ORDER BY r.held_on, r.created_at, r.id, x.created_at, x.id;
END
$$;

CREATE FUNCTION collaboration.create_consultation_record(
  p_document_id text, p_held_on date, p_revision bigint, p_topic text, p_agreement text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_id uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_held_on IS NULL OR p_revision IS NULL OR p_revision < 1
     OR NOT coalesce(collaboration.is_consultation_text(p_topic, 1, 200), false)
     OR NOT coalesce(collaboration.is_consultation_text(p_agreement, 0, 2000), false)
     OR NOT collaboration.consultation_revision_exists(p_document_id, p_revision) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.consultation_record
    (institution_id, document_id, assignment_id, owner_id, held_on, revision, topic, agreement, created_by)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id,
          p_held_on, p_revision, p_topic, p_agreement, actor.user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- One row: the record as the caller may read it, for the answer of the POST.
CREATE FUNCTION collaboration.add_consultation_addition(p_document_id text, p_record_id uuid, p_body text)
RETURNS TABLE (addition_id uuid, addition_minute timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  r record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- A record of another work reads as a missing one, whoever asks.
  SELECT c.id, c.institution_id INTO r FROM collaboration.consultation_record c
   WHERE c.id = p_record_id AND c.document_id = p_document_id AND c.institution_id = scope.institution_id;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_consultation_text(p_body, 1, 2000), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.consultation_addition (record_id, institution_id, body, author_id)
    VALUES (r.id, r.institution_id, p_body, actor.user_id)
    RETURNING consultation_addition.id, pg_catalog.date_trunc('minute', consultation_addition.created_at, 'UTC');
END
$$;

REVOKE ALL ON FUNCTION collaboration.list_consultation_records(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collaboration.create_consultation_record(text, date, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collaboration.add_consultation_addition(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_consultation_records(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.create_consultation_record(text, date, bigint, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.add_consultation_addition(text, uuid, text) TO ductus_app;

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
DROP FUNCTION collaboration.add_consultation_addition(text, uuid, text);
DROP FUNCTION collaboration.create_consultation_record(text, date, bigint, text, text);
DROP FUNCTION collaboration.list_consultation_records(text);
DROP TABLE collaboration.consultation_addition;
DROP TABLE collaboration.consultation_record;
DROP FUNCTION collaboration.is_consultation_text(text, integer, integer);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION collaboration.consultation_revision_exists(text, bigint);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;
