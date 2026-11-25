-- migrate:up
-- SRV-NF4-IZNIMKA-PREDAJA (Ductus#2055; plan NF-4, NZ-5 B). Honours the
-- late-submission exception of one student (SRV-NF4-IZNIMKA-ZAPIS,
-- 20261219290000) when a submission is requested: on an assignment whose
-- teacher does not allow late submission (SRV-NF4-KASNA-PROVEDBA,
-- 20261219230000), a click after the deadline that holds for the student is
-- still accepted while the student's latest exception lasts (exactly at its
-- time is in time, as P6). Nothing else changes: the request still pins the
-- deadline that holds (institution.effective_due_at), so the submission and
-- its receipt still carry afterDeadline = true. The exception is not an
-- extension. An exception of another student, an expired one, and one on
-- another assignment or institution never count.
--
--   app.student_late_exception_until  the time of the caller's latest
--                   exception on an assignment where the caller is a student
--                   (institution.work_relation, C-23); null otherwise. The
--                   bridge for the evidence role, which does not read schema
--                   institution (as app.student_late_submission_allowed), and
--                   for the web role, which shows the student the own
--                   exception in student.assignment-work.get.
--   app.request_submission  as 20261219230000; inside its late refusal, the
--                   one exception above, read under the assignment lock
--                   (institution.grant_late_submission_exception takes the
--                   assignment FOR UPDATE, the request holds it FOR SHARE).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;

