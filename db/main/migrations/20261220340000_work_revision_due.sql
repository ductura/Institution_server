-- migrate:up
-- F4-NAS-R16-SRV (NAS-R16, NAS-46; decision of the orchestrator of 26. 11. 2026,
-- Daniel's delegation, Ductus#2058): the revision due date of a work is read
-- back. The teacher writes it when returning a work for revision
-- (evidence.submission_return.revision_due_at, 20261213100600) and until now
-- only the milestone states and the notification carried it; the list of
-- requests and the "Zatražena dorada · rok" line of the work's course had no
-- read. No table changes, no existing function changes.
--
--   app.read_work_revision_due   the one RPC: the due date of the OPEN return of
--                                the work, i.e. the return of the latest
--                                submission of the document, if the student has
--                                not submitted again since.
--
-- The caller is the student who owns the work or a teacher of its assignment
-- (app.work_return_context, the bridge of 20261213100600); everybody else, a
-- work that was never submitted and a work that does not exist read the same
-- not_found, so nobody learns that a work exists (C-23). The comment of the
-- return is NOT read out: this is the date only. SECURITY DEFINER as the
-- evidence role, because the teacher cannot read evidence.submission_return
-- (its policy lets only the owner student select).
--
-- Outcomes: unauthorized, invalid, not_found, ok. An ok row with null columns
-- means no open return (not returned, or submitted again). Nothing is written.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE FUNCTION app.read_work_revision_due(p_document_id text)
RETURNS TABLE (outcome text, attempt integer, revision_due_at timestamptz, returned_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_request evidence.submission_request%ROWTYPE;
  v_ctx record;
  v_return evidence.submission_return%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  IF p_document_id IS NULL OR p_document_id = '' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  -- The work: the latest attempt of the document in the caller's institution.
  SELECT q.* INTO v_request
    FROM evidence.submission_request q
   WHERE q.document_id = p_document_id AND q.institution_id = v_actor.institution_id
   ORDER BY q.attempt DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  SELECT * INTO v_ctx FROM app.work_return_context(v_request.assignment_id, v_request.principal_id);
  IF NOT FOUND OR v_ctx.relation IS NULL OR NOT coalesce(v_ctx.student_is_student, false) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  -- The return of the submission of the latest attempt; none when the student
  -- submitted again (a newer attempt has no return yet) or it was never returned.
  SELECT r.* INTO v_return
    FROM evidence.submission s
    JOIN evidence.submission_return r ON r.submission_id = s.id
   WHERE s.submission_request_id = v_request.id AND s.institution_id = v_request.institution_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'ok'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v_request.attempt, v_return.revision_due_at, v_return.returned_at;
END
$$;

REVOKE ALL ON FUNCTION app.read_work_revision_due(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_revision_due(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.read_work_revision_due(text);
RESET ROLE;
