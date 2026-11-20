-- migrate:up
-- SRV-1102 (Ductus#2051, wave 11, editor E§3.4 "proofs", B-8): the proofs of
-- a source, the excerpts a student attaches to a source of the own work (a
-- photo, a pasted image or a crop from a PDF that never leaves the browser).
-- One row per proof: the source of the work it belongs to
-- (institution.work_source, 20261120180000), the page of the source it shows,
-- an optional note and the JPEG bytes of the excerpt itself. Only an excerpt
-- is kept: the bytes must be a JPEG, so a whole PDF is refused here as well as
-- in the server.
--
-- A proof is "attached by the student"; Ductura does not claim that the
-- source says what the student writes, and nothing here compares the two.
-- The proof is not evidence: it is outside the document and its hash. When
-- a source is removed (delete_work_source, delete_teacher_work_source), its
-- proofs are removed first in the same RPC; no foreign key cascades
-- (033-institution-key.sql), and each pairs institution_id with institution_id.
--
-- Only through the RPCs: no role but the owner holds a privilege on the
-- table, and its only policy is the owner's. Access comes from the caller's
-- relation to the work (institution.work_source_access: the student of the
-- work, or a reader of it), never from a role alone (C-23).
--
--   institution.source_proof              the proofs; forced RLS
--   institution.source_proof_text_valid   a page or note as the table and
--                                         the RPC accept it
--   institution.add_source_proof          the student attaches a proof to a
--                                         source of the own work
--   institution.source_proofs             the proofs of one source, for the
--                                         student of the work or a reader
--   institution.read_source_proof_image   the bytes of one proof, for the
--                                         student of the work or a reader
--
-- The institution and the student come from the session, never from a
-- parameter. Errors carry no input: ZD401 no session, ZD403 no relation (one
-- answer for every refusal, also for an assignment, source or proof that does
-- not exist), ZD422 invalid input or a work already at its bound (200 proofs
-- or 100 MiB together).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The parent key of a proof: the source of the work, with its institution, so
-- the foreign key below pairs institution_id (033-institution-key.sql A5).
ALTER TABLE institution.work_source
  ADD CONSTRAINT work_source_institution_key UNIQUE (assignment_id, student_id, id, institution_id);

-- A page ("14", "xii", "14-15") or a note: 1 to p_max characters, no control
-- character (a note may hold line breaks), no white space at either end.
CREATE FUNCTION institution.source_proof_text_valid(p_text text, p_max integer, p_lines boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(
    char_length(p_text) BETWEEN 1 AND p_max
    AND CASE WHEN p_lines THEN replace(p_text, E'\n', '') ELSE p_text END !~ '[[:cntrl:]]'
    AND p_text !~ '^[[:space:]]' AND p_text !~ '[[:space:]]$',
    false)
$$;

CREATE TABLE institution.source_proof (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  source_id uuid NOT NULL,
  page text NOT NULL CHECK (institution.source_proof_text_valid(page, 30, false)),
  note text CHECK (note IS NULL OR institution.source_proof_text_valid(note, 2000, true)),
  -- The excerpt, a JPEG of at most 1 MiB (the prototype saves at most about
  -- 210 KB); the stored hash is the hash of exactly these bytes.
  image bytea NOT NULL CHECK (octet_length(image) BETWEEN 4 AND 1048576
                              AND substr(image, 1, 3) = '\xffd8ff'::bytea),
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (byte_size = octet_length(image)),
  CHECK (sha256 = encode(pg_catalog.sha256(image), 'hex')),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  FOREIGN KEY (assignment_id, student_id, source_id, institution_id)
    REFERENCES institution.work_source (assignment_id, student_id, id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX source_proof_source_idx ON institution.source_proof (assignment_id, student_id, source_id);
CREATE INDEX source_proof_student_idx ON institution.source_proof (student_id);

ALTER TABLE institution.source_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.source_proof FORCE ROW LEVEL SECURITY;
CREATE POLICY source_proof_owner ON institution.source_proof TO ductus_identity USING (true) WITH CHECK (true);

-- The student of the work attaches a proof to a source of the own work (one
-- the student added or one a teacher recommended or required).
CREATE FUNCTION institution.add_source_proof(p_assignment_id uuid, p_source_id uuid, p_page text,
                                             p_note text, p_image bytea)
RETURNS TABLE (id uuid, page text, note text, byte_size integer, sha256 text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF NOT institution.source_proof_text_valid(p_page, 30, false)
     OR (p_note IS NOT NULL AND NOT institution.source_proof_text_valid(p_note, 2000, true))
     OR NOT coalesce(octet_length(p_image) BETWEEN 4 AND 1048576, false)
     OR substr(p_image, 1, 3) <> '\xffd8ff'::bytea THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student'
     OR NOT EXISTS (SELECT 1 FROM institution.work_source w
                     WHERE w.institution_id = v_institution AND w.assignment_id = p_assignment_id
                       AND w.student_id = v_user AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- One writer per work at a time, so the bounds below hold.
  PERFORM pg_advisory_xact_lock(hashtextextended('source_proof:' || p_assignment_id || ':' || v_user, 0));
  IF (SELECT count(*) >= 200 OR coalesce(sum(s.byte_size), 0) + octet_length(p_image) > 104857600
        FROM institution.source_proof s
       WHERE s.assignment_id = p_assignment_id AND s.student_id = v_user) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.source_proof AS s
      (institution_id, assignment_id, student_id, source_id, page, note, image, byte_size, sha256)
    VALUES (v_institution, p_assignment_id, v_user, p_source_id, p_page, p_note, p_image,
            octet_length(p_image), encode(pg_catalog.sha256(p_image), 'hex'))
    RETURNING s.id, s.page, s.note, s.byte_size, s.sha256, s.created_at;
END
$$;

-- The proofs of one source of one work, oldest first, then by id. With
-- p_student_id null or the caller: the caller's own work. Else a reader of
-- that student's work. A source that is not in the work is ZD403. One STABLE
-- read; writes nothing and returns no bytes.
CREATE FUNCTION institution.source_proofs(p_assignment_id uuid, p_source_id uuid, p_student_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, page text, note text, byte_size integer, sha256 text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_student uuid;
  v_needed text;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  v_student := coalesce(p_student_id, v_user);
  v_needed := CASE WHEN v_student = v_user THEN 'student' ELSE 'reader' END;
  IF institution.work_source_access(p_assignment_id, v_student) IS DISTINCT FROM v_needed
     OR NOT EXISTS (SELECT 1 FROM institution.work_source w
                     WHERE w.institution_id = v_institution AND w.assignment_id = p_assignment_id
                       AND w.student_id = v_student AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT s.id, s.page, s.note, s.byte_size, s.sha256, s.created_at
      FROM institution.source_proof s
     WHERE s.institution_id = v_institution AND s.assignment_id = p_assignment_id
       AND s.student_id = v_student AND s.source_id = p_source_id
     ORDER BY s.created_at, s.id;
END
$$;

-- The bytes of one proof, named by its work, source and id together, so a
-- proof id alone opens nothing. Same access as source_proofs; a proof of
-- another work, source or institution, or none, is ZD403.
CREATE FUNCTION institution.read_source_proof_image(p_assignment_id uuid, p_source_id uuid, p_proof_id uuid,
                                                    p_student_id uuid DEFAULT NULL)
RETURNS TABLE (image bytea, sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
  v_student uuid;
  v_needed text;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  v_student := coalesce(p_student_id, v_user);
  v_needed := CASE WHEN v_student = v_user THEN 'student' ELSE 'reader' END;
  IF institution.work_source_access(p_assignment_id, v_student) IS DISTINCT FROM v_needed THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT s.image, s.sha256
      FROM institution.source_proof s
     WHERE s.institution_id = v_institution AND s.assignment_id = p_assignment_id
       AND s.student_id = v_student AND s.source_id = p_source_id AND s.id = p_proof_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION institution.source_proof_text_valid(text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.add_source_proof(uuid, uuid, text, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.source_proofs(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.read_source_proof_image(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.add_source_proof(uuid, uuid, text, text, bytea) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.source_proofs(uuid, uuid, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.read_source_proof_image(uuid, uuid, uuid, uuid) TO ductus_app;

-- The student of the work removes an own source (20261120180000), now with
-- its proofs first: no foreign key cascades. Same answers as before.
CREATE OR REPLACE FUNCTION institution.delete_work_source(p_assignment_id uuid, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_proof s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

-- A teacher of the work removes a recommended or required source
-- (20261120190000), now with its proofs first.
CREATE OR REPLACE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_proof s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
-- The delete RPCs as 20261120180000 and 20261120190000 wrote them.
CREATE OR REPLACE FUNCTION institution.delete_work_source(p_assignment_id uuid, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;
DROP FUNCTION institution.read_source_proof_image(uuid, uuid, uuid, uuid);
DROP FUNCTION institution.source_proofs(uuid, uuid, uuid);
DROP FUNCTION institution.add_source_proof(uuid, uuid, text, text, bytea);
DROP TABLE institution.source_proof;
ALTER TABLE institution.work_source DROP CONSTRAINT work_source_institution_key;
DROP FUNCTION institution.source_proof_text_valid(text, integer, boolean);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