SET LOCAL ROLE ductus_identity;
-- The latest record holds (20261219290000); an exception only lengthens, so it
-- is also the latest time. Only the caller's own records, only as a student.
CREATE FUNCTION app.student_late_exception_until(p_assignment_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.until_at
    FROM institution.late_submission_exception e
    JOIN app.current_actor() c ON e.institution_id = c.institution_id AND e.student_id = c.user_id
   WHERE e.assignment_id = p_assignment_id
     AND institution.work_relation(c.user_id, p_assignment_id) = 'student'
   ORDER BY e.seq DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.student_late_exception_until(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_late_exception_until(uuid) TO ductus_evidence, ductus_app;

SET LOCAL ROLE ductus_evidence;
-- As 20261219230000; the only change is the exception inside the late refusal.
CREATE OR REPLACE FUNCTION app.request_submission(p_document_id text, p_revision bigint)
RETURNS TABLE(outcome text, submission_request_id uuid, requested_at timestamptz, revision bigint,
              assignment_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- The click, read before any lock wait (4.6: before reconstruction).
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor record;
  v_document evidence.document%ROWTYPE;
  v_project evidence.project%ROWTYPE;
  v_assignment record;
  v_named evidence.document_revision%ROWTYPE;
  v_existing evidence.submission_request%ROWTYPE;
  v_attempt integer;
  v_due timestamptz;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id)
     OR p_revision IS NULL OR p_revision < 0 OR p_revision > 9007199254740991 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  SELECT pr.* INTO v_project
    FROM evidence.document d
    JOIN evidence.project pr ON pr.id = d.project_id AND pr.institution_id = d.institution_id
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id AND pr.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  -- Lock order as in commit_evidence_segment: assignment and membership
  -- (FOR SHARE), then the document (FOR UPDATE).
  SELECT * INTO v_assignment FROM app.lock_student_assignment(v_project.assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  SELECT d.* INTO v_document
    FROM evidence.document d
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  -- The latest attempt binds while it is live (P5, P8); after its submission
  -- was withdrawn (SRV-1903) the click is the next attempt.
  SELECT s.* INTO v_existing
    FROM evidence.submission_request s
   WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id
   ORDER BY s.attempt DESC
   LIMIT 1;
  IF FOUND AND evidence.request_live(v_existing.id, v_existing.institution_id) THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  -- A withdrawal whose receipt is not bound yet keeps the next attempt closed:
  -- withdraw_submission reaches only the latest attempt, so its retry must
  -- still find that withdrawal and sign it. The web process answers 503.
  IF FOUND AND EXISTS (
       SELECT 1 FROM evidence.submission x
         JOIN evidence.submission_withdrawal w ON w.submission_id = x.id
        WHERE x.submission_request_id = v_existing.id AND x.institution_id = v_existing.institution_id
          AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal_receipt b WHERE b.withdrawal_id = w.id)) THEN
    RETURN QUERY SELECT 'withdrawal_unsigned'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  v_attempt := coalesce(v_existing.attempt, 0) + 1;
  IF NOT v_assignment.acknowledged THEN
    RETURN QUERY SELECT 'not_acknowledged'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF v_assignment.opens_at > v_now THEN
    RETURN QUERY SELECT 'not_open'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF p_revision = 0 OR v_document.current_revision = 0 THEN
    RETURN QUERY SELECT
      CASE WHEN p_revision = v_document.current_revision THEN 'no_evidence' ELSE 'stale_revision' END,
      NULL::uuid, NULL::timestamptz,
      CASE WHEN p_revision = v_document.current_revision THEN NULL::bigint ELSE v_document.current_revision END,
      NULL::integer;
    RETURN;
  END IF;
  -- The named revision must have been the current one at the click: it was
  -- accepted no later than v_now, and it is the current one now or its
  -- successor was accepted after v_now (a commit that held the document while
  -- this request waited for it).
  SELECT r.* INTO v_named
    FROM evidence.document_revision r
   WHERE r.document_id = v_document.id AND r.institution_id = v_document.institution_id
     AND r.revision = p_revision;
  IF NOT FOUND OR v_named.created_at > v_now OR (p_revision <> v_document.current_revision AND NOT EXISTS (
       SELECT 1 FROM evidence.document_revision n
        WHERE n.document_id = v_document.id AND n.institution_id = v_document.institution_id
          AND n.revision = p_revision + 1 AND n.created_at > v_now)) THEN
    RETURN QUERY SELECT 'stale_revision'::text, NULL::uuid, NULL::timestamptz, v_document.current_revision,
      NULL::integer;
    RETURN;
  END IF;

  -- SRV-1108C: the deadline that holds for the caller now, with the
  -- assignment held FOR SHARE, so no extension is recorded in between.
  v_due := app.student_effective_due_at(v_project.assignment_id);
  IF v_due IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  -- SRV-NF4-KASNA-PROVEDBA: a click after that deadline (P6: exactly at it is
  -- in time) on an assignment whose teacher does not allow late submission is
  -- refused before anything is written. The assignment is still held FOR
  -- SHARE and institution.set_late_submission_allowed takes it FOR UPDATE, so
  -- the value read here is the one in force at the click. The wire answer is
  -- the existing 409 not_open (orchestrator decision A, no contract change).
  -- SRV-NF4-IZNIMKA-PREDAJA: the student's own latest exception, while it
  -- lasts (exactly at its time is in time), lets the click through. The
  -- request still pins v_due, so the submission is after the deadline.
  IF v_now > v_due AND app.student_late_submission_allowed(v_project.assignment_id) IS NOT TRUE THEN
    IF v_now > coalesce(app.student_late_exception_until(v_project.assignment_id), '-infinity'::timestamptz) THEN
      RETURN QUERY SELECT 'not_open'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
      RETURN;
    END IF;
  END IF;

  -- A second document of the same student and assignment can race past the
  -- lookup above; the unique key decides and the loser returns the winner.
  INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at, due_at, attempt
  ) VALUES (
    v_actor.institution_id, v_project.assignment_id, v_assignment.current_version, v_project.id,
    v_document.id, v_actor.user_id, v_named.revision, v_named.content_hash, v_now, v_due, v_attempt
  )
  ON CONFLICT (assignment_id, institution_id, principal_id, attempt) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission_request s
     WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
       AND s.principal_id = v_actor.user_id AND s.attempt = v_attempt;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'requested'::text, v_id, v_now, v_named.revision, v_assignment.current_version;
END
$$;

-- CREATE OR REPLACE keeps the grants of 20261201100100; restated so the
-- function is never executable by PUBLIC.
REVOKE ALL ON FUNCTION app.request_submission(text, bigint) FROM PUBLIC;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE ductus_evidence;
-- As 20261219230000.
CREATE OR REPLACE FUNCTION app.request_submission(p_document_id text, p_revision bigint)
RETURNS TABLE(outcome text, submission_request_id uuid, requested_at timestamptz, revision bigint,
              assignment_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- The click, read before any lock wait (4.6: before reconstruction).
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor record;
  v_document evidence.document%ROWTYPE;
  v_project evidence.project%ROWTYPE;
  v_assignment record;
  v_named evidence.document_revision%ROWTYPE;
  v_existing evidence.submission_request%ROWTYPE;
  v_attempt integer;
  v_due timestamptz;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id)
     OR p_revision IS NULL OR p_revision < 0 OR p_revision > 9007199254740991 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  SELECT pr.* INTO v_project
    FROM evidence.document d
    JOIN evidence.project pr ON pr.id = d.project_id AND pr.institution_id = d.institution_id
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id AND pr.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  -- Lock order as in commit_evidence_segment: assignment and membership
  -- (FOR SHARE), then the document (FOR UPDATE).
  SELECT * INTO v_assignment FROM app.lock_student_assignment(v_project.assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  SELECT d.* INTO v_document
    FROM evidence.document d
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  -- The latest attempt binds while it is live (P5, P8); after its submission
  -- was withdrawn (SRV-1903) the click is the next attempt.
  SELECT s.* INTO v_existing
    FROM evidence.submission_request s
   WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id
   ORDER BY s.attempt DESC
   LIMIT 1;
  IF FOUND AND evidence.request_live(v_existing.id, v_existing.institution_id) THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  -- A withdrawal whose receipt is not bound yet keeps the next attempt closed:
  -- withdraw_submission reaches only the latest attempt, so its retry must
  -- still find that withdrawal and sign it. The web process answers 503.
  IF FOUND AND EXISTS (
       SELECT 1 FROM evidence.submission x
         JOIN evidence.submission_withdrawal w ON w.submission_id = x.id
        WHERE x.submission_request_id = v_existing.id AND x.institution_id = v_existing.institution_id
          AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal_receipt b WHERE b.withdrawal_id = w.id)) THEN
    RETURN QUERY SELECT 'withdrawal_unsigned'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  v_attempt := coalesce(v_existing.attempt, 0) + 1;
  IF NOT v_assignment.acknowledged THEN
    RETURN QUERY SELECT 'not_acknowledged'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF v_assignment.opens_at > v_now THEN
    RETURN QUERY SELECT 'not_open'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF p_revision = 0 OR v_document.current_revision = 0 THEN
    RETURN QUERY SELECT
      CASE WHEN p_revision = v_document.current_revision THEN 'no_evidence' ELSE 'stale_revision' END,
      NULL::uuid, NULL::timestamptz,
      CASE WHEN p_revision = v_document.current_revision THEN NULL::bigint ELSE v_document.current_revision END,
      NULL::integer;
    RETURN;
  END IF;
  -- The named revision must have been the current one at the click: it was
  -- accepted no later than v_now, and it is the current one now or its
  -- successor was accepted after v_now (a commit that held the document while
  -- this request waited for it).
  SELECT r.* INTO v_named
    FROM evidence.document_revision r
   WHERE r.document_id = v_document.id AND r.institution_id = v_document.institution_id
     AND r.revision = p_revision;
  IF NOT FOUND OR v_named.created_at > v_now OR (p_revision <> v_document.current_revision AND NOT EXISTS (
       SELECT 1 FROM evidence.document_revision n
        WHERE n.document_id = v_document.id AND n.institution_id = v_document.institution_id
          AND n.revision = p_revision + 1 AND n.created_at > v_now)) THEN
    RETURN QUERY SELECT 'stale_revision'::text, NULL::uuid, NULL::timestamptz, v_document.current_revision,
      NULL::integer;
    RETURN;
  END IF;

  -- SRV-1108C: the deadline that holds for the caller now, with the
  -- assignment held FOR SHARE, so no extension is recorded in between.
  v_due := app.student_effective_due_at(v_project.assignment_id);
  IF v_due IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  -- SRV-NF4-KASNA-PROVEDBA: a click after that deadline (P6: exactly at it is
  -- in time) on an assignment whose teacher does not allow late submission is
  -- refused before anything is written. The assignment is still held FOR
  -- SHARE and institution.set_late_submission_allowed takes it FOR UPDATE, so
  -- the value read here is the one in force at the click. The wire answer is
  -- the existing 409 not_open (orchestrator decision A, no contract change).
  IF v_now > v_due AND app.student_late_submission_allowed(v_project.assignment_id) IS NOT TRUE THEN
    RETURN QUERY SELECT 'not_open'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  -- A second document of the same student and assignment can race past the
  -- lookup above; the unique key decides and the loser returns the winner.
  INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at, due_at, attempt
  ) VALUES (
    v_actor.institution_id, v_project.assignment_id, v_assignment.current_version, v_project.id,
    v_document.id, v_actor.user_id, v_named.revision, v_named.content_hash, v_now, v_due, v_attempt
  )
  ON CONFLICT (assignment_id, institution_id, principal_id, attempt) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission_request s
     WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
       AND s.principal_id = v_actor.user_id AND s.attempt = v_attempt;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'requested'::text, v_id, v_now, v_named.revision, v_assignment.current_version;
END
$$;
REVOKE ALL ON FUNCTION app.request_submission(text, bigint) FROM PUBLIC;

SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.student_late_exception_until(uuid);
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;
