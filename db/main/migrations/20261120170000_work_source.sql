-- migrate:up
-- SRV-7B (Ductus#2028, c.7036862354; D-59, D-226): the sources of a student's
-- work, the work's lasting source list (the source notebook). One row per
-- source of one work (assignment and student). The row carries the source
-- record of the document schema (docs/contracts/document-schema-v2.md §2, the
-- one source model of D-226: a document's sources[] and this list hold the
-- same record), and beside it what the record does not carry (v3 contract,
-- docs/contracts/document-schema-v3.md, "izbor ugovora" on DOI and ISBN):
-- the DOI, the ISBN, whether the source has no year (shown as "b. g."; the
-- record still holds a year, as v2 and v3 require) and whether a teacher of
-- the work recommended or required it.
--
-- The list is not evidence: it is outside the document and its hash, and a
-- source may be changed or removed. Only through the RPCs: no role but the
-- owner holds a privilege on the table, and its only policy is the owner's.
--
--   institution.work_source              the sources; forced RLS
--   institution.work_source_record_valid the shape the table and the RPC
--                                        accept (the full v2 check is the
--                                        server's validateSources)
--   institution.work_source_access       'student' for the student of the
--                                        work, 'reader' for a reader of it
--                                        (the readers of app.submission_notes,
--                                        20261120090000), else null
--   institution.save_work_source         the student adds or changes an own
--                                        source
--   institution.delete_work_source       the student removes an own source
--   institution.work_sources             the sources of one work, for its
--                                        student or a reader
--
-- A source the student added has no requirement and was added by the
-- student; one with a requirement (recommended, required) was added by a
-- teacher of the work and only a teacher changes it (a later step). The
-- institution comes from the session, never from a parameter. Errors carry no
-- input: ZD401 no session, ZD403 no relation (one answer for every refusal,
-- also for an assignment or student that does not exist), ZD422 invalid input
-- or a list already at 500 sources (the document's own bound).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Closed shape of the stored record: an object whose id is the row's id, one
-- of the four types, a title, a year and one to fifty authors (v2 §2.1, 2.2),
-- at most 256 KiB. Null for no record, so a CHECK must coalesce.
CREATE FUNCTION institution.work_source_record_valid(p_id uuid, p_record jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_id IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object' THEN false
    ELSE p_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND p_record->>'id' IS NOT DISTINCT FROM p_id::text
     AND coalesce(p_record->>'type' IN ('book', 'article', 'chapter', 'web'), false)
     AND jsonb_typeof(p_record->'title') IS NOT DISTINCT FROM 'string'
     AND char_length(p_record->>'title') BETWEEN 1 AND 1000
     AND jsonb_typeof(p_record->'year') IS NOT DISTINCT FROM 'number'
     AND coalesce(p_record->>'year' ~ '^[1-9][0-9]{3}$', false)
     AND CASE WHEN jsonb_typeof(p_record->'authors') = 'array'
              THEN jsonb_array_length(p_record->'authors') BETWEEN 1 AND 50 ELSE false END
     AND octet_length(p_record::text) <= 262144
  END
$$;

CREATE TABLE institution.work_source (
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  id uuid NOT NULL,
  record jsonb NOT NULL CHECK (institution.work_source_record_valid(id, record)),
  -- One spelling each (B-8): a DOI in lowercase, an ISBN as its digits.
  doi text CHECK (char_length(doi) <= 300 AND doi ~ '^10\.[0-9]{4,9}/[!-~]+$' AND doi = lower(doi)),
  isbn text CHECK (isbn ~ '^([0-9]{9}[0-9X]|97[89][0-9]{10})$'),
  undated boolean NOT NULL DEFAULT false,
  requirement text CHECK (requirement IN ('recommended', 'required')),
  added_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (assignment_id, student_id, id),
  CHECK ((requirement IS NULL) = (added_by = student_id)),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (added_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_source_student_idx ON institution.work_source (student_id);

ALTER TABLE institution.work_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_source FORCE ROW LEVEL SECURITY;
CREATE POLICY work_source_owner ON institution.work_source TO ductus_identity USING (true) WITH CHECK (true);

-- The caller's relation to one student's work, from the session (never an
-- institution parameter). Called only from the definer functions below, as
-- the owner role.
CREATE FUNCTION institution.work_source_access(p_assignment_id uuid, p_student_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_assignment_id IS NULL OR p_student_id IS NULL OR a.user_id IS NULL THEN NULL
    WHEN p_student_id = a.user_id THEN
      CASE WHEN collaboration.actor_role(a.institution_id, p_assignment_id, a.user_id) = 'student' THEN 'student' END
    WHEN audit.reader_role(a.institution_id, p_assignment_id, p_student_id) IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = a.institution_id
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = p_student_id AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship t
                           WHERE t.id = s.mentorship_id AND t.institution_id = s.institution_id
                             AND t.student_id = p_student_id))) THEN 'reader'
  END
  FROM app.current_actor() a
$$;

-- The student of the work adds a source or changes an own one (same id).
-- A teacher's source (one with a requirement) is not the student's: ZD403.
CREATE FUNCTION institution.save_work_source(p_assignment_id uuid, p_record jsonb,
                                             p_doi text DEFAULT NULL, p_isbn text DEFAULT NULL,
                                             p_undated boolean DEFAULT false)
RETURNS TABLE (id uuid, record jsonb, doi text, isbn text, undated boolean, requirement text,
               created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
  v_id uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_record IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object'
     OR NOT coalesce(p_record->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
     OR NOT institution.work_source_record_valid((p_record->>'id')::uuid, p_record)
     OR NOT coalesce(char_length(p_doi) <= 300 AND p_doi ~ '^10\.[0-9]{4,9}/[!-~]+$' AND p_doi = lower(p_doi), p_doi IS NULL)
     OR NOT coalesce(p_isbn ~ '^([0-9]{9}[0-9X]|97[89][0-9]{10})$', p_isbn IS NULL)
     OR p_undated IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_id := (p_record->>'id')::uuid;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- One writer per work at a time, so the bound below holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('work_source:' || p_assignment_id || ':' || v_user, 0));
  IF NOT EXISTS (SELECT 1 FROM institution.work_source w
                  WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = v_id)
     AND (SELECT count(*) FROM institution.work_source w
           WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user) >= 500 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.work_source AS w
      (institution_id, assignment_id, student_id, id, record, doi, isbn, undated, added_by)
    VALUES (v_institution, p_assignment_id, v_user, v_id, p_record, p_doi, p_isbn, p_undated, v_user)
    ON CONFLICT (assignment_id, student_id, id) DO UPDATE
      SET record = excluded.record, doi = excluded.doi, isbn = excluded.isbn, undated = excluded.undated,
          updated_at = statement_timestamp()
      WHERE w.requirement IS NULL
    RETURNING w.id, w.record, w.doi, w.isbn, w.undated, w.requirement, w.created_at, w.updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

-- The student of the work removes an own source: true when it was there,
-- false when it was not. A teacher's source stays: ZD403.
CREATE FUNCTION institution.delete_work_source(p_assignment_id uuid, p_source_id uuid) RETURNS boolean
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

-- The sources of one work, oldest first, then by id. With p_student_id null
-- or the caller: the caller's own. Else a reader of that student's work.
-- One STABLE read; writes nothing (the list is not a surface of the access
-- log, as the notes are not).
CREATE FUNCTION institution.work_sources(p_assignment_id uuid, p_student_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, record jsonb, doi text, isbn text, undated boolean, requirement text,
               created_at timestamptz, updated_at timestamptz)
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
  IF institution.work_source_access(p_assignment_id, v_student) IS DISTINCT FROM v_needed THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT w.id, w.record, w.doi, w.isbn, w.undated, w.requirement, w.created_at, w.updated_at
      FROM institution.work_source w
     WHERE w.institution_id = v_institution AND w.assignment_id = p_assignment_id AND w.student_id = v_student
     ORDER BY w.created_at, w.id;
END
$$;

REVOKE ALL ON FUNCTION institution.work_source_record_valid(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_source_access(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.save_work_source(uuid, jsonb, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.delete_work_source(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_sources(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.save_work_source(uuid, jsonb, text, text, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.delete_work_source(uuid, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.work_sources(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.work_sources(uuid, uuid);
DROP FUNCTION institution.delete_work_source(uuid, uuid);
DROP FUNCTION institution.save_work_source(uuid, jsonb, text, text, boolean);
DROP FUNCTION institution.work_source_access(uuid, uuid);
DROP TABLE institution.work_source;
DROP FUNCTION institution.work_source_record_valid(uuid, jsonb);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
