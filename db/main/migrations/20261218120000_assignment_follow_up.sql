-- migrate:up
-- SRV-NF4-POTVRDE-DORADE (Ductus#2055; orchestrator's answer of 24 Nov 2026):
-- what the teacher reads beside the overview of an assignment, per student.
--
--   app.assignment_follow_up  one row per row of app.assignment_submissions
--                       for the same caller, in its order: the UTC minute the
--                       student first read the notice (institution.notice_read),
--                       the minute and number of the latest acknowledged
--                       version of the notice (institution.notice_acknowledgment),
--                       and of the student's revision requests on the
--                       assignment the one with the latest change: its state,
--                       the five-minute window of that change (P-03, as
--                       collaboration.list_revision_requests) and the number of
--                       open requests. A change is the opening or closing of a
--                       version or the student's response to it. No text, no
--                       anchor, no document id and no person but the student;
--                       it writes nothing and opens no work, so there is no
--                       audit.access_log row. A revision has no deadline.
--
-- The reach is that of app.assignment_submissions and so of the overview
-- (20261120130000): the holder and every teacher of the course get the whole
-- course, a collaborator the students of the own groups, anyone else nothing,
-- the same as an assignment that does not exist. No new table, no new grant
-- on a table. No session: ZD401.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.assignment_follow_up(p_assignment_id uuid)
RETURNS TABLE (
  student_id uuid, notice_read_minute timestamptz, notice_acknowledged_minute timestamptz,
  notice_version_no integer, revision_state text, revision_changed_window timestamptz,
  open_revision_count integer
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
  SELECT s.student_id,
         date_bin('1 minute', nr.read_at, timestamptz '2000-01-01 00:00:00+00'),
         date_bin('1 minute', ack.acknowledged_at, timestamptz '2000-01-01 00:00:00+00'),
         ack.version_no,
         CASE rv.state WHEN 'open' THEN 'open' WHEN 'reopened' THEN 'open' WHEN 'responded' THEN 'responded'
                       WHEN 'accepted' THEN 'closed' WHEN 'withdrawn' THEN 'withdrawn' END,
         date_bin('5 minutes', rv.changed_at, timestamptz '2000-01-01 00:00:00+00'),
         (SELECT count(*)::integer FROM collaboration.revision_request q
           WHERE q.assignment_id = p_assignment_id AND q.owner_id = s.student_id
             AND q.institution_id = v_actor.institution_id AND q.state IN ('open', 'reopened'))
    FROM app.assignment_submissions(p_assignment_id) s
    LEFT JOIN institution.notice_read nr
      ON nr.assignment_id = p_assignment_id AND nr.student_id = s.student_id
     AND nr.institution_id = v_actor.institution_id
    LEFT JOIN LATERAL (
      SELECT n.version_no, n.acknowledged_at FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = p_assignment_id AND n.student_id = s.student_id
         AND n.institution_id = v_actor.institution_id
       ORDER BY n.version_no DESC LIMIT 1
    ) ack ON true
    LEFT JOIN LATERAL (
      SELECT q.state, c.changed_at
        FROM collaboration.revision_request q
        CROSS JOIN LATERAL (
          SELECT max(greatest(v.opened_at, v.closed_at, x.created_at)) AS changed_at
            FROM collaboration.revision_request_version v
            LEFT JOIN collaboration.revision_response x
              ON x.request_id = v.request_id AND x.version = v.version AND x.institution_id = v.institution_id
           WHERE v.request_id = q.id AND v.institution_id = q.institution_id
        ) c
       WHERE q.assignment_id = p_assignment_id AND q.owner_id = s.student_id
         AND q.institution_id = v_actor.institution_id
       ORDER BY c.changed_at DESC NULLS LAST, q.row_seq DESC
       LIMIT 1
    ) rv ON true
   ORDER BY s.student_id;
END
$$;
REVOKE ALL ON FUNCTION app.assignment_follow_up(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_follow_up(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assignment_follow_up(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
