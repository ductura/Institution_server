-- migrate:up
-- SRV-NF4-IZNIMKA-ZAPIS (Ductus#2055; plan NF-4, NZ-5 B; owner answer 4 "oboje"):
-- the special exception of a late submission for ONE student, with a record of
-- its own. It is not an extension of the deadline (SRV-1108) and it changes no
-- deadline: it is the teacher's statement that this student may still submit
-- until a given time although the deadline has passed. Honouring it when a
-- submission is requested is SRV-NF4-IZNIMKA-PREDAJA; this migration only
-- records it and shows it.
--
--   institution.late_submission_exception  the exceptions; forced RLS,
--                                          append-only by trigger. A record is
--                                          never changed or removed; a later
--                                          exception is a new row and the latest
--                                          for a student holds. The reason is
--                                          one of the closed list of N-13
--                                          (justified, technical, agreement);
--                                          there is no free text.
--   audit.late_submission_exception_event  the audit trail, written in the same
--                                          command as the record; append-only.
--   institution.grant_late_submission_exception  the teacher records one
--   institution.late_submission_exceptions       the exceptions of an assignment,
--                                          for its teacher
--   institution.student_late_submission_exceptions  the caller's own exceptions
--
-- Only through the RPCs: no role but the owner holds a privilege on a table. Who
-- may grant or read comes from the caller's relation to the work
-- (institution.work_relation: the teacher of the course or the mentor of the
-- mentorship, or the student of it), never from a role alone (C-23). Another
-- teacher, another institution, a person who is not a student of the assignment
-- and an assignment that does not exist are all the same refusal (ZD403). The
-- reason is private as with extensions: a teacher's list shows it only on the
-- records that teacher wrote; the student reads the reason of the own records.
-- The institution and the author come from the session, never a parameter.
--
-- The time until which the student may submit must be later than now, than the
-- deadline that holds for the student (institution.effective_due_at) and than
-- the latest exception of that student: an exception only lengthens, as an
-- extension does (ZD422). Errors carry no input: ZD401 no session, ZD403 no
-- relation, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.late_submission_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the records; the latest for a student holds.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  until_at timestamptz NOT NULL,
  reason_id text NOT NULL CHECK (reason_id IN ('justified', 'technical', 'agreement')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (until_at > created_at),
  UNIQUE (id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX late_submission_exception_assignment_idx
  ON institution.late_submission_exception (assignment_id, student_id, seq);
CREATE INDEX late_submission_exception_student_idx ON institution.late_submission_exception (student_id);
CREATE INDEX late_submission_exception_author_idx ON institution.late_submission_exception (created_by);

ALTER TABLE institution.late_submission_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.late_submission_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY late_submission_exception_owner ON institution.late_submission_exception TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE FUNCTION institution.reject_late_submission_exception_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'late submission exception is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER late_submission_exception_immutable BEFORE UPDATE OR DELETE ON institution.late_submission_exception
  FOR EACH ROW EXECUTE FUNCTION institution.reject_late_submission_exception_change();
CREATE TRIGGER late_submission_exception_no_truncate BEFORE TRUNCATE ON institution.late_submission_exception
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_late_submission_exception_change();

CREATE TABLE audit.late_submission_exception_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('granted')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (exception_id, institution_id) REFERENCES institution.late_submission_exception (id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX late_submission_exception_event_assignment_idx
  ON audit.late_submission_exception_event (assignment_id, institution_id, occurred_at);
CREATE INDEX late_submission_exception_event_student_idx
  ON audit.late_submission_exception_event (student_id, institution_id);
CREATE INDEX late_submission_exception_event_actor_idx
  ON audit.late_submission_exception_event (actor_id, institution_id);
CREATE INDEX late_submission_exception_event_exception_idx
  ON audit.late_submission_exception_event (exception_id, institution_id);
CREATE TRIGGER late_submission_exception_event_append_only BEFORE UPDATE OR DELETE ON audit.late_submission_exception_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER late_submission_exception_event_no_truncate BEFORE TRUNCATE ON audit.late_submission_exception_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.late_submission_exception_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.late_submission_exception_event FORCE ROW LEVEL SECURITY;
CREATE POLICY late_submission_exception_event_owner ON audit.late_submission_exception_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The teacher of the work records an exception for one student of the
-- assignment. The assignment row is locked, so an exception and a submission
-- request (which holds it FOR SHARE) do not interleave. The record and its
-- audit row are written by this one statement sequence, in one transaction.
CREATE FUNCTION institution.grant_late_submission_exception(p_assignment_id uuid, p_student_id uuid,
                                                            p_until_at timestamptz, p_reason_id text)
RETURNS TABLE (id uuid, student_id uuid, until_at timestamptz, reason_id text, created_by uuid,
               created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
  v_floor timestamptz;
  v_latest timestamptz;
  v_id uuid;
  v_created timestamptz;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL OR p_until_at IS NULL
     OR NOT coalesce(p_reason_id IN ('justified', 'technical', 'agreement'), false)
     OR NOT isfinite(p_until_at) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher'
     OR institution.work_relation(p_student_id, p_assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.assignment a WHERE a.id = p_assignment_id AND a.institution_id = v_institution
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  v_floor := greatest(statement_timestamp(), institution.effective_due_at(p_assignment_id, p_student_id));
  SELECT max(e.until_at) INTO v_latest FROM institution.late_submission_exception e
   WHERE e.assignment_id = p_assignment_id AND e.student_id = p_student_id AND e.institution_id = v_institution;
  IF p_until_at <= greatest(v_floor, v_latest) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.late_submission_exception AS e
    (institution_id, assignment_id, student_id, until_at, reason_id, created_by)
  VALUES (v_institution, p_assignment_id, p_student_id, p_until_at, p_reason_id, v_user)
  RETURNING e.id, e.created_at INTO v_id, v_created;
  INSERT INTO audit.late_submission_exception_event
    (institution_id, assignment_id, student_id, exception_id, action, actor_id, occurred_at)
  VALUES (v_institution, p_assignment_id, p_student_id, v_id, 'granted', v_user, v_created);
  RETURN QUERY SELECT v_id, p_student_id, p_until_at, p_reason_id, v_user, v_created;
END
$$;

-- The exceptions of an assignment, oldest first, for its teacher. The reason
-- only on the rows the caller wrote; null on another teacher's. One STABLE
-- read; writes nothing.
CREATE FUNCTION institution.late_submission_exceptions(p_assignment_id uuid)
RETURNS TABLE (id uuid, student_id uuid, until_at timestamptz, reason_id text, created_by uuid,
               created_at timestamptz)
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
    SELECT e.id, e.student_id, e.until_at, CASE WHEN e.created_by = v_user THEN e.reason_id END,
           e.created_by, e.created_at
      FROM institution.late_submission_exception e
     WHERE e.institution_id = v_institution AND e.assignment_id = p_assignment_id
     ORDER BY e.seq;
END
$$;

-- The caller's own exceptions on an assignment, oldest first, for the student.
-- Only an active student of the assignment reads; the student comes from the
-- session. Another student's records are never in the answer.
CREATE FUNCTION institution.student_late_submission_exceptions(p_assignment_id uuid)
RETURNS TABLE (id uuid, until_at timestamptz, reason_id text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'student'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = v_institution) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT e.id, e.until_at, e.reason_id, e.created_at
      FROM institution.late_submission_exception e
     WHERE e.institution_id = v_institution AND e.assignment_id = p_assignment_id AND e.student_id = v_user
     ORDER BY e.seq;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_late_submission_exception_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.grant_late_submission_exception(uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.late_submission_exceptions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.student_late_submission_exceptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.grant_late_submission_exception(uuid, uuid, timestamptz, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.late_submission_exceptions(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.student_late_submission_exceptions(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, audit FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.student_late_submission_exceptions(uuid);
DROP FUNCTION institution.late_submission_exceptions(uuid);
DROP FUNCTION institution.grant_late_submission_exception(uuid, uuid, timestamptz, text);
DROP TABLE audit.late_submission_exception_event;
DROP TABLE institution.late_submission_exception;
DROP FUNCTION institution.reject_late_submission_exception_change();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, audit FROM ductus_identity;
