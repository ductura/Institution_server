-- migrate:up
-- SRV-1108C (wave 11, N-13, chain of SRV-1108): a submission is judged
-- against the deadline that holds for its student, institution.effective_due_at
-- (SRV-1108: the latest extension for that student or for all students, else
-- the due date of the current version), and no longer against the due date of
-- the version alone. The two screens that show the deadline return that same
-- deadline. A submission already recorded is never changed: its row, its
-- deadline, its lateness flag and its signed receipt stay as they are.
--
-- When the deadline is read. The submission request is the student's click
-- (20261018120000); it now also pins the deadline that held at that moment,
-- read under the lock on the assignment that request_submission already takes
-- FOR SHARE (app.lock_student_assignment). An extension takes the same row FOR
-- UPDATE (SRV-1108), so the two are ordered: an extension recorded before the
-- click counts, one recorded after it does not, however long the
-- reconstruction between the request and the submission takes: an extension
-- leaves a submission in progress as it is (N-13). (SRV-1108's
-- earlier_submissions flag counts recorded submissions only, so it does not
-- report a request still waiting for its submission.) record_submission takes
-- the request's deadline; a request made before this migration has none and
-- keeps the old rule (the deadline of its version), so nothing that was
-- requested earlier changes meaning.
--
-- Pinning. evidence.submission named its deadline through a foreign key to
-- the version (assignment, version, due date, institution). That key now holds
-- only for a submission whose request carries no deadline; a submission whose
-- request carries one names it through a key to the request instead. Neither
-- path lets the owner role write a deadline from nowhere:
--
--   request_due_at  the request's deadline, copied by record_submission; null
--                   for a request made before this migration and for every
--                   submission already recorded. When set, due_at must equal
--                   it (check) and it must equal the request's (foreign key).
--   version_due_at  generated: due_at when request_due_at is null. The key to
--                   the version (submission_version_institution_fkey, the same
--                   name, DAN-442) is on this column, so a submission of the
--                   old path still carries its version's own deadline.
--
-- Adding version_due_at rewrites the table without firing a row trigger; the
-- new column of every existing row equals its due_at, and no stored value of
-- an existing row changes.
--
--   app.student_effective_due_at  the caller's own effective deadline on an
--                   assignment where the caller is a student (the relation of
--                   institution.work_relation, C-23); null otherwise. The
--                   bridge for the evidence role (request_submission) and the
--                   web role (app.student_workspace, SECURITY INVOKER), neither
--                   of which reads institution.deadline_extension.
--   app.request_submission     pins due_at; outcomes, signature and grants
--                   unchanged.
--   app.record_submission      the request's deadline, else the version's.
--   app.student_workspace      due_at is the caller's effective deadline.
--   app.assignment_overview    one more column, due_at: the effective deadline
--                   of each student (N-17 shows it beside the lateness flag).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT USAGE ON SCHEMA institution TO ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;

