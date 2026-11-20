-- migrate:up
-- SRV-1108 (wave 11, N-13, C-15, PO-22): a teacher extends the deadline of an
-- assignment for one student or for all of them, with one of the four reasons
-- of N-13 as a closed list. A record of an extension is never changed or
-- removed (N-13: "Zapis o produljenju ... se ne briše"); a later extension is
-- a new row. An extension never touches a submission already recorded: the
-- deadline a submission was judged against stays in its own row and receipt
-- (N-13 "sukob": the extension is noted next to it).
--
-- Only through the RPCs: no role but the owner holds a privilege on the
-- table, and its only policy is the owner's. Who may extend comes from the
-- caller's relation to the work (institution.work_relation: the teacher of
-- the course or the mentor of the mentorship), never from a role alone (C-23);
-- a teacher of another course or institution is refused. The reason is
-- private (N-13 "Razlog vidite samo Vi i taj student"): a list shows it only
-- to the teacher who wrote it.
--
--   institution.deadline_extension          the extensions; forced RLS,
--                                           append-only by trigger
--   institution.effective_due_at            the deadline that holds for one
--                                           student now; not the web role's
--   institution.extend_assignment_deadline  the teacher records an extension
--   institution.deadline_extensions         the extensions of an assignment,
--                                           for its teacher
--
-- The institution and the author come from the session, never from a
-- parameter. Errors carry no input: ZD401 no session, ZD403 no relation (one
-- answer for every refusal, also for an assignment or student that does not
-- exist), ZD422 invalid input or a deadline that is not later than the one
-- it extends.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.deadline_extension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the records; the latest that applies to a student holds.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  -- Null: every student of the assignment.
  student_id uuid,
  previous_due_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  -- N-13 EXT_REASONS: Opravdan razlog, Tehnička poteškoća, Dogovor s
  -- nastavnikom, Produljenje za sve (only for all students).
  reason_id text NOT NULL CHECK (reason_id IN ('justified', 'technical', 'agreement', 'all')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (due_at > previous_due_at),
  CHECK (reason_id <> 'all' OR student_id IS NULL),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX deadline_extension_assignment_idx ON institution.deadline_extension (assignment_id, student_id, seq);
CREATE INDEX deadline_extension_student_idx ON institution.deadline_extension (student_id);
CREATE INDEX deadline_extension_author_idx ON institution.deadline_extension (created_by);

ALTER TABLE institution.deadline_extension ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.deadline_extension FORCE ROW LEVEL SECURITY;
CREATE POLICY deadline_extension_owner ON institution.deadline_extension TO ductus_identity USING (true) WITH CHECK (true);

CREATE FUNCTION institution.refuse_deadline_extension_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'deadline extension is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER deadline_extension_immutable BEFORE UPDATE OR DELETE ON institution.deadline_extension
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_deadline_extension_change();
CREATE TRIGGER deadline_extension_no_truncate BEFORE TRUNCATE ON institution.deadline_extension
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_deadline_extension_change();

-- The deadline that holds for p_student_id now: the latest extension for that
-- student or for all students, else the due date of the current version. With
-- p_student_id null, the latest extension for all students. No access check:
-- only the definer functions below (and later readers that check first) call it.
CREATE FUNCTION institution.effective_due_at(p_assignment_id uuid, p_student_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT e.due_at FROM institution.deadline_extension e
      WHERE e.assignment_id = p_assignment_id
        AND (e.student_id IS NULL OR e.student_id = p_student_id)
      ORDER BY e.seq DESC LIMIT 1),
    (SELECT v.due_at FROM institution.assignment a
       JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
      WHERE a.id = p_assignment_id))
$$;

-- The teacher of the work records an extension for one student of the
-- assignment (p_student_id) or for all of them (null). The assignment row is
-- locked, so an extension and a submission request (which holds it FOR SHARE)
-- do not interleave; earlier_submissions tells whether a submission in the
-- extension's scope was already recorded, which the extension leaves as it is.
CREATE FUNCTION institution.extend_assignment_deadline(p_assignment_id uuid, p_student_id uuid,
                                                       p_due_at timestamptz, p_reason_id text)
RETURNS TABLE (id uuid, student_id uuid, previous_due_at timestamptz, due_at timestamptz, reason_id text,
               created_by uuid, created_at timestamptz, earlier_submissions boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
  v_previous timestamptz;
  v_earlier boolean;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_due_at IS NULL OR NOT coalesce(p_reason_id IN ('justified', 'technical', 'agreement', 'all'), false)
     OR (p_reason_id = 'all' AND p_student_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher'
     OR (p_student_id IS NOT NULL
         AND institution.work_relation(p_student_id, p_assignment_id) IS DISTINCT FROM 'student') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.assignment a WHERE a.id = p_assignment_id AND a.institution_id = v_institution
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  v_previous := institution.effective_due_at(p_assignment_id, p_student_id);
  IF v_previous IS NULL OR p_due_at <= v_previous THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM (SELECT m.user_id FROM institution.course_member m
              JOIN institution.assignment a ON a.course_id = m.course_id AND a.institution_id = m.institution_id
             WHERE a.id = p_assignment_id AND m.role = 'student'
            UNION
            SELECT t.student_id FROM institution.mentorship t
              JOIN institution.assignment a ON a.mentorship_id = t.id AND a.institution_id = t.institution_id
             WHERE a.id = p_assignment_id) s (user_id)
     WHERE (p_student_id IS NULL OR s.user_id = p_student_id)
       AND (SELECT x.state FROM app.submission_state_of(p_assignment_id, s.user_id) x) IS DISTINCT FROM 'none'
  ) INTO v_earlier;
  RETURN QUERY
    INSERT INTO institution.deadline_extension AS e
      (institution_id, assignment_id, student_id, previous_due_at, due_at, reason_id, created_by)
    VALUES (v_institution, p_assignment_id, p_student_id, v_previous, p_due_at, p_reason_id, v_user)
    RETURNING e.id, e.student_id, e.previous_due_at, e.due_at, e.reason_id, e.created_by, e.created_at,
              coalesce(v_earlier, false);
END
$$;

-- The extensions of an assignment, oldest first, for its teacher. The reason
-- only on the rows the caller wrote; null on another teacher's. One STABLE
-- read; writes nothing.
CREATE FUNCTION institution.deadline_extensions(p_assignment_id uuid)
RETURNS TABLE (id uuid, student_id uuid, previous_due_at timestamptz, due_at timestamptz, reason_id text,
               created_by uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT e.id, e.student_id, e.previous_due_at, e.due_at,
           CASE WHEN e.created_by = v_user THEN e.reason_id END, e.created_by, e.created_at
      FROM institution.deadline_extension e
     WHERE e.institution_id = v_institution AND e.assignment_id = p_assignment_id
     ORDER BY e.seq;
END
$$;

REVOKE ALL ON FUNCTION institution.refuse_deadline_extension_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.effective_due_at(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.extend_assignment_deadline(uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.deadline_extensions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.extend_assignment_deadline(uuid, uuid, timestamptz, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.deadline_extensions(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.deadline_extensions(uuid);
DROP FUNCTION institution.extend_assignment_deadline(uuid, uuid, timestamptz, text);
DROP FUNCTION institution.effective_due_at(uuid, uuid);
DROP TABLE institution.deadline_extension;
DROP FUNCTION institution.refuse_deadline_extension_change();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
