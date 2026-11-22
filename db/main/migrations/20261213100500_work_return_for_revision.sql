-- migrate:up
-- SRV-1606 (Ductus#2052, WEB-2155, WEB-2121): the teacher returns the WHOLE submitted
-- work to the student for revision. It is neither a milestone (work_milestone_progress,
-- SRV-1520) nor a comment anchored in the text (collaboration revision request): it
-- acts on the submission of the work itself.
--
-- A return is one append-only record per submission (evidence.submission_return): who
-- returned it, the comment, the optional revision due date (a reminder, as the
-- revision due date of a milestone: it never blocks writing or submitting) and when.
-- A returned submission is no longer the live one, exactly as a withdrawn one
-- (SRV-1903): evidence.submission_withdrawn and evidence.request_live count it, so
-- the student's next submission request is the next attempt (the next round, as in the
-- history of submissions and withdrawals), and the packages the submission closed
-- accept evidence again, so the student edits and submits as a new round. Nothing is
-- deleted or changed; the returned submission and its receipt stay.
--
-- Who may (C-23, from the relation, never from the role alone): a teacher of the
-- assignment of the work, that is the teacher of its course or the mentor of its
-- mentorship (institution.work_relation = 'teacher'). Nobody else: a student, a
-- co-mentor or committee member by work grant, a collaborator or a person with no part
-- in the work. The student owner of the work who tries gets forbidden; everybody else
-- who is not its teacher gets not_found, so that nobody learns that a work exists.
--
--   evidence.submission_return          the record, append-only
--   app.work_return_context             the bridge for the evidence role, which does
--                                       not read schema institution
--   app.return_work_for_revision        the one RPC
--
-- Outcomes in check order: unauthorized, invalid, not_found, forbidden, not_submitted
-- (no live submission: none yet, withdrawn or already returned), returned.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;

-- 1. The bridge (identity role).
SET LOCAL ROLE ductus_identity;
-- The caller's relation to the work: teacher (of the assignment), owner (the student
-- herself) or none; and whether the named person is a student of the assignment.
-- Only the actor of the session is asked; nothing else is read out.
CREATE FUNCTION app.work_return_context(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (relation text, student_is_student boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
           WHEN institution.work_relation(c.user_id, a.id) = 'teacher' THEN 'teacher'
           WHEN c.user_id = p_student_id THEN 'owner'
         END,
         institution.work_relation(p_student_id, a.id) = 'student'
    FROM institution.assignment a
    JOIN app.current_actor() c ON a.institution_id = c.institution_id
   WHERE a.id = p_assignment_id
$$;

REVOKE ALL ON FUNCTION app.work_return_context(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_return_context(uuid, uuid) TO ductus_evidence;

-- 2. The record and the RPC (evidence role).
SET LOCAL ROLE ductus_evidence;
CREATE TABLE evidence.submission_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE,
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  document_id text NOT NULL,
  -- The teacher. Identity lives in schema institution, which this role does not read.
  returned_by uuid NOT NULL,
  comment text NOT NULL CHECK (char_length(comment) BETWEEN 1 AND 2000 AND comment ~ '[^[:space:]]'),
  revision_due_at timestamptz
    CHECK (revision_due_at >= '0001-01-01T00:00:00Z' AND revision_due_at < '10000-01-01T00:00:00Z'),
  returned_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (submission_id, institution_id, principal_id, assignment_id)
    REFERENCES evidence.submission (id, institution_id, principal_id, assignment_id)
);
CREATE INDEX evidence_submission_return_principal_idx
  ON evidence.submission_return (principal_id, institution_id);
CREATE INDEX evidence_submission_return_document_idx
  ON evidence.submission_return (document_id, institution_id);
ALTER TABLE evidence.submission_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.submission_return FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_submission_return_owner ON evidence.submission_return
  TO ductus_evidence USING (true) WITH CHECK (true);
-- The student reads the own returns, as the own withdrawals (app.student_workspace
-- reads them with the caller's rights).
CREATE POLICY evidence_submission_return_read ON evidence.submission_return FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id()) AND principal_id = (SELECT app.current_user_id()));
GRANT SELECT ON evidence.submission_return TO ductus_app;
CREATE TRIGGER evidence_submission_return_immutable BEFORE UPDATE OR DELETE ON evidence.submission_return
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER evidence_submission_return_no_truncate BEFORE TRUNCATE ON evidence.submission_return
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- A returned submission is not the live one, as a withdrawn one.
CREATE OR REPLACE FUNCTION evidence.submission_withdrawn(p_submission_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = p_submission_id)
      OR EXISTS (SELECT 1 FROM evidence.submission_return r WHERE r.submission_id = p_submission_id)
$$;
CREATE OR REPLACE FUNCTION evidence.request_live(p_request_id uuid, p_institution_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM evidence.submission s
     WHERE s.submission_request_id = p_request_id AND s.institution_id = p_institution_id
       AND (EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = s.id)
            OR EXISTS (SELECT 1 FROM evidence.submission_return r WHERE r.submission_id = s.id)))