SET LOCAL ROLE ductus_identity;
CREATE FUNCTION app.student_effective_due_at(p_assignment_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT institution.effective_due_at(a.id, c.user_id)
    FROM institution.assignment a
    JOIN app.current_actor() c ON a.institution_id = c.institution_id
   WHERE a.id = p_assignment_id
     AND institution.work_relation(c.user_id, a.id) = 'student'
$$;
REVOKE ALL ON FUNCTION app.student_effective_due_at(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_effective_due_at(uuid) TO ductus_app, ductus_evidence;

-- The overview with the effective deadline of each student. As 20261120130000
-- otherwise; the return type changes, so the function is made again.
-- squawk-ignore ban-drop-function
DROP FUNCTION app.assignment_overview(uuid);
CREATE FUNCTION app.assignment_overview(p_assignment_id uuid)
RETURNS TABLE (
  student_id uuid, given_name text, family_name text, group_name text,
  submitted boolean, requested_minute timestamptz, after_deadline boolean, evidence_record text,
  due_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
  SELECT s.student_id, n.given_name, n.family_name, g.name, s.submitted, s.requested_minute, s.after_deadline,
         CASE WHEN s.submitted THEN (
           SELECT x.receipt_payload::jsonb ->> 'evidenceRecord'
             FROM app.submission_state_of(p_assignment_id, s.student_id) x
            WHERE x.state = 'potvrdeno')
         END,
         institution.effective_due_at(p_assignment_id, s.student_id)
    FROM app.assignment_submissions(p_assignment_id) s
    LEFT JOIN identity.person_name n ON n.user_id = s.student_id AND n.institution_id = v_actor.institution_id
    LEFT JOIN institution.assignment a ON a.id = p_assignment_id AND a.institution_id = v_actor.institution_id
    LEFT JOIN institution.seminar_group_member p
      ON p.course_id = a.course_id AND p.institution_id = a.institution_id AND p.user_id = s.student_id
     AND p.valid_to IS NULL
    LEFT JOIN institution.seminar_group g ON g.id = p.group_id AND g.institution_id = p.institution_id
   ORDER BY s.student_id;
END
$$;
REVOKE ALL ON FUNCTION app.assignment_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_overview(uuid) TO ductus_app;

-- The request pins the deadline; the submission names it.
SET LOCAL ROLE ductus_evidence;
ALTER TABLE evidence.submission_request ADD COLUMN due_at timestamptz;
-- squawk-ignore disallowed-unique-constraint
ALTER TABLE evidence.submission_request ADD CONSTRAINT evidence_submission_request_due_key
  UNIQUE (id, institution_id, due_at);

ALTER TABLE evidence.submission ADD COLUMN request_due_at timestamptz;
-- squawk-ignore adding-field-with-default
ALTER TABLE evidence.submission ADD COLUMN version_due_at timestamptz
  GENERATED ALWAYS AS (CASE WHEN request_due_at IS NULL THEN due_at END) STORED;
ALTER TABLE evidence.submission
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT submission_version_institution_fkey,
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT evidence_submission_request_due_check CHECK (request_due_at IS NULL OR request_due_at = due_at),
  -- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
  ADD CONSTRAINT evidence_submission_request_due_fkey
    FOREIGN KEY (submission_request_id, institution_id, request_due_at)
    REFERENCES evidence.submission_request (id, institution_id, due_at);
-- The key to the version is the identity role's to name (its REFERENCES).
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.assignment_version TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
ALTER TABLE evidence.submission
  -- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
  ADD CONSTRAINT submission_version_institution_fkey
    FOREIGN KEY (assignment_id, assignment_version, version_due_at, institution_id)
    REFERENCES institution.assignment_version (assignment_id, version_no, due_at, institution_id);
SET LOCAL ROLE ductus_identity;
REVOKE REFERENCES ON institution.assignment_version FROM ductus_evidence;
SET LOCAL ROLE ductus_evidence;

-- As 20261018120000; the only change is due_at in the INSERT, read after the
-- assignment is locked.
CREATE OR REPLACE FUNCTION app.request_submission(p_document_id text, p_revision bigint)
RETURNS TABLE (
  outcome text, submission_request_id uuid, requested_at timestamptz, revision bigint,
  assignment_version integer
)
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

  SELECT s.* INTO v_existing
    FROM evidence.submission_request s
   WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
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

  -- A second document of the same student and assignment can race past the
  -- lookup above; the unique key decides and the loser returns the winner.
  INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at, due_at
  ) VALUES (
    v_actor.institution_id, v_project.assignment_id, v_assignment.current_version, v_project.id,
    v_document.id, v_actor.user_id, v_named.revision, v_named.content_hash, v_now, v_due
  )
  ON CONFLICT (assignment_id, institution_id, principal_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission_request s
     WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
       AND s.principal_id = v_actor.user_id;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'requested'::text, v_id, v_now, v_named.revision, v_assignment.current_version;
END
$$;
REVOKE ALL ON FUNCTION app.request_submission(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_submission(text, bigint) TO ductus_app;

-- As 20261106210000; the only change is the deadline: the request's when it
-- carries one, else the version's, and request_due_at beside it.
CREATE OR REPLACE FUNCTION app.record_submission(p_submission_request_id uuid, p_artifact_hash text)
RETURNS TABLE (
  outcome text, submission_id uuid, requested_at timestamptz, due_at timestamptz, after_deadline boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_request evidence.submission_request%ROWTYPE;
  v_due timestamptz;
  v_existing evidence.submission%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  IF p_submission_request_id IS NULL OR p_artifact_hash IS NULL OR p_artifact_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;

  SELECT s.* INTO v_request
    FROM evidence.submission_request s
   WHERE s.id = p_submission_request_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  -- Lock order as in request_submission: assignment and membership first.
  PERFORM 1 FROM app.lock_student_assignment(v_request.assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  -- Compared before the existing row is returned, so a later reconstruction
  -- that no longer matches is never answered as a success.
  IF p_artifact_hash <> v_request.content_hash THEN
    RETURN QUERY SELECT 'artifact_mismatch'::text, NULL::uuid, v_request.requested_at, NULL::timestamptz,
      NULL::boolean;
    RETURN;
  END IF;

  -- SRV-1108C: the deadline the request pinned at the click; a request made
  -- before that has none and is judged against the deadline of the version it
  -- names, not of a later version.
  v_due := coalesce(v_request.due_at,
                    app.assignment_version_due(v_request.assignment_id, v_request.assignment_version));

  -- 4.14: the packages first, in id order as commit_evidence_segment takes its
  -- one, then the document, as the collaboration writes take it (FOR SHARE in
  -- lock_document_for_write). A revision-request write that holds the document
  -- finishes first and stays; one that comes after waits here and then sees
  -- the submission (ZD403). Taken before the INSERT, so the trigger
  -- close_submitted_packages finds its rows already held.
  PERFORM 1 FROM evidence.package k
   WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
   ORDER BY k.id FOR UPDATE;
  PERFORM 1 FROM evidence.document d
   WHERE d.id = v_request.document_id AND d.institution_id = v_request.institution_id
     FOR UPDATE;

  INSERT INTO evidence.submission (
    submission_request_id, institution_id, principal_id, assignment_id, assignment_version, revision,
    artifact_hash, requested_at, due_at, request_due_at, recorded_at
  ) VALUES (
    v_request.id, v_request.institution_id, v_request.principal_id, v_request.assignment_id,
    v_request.assignment_version, v_request.revision, v_request.content_hash, v_request.requested_at, v_due,
    v_request.due_at, pg_catalog.clock_timestamp()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission s
     WHERE s.submission_request_id = v_request.id AND s.institution_id = v_actor.institution_id;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.due_at,
      v_existing.after_deadline;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'recorded'::text, v_id, v_request.requested_at, v_due, v_request.requested_at > v_due;
END
$$;
REVOKE ALL ON FUNCTION app.record_submission(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_submission(uuid, text) TO ductus_app;

-- As 20261102150000; due_at is the caller's effective deadline.
CREATE OR REPLACE FUNCTION app.student_workspace()
RETURNS TABLE (
  assignment_id uuid,
  course_id uuid,
  course_name text,
  academic_year text,
  title text,
  opens_at timestamptz,
  due_at timestamptz,
  current_version integer,
  acknowledged boolean,
  document_id text,
  server_revision bigint,
  submitted_revision bigint,
  submitted_at timestamptz,
  after_deadline boolean
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_institution uuid := app.current_institution_id();
BEGIN
  IF v_user IS NULL OR v_institution IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  -- A project holds the caller's work on one assignment (unique per
  -- assignment, institution and person); a submission is one per the same.
  RETURN QUERY
  SELECT a.id, c.id, c.name, c.academic_year, v.title, v.opens_at,
    coalesce(app.student_effective_due_at(a.id), v.due_at), a.current_version,
    EXISTS (
      SELECT 1 FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = a.id AND n.version_no = a.current_version
         AND n.student_id = v_user AND n.institution_id = v_institution),
    d.id, d.current_revision, s.revision, s.requested_at, s.after_deadline
    FROM institution.course_member m
    JOIN institution.course c
      ON c.id = m.course_id AND c.institution_id = v_institution
    JOIN institution.assignment a
      ON a.course_id = c.id AND a.institution_id = v_institution
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version
    LEFT JOIN evidence.project p
      ON p.assignment_id = a.id AND p.institution_id = v_institution AND p.principal_id = v_user
    LEFT JOIN evidence.document d
      ON d.project_id = p.id AND d.institution_id = v_institution AND d.principal_id = v_user
    LEFT JOIN evidence.submission s
      ON s.assignment_id = a.id AND s.institution_id = v_institution AND s.principal_id = v_user
   WHERE m.user_id = v_user AND m.institution_id = v_institution
     AND m.role = 'student' AND m.member_to IS NULL
   ORDER BY a.id, d.id;
END
$$;
REVOKE ALL ON FUNCTION app.student_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_workspace() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE USAGE ON SCHEMA institution FROM ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- The four functions get their earlier bodies back, then what this migration
-- added is removed; only on a database without a submission on the new path.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT USAGE ON SCHEMA institution TO ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE ductus_identity;
-- squawk-ignore ban-drop-function
DROP FUNCTION app.assignment_overview(uuid);
CREATE FUNCTION app.assignment_overview(p_assignment_id uuid)
RETURNS TABLE (
  student_id uuid, given_name text, family_name text, group_name text,
  submitted boolean, requested_minute timestamptz, after_deadline boolean, evidence_record text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
  SELECT s.student_id, n.given_name, n.family_name, g.name, s.submitted, s.requested_minute, s.after_deadline,
         CASE WHEN s.submitted THEN (
           SELECT x.receipt_payload::jsonb ->> 'evidenceRecord'
             FROM app.submission_state_of(p_assignment_id, s.student_id) x
            WHERE x.state = 'potvrdeno')
         END
    FROM app.assignment_submissions(p_assignment_id) s
    LEFT JOIN identity.person_name n ON n.user_id = s.student_id AND n.institution_id = v_actor.institution_id
    LEFT JOIN institution.assignment a ON a.id = p_assignment_id AND a.institution_id = v_actor.institution_id
    LEFT JOIN institution.seminar_group_member p
      ON p.course_id = a.course_id AND p.institution_id = a.institution_id AND p.user_id = s.student_id
     AND p.valid_to IS NULL
    LEFT JOIN institution.seminar_group g ON g.id = p.group_id AND g.institution_id = p.institution_id
   ORDER BY s.student_id;
END
$$;
REVOKE ALL ON FUNCTION app.assignment_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_overview(uuid) TO ductus_app;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION app.request_submission(p_document_id text, p_revision bigint)
RETURNS TABLE (
  outcome text, submission_request_id uuid, requested_at timestamptz, revision bigint,
  assignment_version integer
)
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

  SELECT s.* INTO v_existing
    FROM evidence.submission_request s
   WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
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

  -- A second document of the same student and assignment can race past the
  -- lookup above; the unique key decides and the loser returns the winner.
  INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at
  ) VALUES (
    v_actor.institution_id, v_project.assignment_id, v_assignment.current_version, v_project.id,
    v_document.id, v_actor.user_id, v_named.revision, v_named.content_hash, v_now
  )
  ON CONFLICT (assignment_id, institution_id, principal_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission_request s
     WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
       AND s.principal_id = v_actor.user_id;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'requested'::text, v_id, v_now, v_named.revision, v_assignment.current_version;
END
$$;

CREATE OR REPLACE FUNCTION app.record_submission(p_submission_request_id uuid, p_artifact_hash text)
RETURNS TABLE (
  outcome text, submission_id uuid, requested_at timestamptz, due_at timestamptz, after_deadline boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_request evidence.submission_request%ROWTYPE;
  v_due timestamptz;
  v_existing evidence.submission%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  IF p_submission_request_id IS NULL OR p_artifact_hash IS NULL OR p_artifact_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;

  SELECT s.* INTO v_request
    FROM evidence.submission_request s
   WHERE s.id = p_submission_request_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  -- Lock order as in request_submission: assignment and membership first.
  PERFORM 1 FROM app.lock_student_assignment(v_request.assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  -- Compared before the existing row is returned, so a later reconstruction
  -- that no longer matches is never answered as a success.
  IF p_artifact_hash <> v_request.content_hash THEN
    RETURN QUERY SELECT 'artifact_mismatch'::text, NULL::uuid, v_request.requested_at, NULL::timestamptz,
      NULL::boolean;
    RETURN;
  END IF;

  -- The deadline of the version the request names, not of a later version.
  v_due := app.assignment_version_due(v_request.assignment_id, v_request.assignment_version);

  -- 4.14: the packages first, in id order as commit_evidence_segment takes its
  -- one, then the document, as the collaboration writes take it (FOR SHARE in
  -- lock_document_for_write). A revision-request write that holds the document
  -- finishes first and stays; one that comes after waits here and then sees
  -- the submission (ZD403). Taken before the INSERT, so the trigger
  -- close_submitted_packages finds its rows already held.
  PERFORM 1 FROM evidence.package k
   WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
   ORDER BY k.id FOR UPDATE;
  PERFORM 1 FROM evidence.document d
   WHERE d.id = v_request.document_id AND d.institution_id = v_request.institution_id
     FOR UPDATE;

  INSERT INTO evidence.submission (
    submission_request_id, institution_id, principal_id, assignment_id, assignment_version, revision,
    artifact_hash, requested_at, due_at, recorded_at
  ) VALUES (
    v_request.id, v_request.institution_id, v_request.principal_id, v_request.assignment_id,
    v_request.assignment_version, v_request.revision, v_request.content_hash, v_request.requested_at, v_due,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission s
     WHERE s.submission_request_id = v_request.id AND s.institution_id = v_actor.institution_id;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.due_at,
      v_existing.after_deadline;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'recorded'::text, v_id, v_request.requested_at, v_due, v_request.requested_at > v_due;
END
$$;

CREATE OR REPLACE FUNCTION app.student_workspace()
RETURNS TABLE (
  assignment_id uuid,
  course_id uuid,
  course_name text,
  academic_year text,
  title text,
  opens_at timestamptz,
  due_at timestamptz,
  current_version integer,
  acknowledged boolean,
  document_id text,
  server_revision bigint,
  submitted_revision bigint,
  submitted_at timestamptz,
  after_deadline boolean
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_institution uuid := app.current_institution_id();
BEGIN
  IF v_user IS NULL OR v_institution IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  -- A project holds the caller's work on one assignment (unique per
  -- assignment, institution and person); a submission is one per the same.
  RETURN QUERY
  SELECT a.id, c.id, c.name, c.academic_year, v.title, v.opens_at, v.due_at, a.current_version,
    EXISTS (
      SELECT 1 FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = a.id AND n.version_no = a.current_version
         AND n.student_id = v_user AND n.institution_id = v_institution),
    d.id, d.current_revision, s.revision, s.requested_at, s.after_deadline
    FROM institution.course_member m
    JOIN institution.course c
      ON c.id = m.course_id AND c.institution_id = v_institution
    JOIN institution.assignment a
      ON a.course_id = c.id AND a.institution_id = v_institution
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version
    LEFT JOIN evidence.project p
      ON p.assignment_id = a.id AND p.institution_id = v_institution AND p.principal_id = v_user
    LEFT JOIN evidence.document d
      ON d.project_id = p.id AND d.institution_id = v_institution AND d.principal_id = v_user
    LEFT JOIN evidence.submission s
      ON s.assignment_id = a.id AND s.institution_id = v_institution AND s.principal_id = v_user
   WHERE m.user_id = v_user AND m.institution_id = v_institution
     AND m.role = 'student' AND m.member_to IS NULL
   ORDER BY a.id, d.id;
END
$$;
ALTER TABLE evidence.submission
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT submission_version_institution_fkey,
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT evidence_submission_request_due_fkey,
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT evidence_submission_request_due_check,
  -- squawk-ignore ban-drop-column
  DROP COLUMN version_due_at,
  -- squawk-ignore ban-drop-column
  DROP COLUMN request_due_at;
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.assignment_version TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
ALTER TABLE evidence.submission
  ADD CONSTRAINT submission_version_institution_fkey
    FOREIGN KEY (assignment_id, assignment_version, due_at, institution_id)
    REFERENCES institution.assignment_version (assignment_id, version_no, due_at, institution_id);
SET LOCAL ROLE ductus_identity;
REVOKE REFERENCES ON institution.assignment_version FROM ductus_evidence;
SET LOCAL ROLE ductus_evidence;
-- squawk-ignore ban-drop-constraint
ALTER TABLE evidence.submission_request DROP CONSTRAINT evidence_submission_request_due_key;
-- squawk-ignore ban-drop-column
ALTER TABLE evidence.submission_request DROP COLUMN due_at;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.student_effective_due_at(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE USAGE ON SCHEMA institution FROM ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;
