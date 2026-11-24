-- migrate:up
-- SRV-NF4-POTVRDE-DORADE (Ductus#2055; NF-4 NZ-8, NZ-12): what the teacher's
-- overview of an assignment still lacked per student, in one read:
--
--   * the notice: when the student marked it as read (institution.notice_read,
--     SRV-06) and the version and time of the latest acknowledgment
--     (institution.notice_acknowledgment);
--   * the revision (dorada): the state of the student's latest revision
--     request on this assignment (open or reopened = otvorena, responded =
--     odgovorena, accepted = zatvorena, withdrawn = povucena) and when it last
--     changed. The tables hold no deadline of a revision, so none is returned.
--
-- The rows are those of app.assignment_submissions for the same caller, as in
-- app.assignment_overview, so the group scope of a collaborator and the
-- "another's is nonexistent" boundary (C-23) are inherited unchanged. It
-- returns no instruction, explanation, anchor or work text, and writes
-- nothing. No session: ZD401. app.assignment_overview itself is untouched.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.assignment_overview_followup(p_assignment_id uuid)
RETURNS TABLE (
  student_id uuid, notice_read_at timestamptz, notice_ack_version integer,
  notice_ack_at timestamptz, revision_state text, revision_changed_at timestamptz
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
  SELECT s.student_id, nr.read_at, ack.version_no, ack.acknowledged_at,
         CASE rq.state WHEN 'open' THEN 'open' WHEN 'reopened' THEN 'open'
           WHEN 'responded' THEN 'responded' WHEN 'accepted' THEN 'closed'
           WHEN 'withdrawn' THEN 'withdrawn' END,
         CASE WHEN rq.id IS NOT NULL THEN (
           SELECT greatest(v.opened_at, v.closed_at, r.created_at)
             FROM collaboration.revision_request_version v
             LEFT JOIN collaboration.revision_response r
               ON r.request_id = v.request_id AND r.version = v.version
            WHERE v.request_id = rq.id AND v.version = rq.version) END
    FROM app.assignment_submissions(p_assignment_id) s
    LEFT JOIN institution.notice_read nr
      ON nr.assignment_id = p_assignment_id AND nr.student_id = s.student_id
     AND nr.institution_id = v_actor.institution_id
    LEFT JOIN LATERAL (
      SELECT n.version_no, n.acknowledged_at FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = p_assignment_id AND n.student_id = s.student_id
       ORDER BY n.version_no DESC LIMIT 1) ack ON true
    LEFT JOIN LATERAL (
      SELECT q.id, q.state, q.version FROM collaboration.revision_request q
       WHERE q.assignment_id = p_assignment_id AND q.owner_id = s.student_id
         AND q.institution_id = v_actor.institution_id
       ORDER BY q.row_seq DESC LIMIT 1) rq ON true
   ORDER BY s.student_id;
END
$$;
REVOKE ALL ON FUNCTION app.assignment_overview_followup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_overview_followup(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assignment_overview_followup(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
