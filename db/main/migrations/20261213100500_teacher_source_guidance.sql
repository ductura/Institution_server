-- migrate:up
-- SRV-1605 (Ductus#2052; WEB-2133, PITANJE wweb2133v3, paritet-editor prijedlog 11):
-- the guidance of a teacher on sources.
--
--   institution.course_required_source   the required literature of a course
--                                        (s2ObNew / s2ObDel): one row per source
--   institution.source_proof_request     a request for a proof of a source of a
--                                        work, with an instruction and a
--                                        deadline (s2Req / s2ReqDel, proofReq);
--                                        closing keeps the row
--   institution.work_literature_seen     the mark that a teacher reviewed the
--                                        literature of a work (litSeen)
--
-- The recommendation of a source on a work (s2Rec / s2RecDel) is a work_source
-- row with a requirement (20261120190000); here it only gets the writer rule.
-- Reading the proofs of a source by a teacher is institution.source_proofs
-- (20261121130000); the server asks it for the student of the work.
--
-- Who writes: the teacher of the course who is its holder, and the mentor of a
-- mentorship work (INVENTAR 7 point 5). A collaborator of the course, a seminar
-- group teacher and every other reader only read. The student of a work sees
-- the recommendations (the work source list), the proof requests of the own
-- work and the required literature of an own course. Access comes from the
-- relation to the work or the course, never from a role alone (C-23).
--
-- Only through the RPCs: no role but the owner holds a privilege on a table.
-- The institution, the actor and the student come from the session or from the
-- work behind the document id, never from a parameter. Errors carry no input:
-- ZD401 no session, ZD403 no relation or not a writer (one answer, also for an
-- unknown document, course or source), ZD409 the same DOI or ISBN twice in a
-- course, ZD422 invalid input or a list at its bound.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app, institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.course_required_source (
  institution_id uuid NOT NULL,
  course_id uuid NOT NULL,
  id uuid NOT NULL,
  record jsonb NOT NULL CHECK (institution.work_source_record_valid(id, record)),
  doi text CHECK (char_length(doi) <= 300 AND doi ~ '^10\.[0-9]{4,9}/[!-~]+$' AND doi = lower(doi)),
  isbn text CHECK (isbn ~ '^([0-9]{9}[0-9X]|97[89][0-9]{10})$'),
  undated boolean NOT NULL DEFAULT false,
  added_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (course_id, id),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (added_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE UNIQUE INDEX course_required_source_doi_idx ON institution.course_required_source (course_id, doi) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX course_required_source_isbn_idx ON institution.course_required_source (course_id, isbn) WHERE isbn IS NOT NULL;
CREATE INDEX course_required_source_added_by_idx ON institution.course_required_source (added_by, institution_id);
ALTER TABLE institution.course_required_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.course_required_source FORCE ROW LEVEL SECURITY;
CREATE POLICY course_required_source_owner ON institution.course_required_source TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE TABLE institution.source_proof_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  source_id uuid NOT NULL,
  instruction text NOT NULL CHECK (institution.source_proof_text_valid(instruction, 1000, true)),
  due_at timestamptz NOT NULL,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_at timestamptz,
  closed_by uuid,
  CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  FOREIGN KEY (assignment_id, student_id, source_id, institution_id)
    REFERENCES institution.work_source (assignment_id, student_id, id, institution_id),
  FOREIGN KEY (requested_by, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (closed_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
-- At most one open request per source of a work.
CREATE UNIQUE INDEX source_proof_request_open_idx
  ON institution.source_proof_request (assignment_id, student_id, source_id) WHERE closed_at IS NULL;
CREATE INDEX source_proof_request_student_idx ON institution.source_proof_request (student_id);
CREATE INDEX source_proof_request_requested_by_idx ON institution.source_proof_request (requested_by, institution_id);
CREATE INDEX source_proof_request_closed_by_idx ON institution.source_proof_request (closed_by, institution_id);
ALTER TABLE institution.source_proof_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.source_proof_request FORCE ROW LEVEL SECURITY;
CREATE POLICY source_proof_request_owner ON institution.source_proof_request TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE TABLE institution.work_literature_seen (
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  seen_by uuid NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (assignment_id, student_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (seen_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_literature_seen_seen_by_idx ON institution.work_literature_seen (seen_by, institution_id);
CREATE INDEX work_literature_seen_student_idx ON institution.work_literature_seen (student_id);
ALTER TABLE institution.work_literature_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_literature_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY work_literature_seen_owner ON institution.work_literature_seen TO ductus_identity
  USING (true) WITH CHECK (true);

-- The relation of the caller to one student's work: 'writer' (the holder of the
-- course of the work, or the mentor of a mentorship work), 'reader' (every other
-- reader of it) or NULL. Called only from the definer functions below.
CREATE FUNCTION institution.guidance_work_role(p_assignment_id uuid, p_student_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN NULL
    WHEN audit.reader_role(a.institution_id, p_assignment_id, p_student_id) = 'mentor' THEN 'writer'
    WHEN audit.reader_role(a.institution_id, p_assignment_id, p_student_id) = 'teacher'
         AND EXISTS (SELECT 1 FROM institution.assignment s
                       JOIN institution.course_holder h ON h.course_id = s.course_id
                        AND h.institution_id = s.institution_id AND h.user_id = a.user_id AND h.valid_to IS NULL
                      WHERE s.id = p_assignment_id AND s.institution_id = a.institution_id) THEN 'writer'
    ELSE 'reader'
  END
  FROM app.current_actor() a
$$;

-- The relation of the caller to a course: 'writer' (its open holder), 'reader'
-- (another open teacher of it), 'student' (an open student member) or NULL.
CREATE FUNCTION institution.guidance_course_role(p_course_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE institution.actor_course_role(p_course_id)
    WHEN 'student' THEN 'student'
    WHEN 'teacher' THEN
      CASE WHEN EXISTS (SELECT 1 FROM institution.course_holder h
                         WHERE h.course_id = p_course_id AND h.institution_id = a.institution_id
                           AND h.user_id = a.user_id AND h.valid_to IS NULL) THEN 'writer' ELSE 'reader' END
  END
  FROM app.current_actor() a
$$;

-- A UTC instant as the contract writes it (millisecond precision, Z).
CREATE FUNCTION institution.guidance_instant(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE FUNCTION institution.guidance_request_json(r institution.source_proof_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT jsonb_build_object('id', r.id, 'sourceId', r.source_id, 'instruction', r.instruction,
           'dueAt', institution.guidance_instant(r.due_at), 'createdAt', institution.guidance_instant(r.created_at),
           'closedAt', CASE WHEN r.closed_at IS NULL THEN NULL ELSE institution.guidance_instant(r.closed_at) END)
$$;

-- The work behind a document id for a teacher: the document must be another's
-- work the caller reads; the student of the work comes out of it. Every refusal
-- is ZD403 (the student of the work has own routes).
CREATE FUNCTION institution.guidance_work_of(p_document_id text, p_writer boolean)
RETURNS TABLE (assignment_id uuid, student_id uuid, role text)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_access record;
  v_role text;
BEGIN
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  IF v_access.is_owner THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  v_role := institution.guidance_work_role(v_access.assignment_id, v_access.student_id);
  IF v_role IS NULL OR (p_writer AND v_role <> 'writer') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT v_access.assignment_id, v_access.student_id, v_role;
END
$$;

-- A source of a work (or of a course) as the contract writes it.
CREATE FUNCTION institution.guidance_source_json(p_id uuid, p_record jsonb, p_doi text, p_isbn text, p_undated boolean,
                                                 p_requirement text, p_created timestamptz, p_updated timestamptz)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT jsonb_build_object('id', p_id, 'record', p_record, 'doi', p_doi, 'isbn', p_isbn, 'undated', p_undated,
           'createdAt', institution.guidance_instant(p_created), 'updatedAt', institution.guidance_instant(p_updated))
         || CASE WHEN p_requirement IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('requirement', p_requirement) END
$$;

-- The guidance of one work for a reader of it: every source of the work (with
-- the count of its proofs), the proof requests and the mark of the literature.
CREATE FUNCTION app.teacher_source_guidance(p_document_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
BEGIN
  SELECT * INTO v_work FROM institution.guidance_work_of(p_document_id, false);
  RETURN jsonb_build_object(
    'canWrite', v_work.role = 'writer',
    'sources', coalesce((
      SELECT jsonb_agg(institution.guidance_source_json(w.id, w.record, w.doi, w.isbn, w.undated, w.requirement,
                                                        w.created_at, w.updated_at)
                       || jsonb_build_object('proofCount', (SELECT count(*) FROM institution.source_proof p
                            WHERE p.assignment_id = w.assignment_id AND p.student_id = w.student_id AND p.source_id = w.id))
                       ORDER BY w.created_at, w.id)
        FROM institution.work_source w
       WHERE w.assignment_id = v_work.assignment_id AND w.student_id = v_work.student_id), '[]'::jsonb),
    'proofRequests', coalesce((
      SELECT jsonb_agg(institution.guidance_request_json(r) ORDER BY r.created_at, r.id)
        FROM institution.source_proof_request r
       WHERE r.assignment_id = v_work.assignment_id AND r.student_id = v_work.student_id), '[]'::jsonb),
    'literatureSeenAt', (SELECT institution.guidance_instant(s.seen_at) FROM institution.work_literature_seen s
                          WHERE s.assignment_id = v_work.assignment_id AND s.student_id = v_work.student_id));
END
$$;

-- s2Rec: the writer recommends (or requires) a source on the work. The same id
-- again changes it. The checks of the record are those of the work source.
CREATE FUNCTION app.teacher_source_recommend(p_document_id text, p_record jsonb, p_requirement text,
                                             p_doi text DEFAULT NULL, p_isbn text DEFAULT NULL,
                                             p_undated boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
  v_saved jsonb;
BEGIN
  SELECT * INTO v_work FROM institution.guidance_work_of(p_document_id, true);
  SELECT institution.guidance_source_json(s.id, s.record, s.doi, s.isbn, s.undated, s.requirement,
                                           s.created_at, s.updated_at)
    INTO v_saved
    FROM institution.save_teacher_work_source(v_work.assignment_id, v_work.student_id, p_record, p_requirement,
                                              p_doi, p_isbn, p_undated) s;
  RETURN v_saved;
END
$$;

-- s2RecDel: the writer removes a recommended or required source (and its proofs
-- and requests). False when there was none.
CREATE FUNCTION app.teacher_source_unrecommend(p_document_id text, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
BEGIN
  SELECT * INTO v_work FROM institution.guidance_work_of(p_document_id, true);
  RETURN institution.delete_teacher_work_source(v_work.assignment_id, v_work.student_id, p_source_id);
END
$$;

-- s2Req: the writer sets the request for a proof of a source of the work, with
-- an instruction and a deadline in the future. An open request of that source
-- is changed, otherwise a new one is made.
CREATE FUNCTION app.teacher_proof_request_put(p_document_id text, p_source_id uuid, p_instruction text, p_due_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
  v_user uuid;
  v_institution uuid;
  v_row institution.source_proof_request;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF NOT institution.source_proof_text_valid(p_instruction, 1000, true) OR p_due_at IS NULL
     OR p_due_at <= statement_timestamp() OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_work FROM institution.guidance_work_of(p_document_id, true);
  IF NOT EXISTS (SELECT 1 FROM institution.work_source w
                  WHERE w.institution_id = v_institution AND w.assignment_id = v_work.assignment_id
                    AND w.student_id = v_work.student_id AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('source_proof_request:' || v_work.assignment_id || ':' || v_work.student_id, 0));
  UPDATE institution.source_proof_request r
     SET instruction = p_instruction, due_at = p_due_at, requested_by = v_user
   WHERE r.assignment_id = v_work.assignment_id AND r.student_id = v_work.student_id
     AND r.source_id = p_source_id AND r.closed_at IS NULL
  RETURNING r.* INTO v_row;
  IF NOT FOUND THEN
    IF (SELECT count(*) FROM institution.source_proof_request r
         WHERE r.assignment_id = v_work.assignment_id AND r.student_id = v_work.student_id) >= 1000 THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    INSERT INTO institution.source_proof_request AS r
      (institution_id, assignment_id, student_id, source_id, instruction, due_at, requested_by)
    VALUES (v_institution, v_work.assignment_id, v_work.student_id, p_source_id, p_instruction, p_due_at, v_user)
    RETURNING r.* INTO v_row;
  END IF;
  RETURN institution.guidance_request_json(v_row);
END
$$;

-- s2ReqDel: the writer closes the open request of a source. The row stays
-- (closed). False when there was no open request.
CREATE FUNCTION app.teacher_proof_request_close(p_document_id text, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
  v_user uuid;
BEGIN
  SELECT r.user_id INTO v_user FROM institution.require_actor() r;
  SELECT * INTO v_work FROM institution.guidance_work_of(p_document_id, true);
  UPDATE institution.source_proof_request r
     SET closed_at = statement_timestamp(), closed_by = v_user
   WHERE r.assignment_id = v_work.assignment_id AND r.student_id = v_work.student_id
     AND r.source_id = p_source_id AND r.closed_at IS NULL;
  RETURN FOUND;
END
$$;

-- litSeen: the writer marks that the literature of the work was reviewed; the
-- mark is one row per work, so a later mark replaces the earlier one.
CREATE FUNCTION app.teacher_literature_seen_put(p_document_id text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
  v_user uuid;
  v_institution uuid;
  v_at timestamptz;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  SELECT * INTO v_work FROM institution.guidance_work_of(p_document_id, true);
  INSERT INTO institution.work_literature_seen AS s (institution_id, assignment_id, student_id, seen_by, seen_at)
  VALUES (v_institution, v_work.assignment_id, v_work.student_id, v_user, statement_timestamp())
  ON CONFLICT (assignment_id, student_id) DO UPDATE SET seen_by = EXCLUDED.seen_by, seen_at = EXCLUDED.seen_at
  RETURNING s.seen_at INTO v_at;
  RETURN institution.guidance_instant(v_at);
END
$$;

-- The proof requests of the caller's own work, oldest first (open and closed).
CREATE FUNCTION app.student_proof_requests(p_assignment_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN jsonb_build_object('proofRequests', coalesce((
    SELECT jsonb_agg(institution.guidance_request_json(r) ORDER BY r.created_at, r.id)
      FROM institution.source_proof_request r
     WHERE r.institution_id = v_institution AND r.assignment_id = p_assignment_id AND r.student_id = v_user), '[]'::jsonb));
END
$$;

-- The required literature of a course, for its teachers (canWrite for the
-- holder) and for its students.
CREATE FUNCTION app.course_literature_read(p_course_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_institution uuid;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  v_role := institution.guidance_course_role(p_course_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN jsonb_build_object(
    'canWrite', v_role = 'writer',
    'sources', coalesce((
      SELECT jsonb_agg(institution.guidance_source_json(c.id, c.record, c.doi, c.isbn, c.undated, NULL,
                                                        c.created_at, c.updated_at) ORDER BY c.created_at, c.id)
        FROM institution.course_required_source c
       WHERE c.institution_id = v_institution AND c.course_id = p_course_id), '[]'::jsonb));
END
$$;

-- s2ObNew: the holder adds a required source to the course or changes one (the
-- same id). A course holds at most 200; a DOI or an ISBN is held once.
CREATE FUNCTION app.course_literature_put(p_course_id uuid, p_record jsonb, p_doi text DEFAULT NULL,
                                          p_isbn text DEFAULT NULL, p_undated boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_id uuid;
  v_row institution.course_required_source;
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
  IF institution.guidance_course_role(p_course_id) IS DISTINCT FROM 'writer' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('course_required_source:' || p_course_id, 0));
  IF EXISTS (SELECT 1 FROM institution.course_required_source c
              WHERE c.course_id = p_course_id AND c.id <> v_id
                AND ((p_doi IS NOT NULL AND c.doi = p_doi) OR (p_isbn IS NOT NULL AND c.isbn = p_isbn))) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM institution.course_required_source c WHERE c.course_id = p_course_id AND c.id = v_id)
     AND (SELECT count(*) FROM institution.course_required_source c WHERE c.course_id = p_course_id) >= 200 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.course_required_source AS c
    (institution_id, course_id, id, record, doi, isbn, undated, added_by)
  VALUES (v_institution, p_course_id, v_id, p_record, p_doi, p_isbn, p_undated, v_user)
  ON CONFLICT (course_id, id) DO UPDATE
    SET record = EXCLUDED.record, doi = EXCLUDED.doi, isbn = EXCLUDED.isbn, undated = EXCLUDED.undated,
        updated_at = statement_timestamp()
  RETURNING c.* INTO v_row;
  RETURN institution.guidance_source_json(v_row.id, v_row.record, v_row.doi, v_row.isbn, v_row.undated, NULL,
                                          v_row.created_at, v_row.updated_at);
END
$$;

-- s2ObDel: the holder removes a required source of the course. False when there was none.
CREATE FUNCTION app.course_literature_delete(p_course_id uuid, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.guidance_course_role(p_course_id) IS DISTINCT FROM 'writer' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  DELETE FROM institution.course_required_source c WHERE c.course_id = p_course_id AND c.id = p_source_id;
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION institution.guidance_work_role(uuid, uuid), institution.guidance_course_role(uuid),
  institution.guidance_instant(timestamptz), institution.guidance_request_json(institution.source_proof_request),
  institution.guidance_work_of(text, boolean),
  institution.guidance_source_json(uuid, jsonb, text, text, boolean, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_source_guidance(text), app.teacher_source_recommend(text, jsonb, text, text, text, boolean),
  app.teacher_source_unrecommend(text, uuid), app.teacher_proof_request_put(text, uuid, text, timestamptz),
  app.teacher_proof_request_close(text, uuid), app.teacher_literature_seen_put(text),
  app.student_proof_requests(uuid), app.course_literature_read(uuid),
  app.course_literature_put(uuid, jsonb, text, text, boolean), app.course_literature_delete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_source_guidance(text), app.teacher_source_recommend(text, jsonb, text, text, text, boolean),
  app.teacher_source_unrecommend(text, uuid), app.teacher_proof_request_put(text, uuid, text, timestamptz),
  app.teacher_proof_request_close(text, uuid), app.teacher_literature_seen_put(text),
  app.student_proof_requests(uuid), app.course_literature_read(uuid),
  app.course_literature_put(uuid, jsonb, text, text, boolean), app.course_literature_delete(uuid, uuid) TO ductus_app;

-- Removing a source removes its proof requests too (20261128100000 did the same
-- for notes and proofs): no foreign key cascades.
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
  -- The requests, notes and proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_proof_request s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  DELETE FROM institution.source_note s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
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

CREATE OR REPLACE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The requests, notes and proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_proof_request s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  DELETE FROM institution.source_note s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
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
REVOKE CREATE ON SCHEMA app, institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
-- The delete RPCs as 20261128100000 wrote them.
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
  DELETE FROM institution.source_note s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
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

CREATE OR REPLACE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  DELETE FROM institution.source_note s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
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
DROP FUNCTION app.course_literature_delete(uuid, uuid);
DROP FUNCTION app.course_literature_put(uuid, jsonb, text, text, boolean);
DROP FUNCTION app.course_literature_read(uuid);
DROP FUNCTION app.student_proof_requests(uuid);
DROP FUNCTION app.teacher_literature_seen_put(text);
DROP FUNCTION app.teacher_proof_request_close(text, uuid);
DROP FUNCTION app.teacher_proof_request_put(text, uuid, text, timestamptz);
DROP FUNCTION app.teacher_source_unrecommend(text, uuid);
DROP FUNCTION app.teacher_source_recommend(text, jsonb, text, text, text, boolean);
DROP FUNCTION app.teacher_source_guidance(text);
DROP FUNCTION institution.guidance_source_json(uuid, jsonb, text, text, boolean, text, timestamptz, timestamptz);
DROP FUNCTION institution.guidance_work_of(text, boolean);
DROP FUNCTION institution.guidance_request_json(institution.source_proof_request);
DROP FUNCTION institution.guidance_instant(timestamptz);
DROP FUNCTION institution.guidance_course_role(uuid);
DROP FUNCTION institution.guidance_work_role(uuid, uuid);
DROP TABLE institution.work_literature_seen;
DROP TABLE institution.source_proof_request;
DROP TABLE institution.course_required_source;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, institution FROM ductus_identity;