$$;

-- app.student_workspace runs with the caller's rights and inlined the withdrawal
-- predicate (SRV-1903); it now also leaves out a returned submission. The
-- replacement must apply exactly once, or the migration fails.
DO $$
DECLARE
  v_def text;
  v_old constant text := E'AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = s.id)';
  v_new constant text := E'AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = s.id)\n'
    '     AND NOT EXISTS (SELECT 1 FROM evidence.submission_return rt WHERE rt.submission_id = s.id)';
BEGIN
  v_def := pg_catalog.pg_get_functiondef('app.student_workspace()'::regprocedure);
  IF (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, v_old, '')))
     / pg_catalog.length(v_old) <> 1 THEN
    RAISE EXCEPTION 'SRV-1606: app.student_workspace() does not contain the expected text';
  END IF;
  EXECUTE pg_catalog.replace(v_def, v_old, v_new);
END
$$;

CREATE FUNCTION app.return_work_for_revision(p_document_id text, p_comment text, p_revision_due_at timestamptz)
RETURNS TABLE(outcome text, return_id uuid, assignment_id uuid, student_id uuid, attempt integer,
              comment text, revision_due_at timestamptz, returned_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_request evidence.submission_request%ROWTYPE;
  v_latest uuid;
  v_ctx record;
  v_submission evidence.submission%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_at timestamptz := pg_catalog.statement_timestamp();
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  IF p_document_id IS NULL OR p_document_id = '' OR p_comment IS NULL
     OR pg_catalog.char_length(p_comment) NOT BETWEEN 1 AND 2000 OR p_comment !~ '[^[:space:]]'
     OR (p_revision_due_at IS NOT NULL AND (p_revision_due_at < '0001-01-01T00:00:00Z'
                                            OR p_revision_due_at >= '10000-01-01T00:00:00Z')) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  -- The work: the latest attempt of the document in the caller's institution.
  SELECT q.* INTO v_request
    FROM evidence.submission_request q
   WHERE q.document_id = p_document_id AND q.institution_id = v_actor.institution_id
   ORDER BY q.attempt DESC
   LIMIT 1;
  IF NOT FOUND THEN
    -- A work that was never submitted may exist, but there is nothing to return.
    -- Whether the caller has a part in it is not told: not_found.
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  SELECT * INTO v_ctx FROM app.work_return_context(v_request.assignment_id, v_request.principal_id);
  IF NOT FOUND OR v_ctx.relation IS NULL OR NOT coalesce(v_ctx.student_is_student, false) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  IF v_ctx.relation <> 'teacher' THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  -- record_submission's order: the packages of the document, then the document. A
  -- submission, a commit, a withdrawal and another return of this document wait for
  -- this one, or this one for them.
  PERFORM 1 FROM evidence.package k
    WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
    ORDER BY k.id FOR UPDATE;
  PERFORM 1 FROM evidence.document d
    WHERE d.id = v_request.document_id AND d.institution_id = v_request.institution_id FOR UPDATE;
  -- A request made while this one waited is newer than the one locked.
  SELECT q.id INTO v_latest
    FROM evidence.submission_request q
   WHERE q.document_id = p_document_id AND q.institution_id = v_actor.institution_id
   ORDER BY q.attempt DESC
   LIMIT 1;
  IF v_latest IS DISTINCT FROM v_request.id THEN
    RETURN QUERY SELECT 'not_submitted'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  SELECT x.* INTO v_submission
    FROM evidence.submission x
   WHERE x.submission_request_id = v_request.id AND x.institution_id = v_request.institution_id;
  IF NOT FOUND OR evidence.submission_withdrawn(v_submission.id) THEN
    RETURN QUERY SELECT 'not_submitted'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer,
      NULL::text, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  INSERT INTO evidence.submission_return
    (id, submission_id, institution_id, principal_id, assignment_id, document_id, returned_by,
     comment, revision_due_at, returned_at)
  VALUES (v_id, v_submission.id, v_submission.institution_id, v_submission.principal_id,
          v_submission.assignment_id, v_request.document_id, v_actor.user_id,
          p_comment, p_revision_due_at, v_at);
  -- The packages the submission closed accept again (keep_submitted_package_closed
  -- now sees no live submission of the document), so the student edits and submits
  -- the next attempt.
  UPDATE evidence.package k SET accepts_evidence = true
   WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
     AND NOT k.accepts_evidence;
  RETURN QUERY SELECT 'returned'::text, v_id, v_submission.assignment_id, v_submission.principal_id,
    v_request.attempt, p_comment, p_revision_due_at, v_at;
END
$$;

REVOKE ALL ON FUNCTION app.return_work_for_revision(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.return_work_for_revision(text, text, timestamptz) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;

-- migrate:down
-- Forward only. Staging and production only go forward (docs/BACKEND.md §6), and a
-- database with a returned submission cannot go back to a world where it is live.
-- A local database is made again with db:up instead.
DO $$
BEGIN
  RAISE EXCEPTION 'SRV-1606 (20261213100500) does not go down; recreate the local database';
END
$$;
