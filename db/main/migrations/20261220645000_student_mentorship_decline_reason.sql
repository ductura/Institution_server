-- migrate:up
-- F4 wave 2 #3 (design order 1.4, Ductus#2059; plan valovi-f4-srv.md §5,
-- approved 27 Nov 2026): the student reads why the teacher declined the own
-- mentorship request. The reason was kept only in the audit row
-- (audit.mentorship_event, 20261120120000) and P-6 kept it from the student;
-- the owner's approval of wave 2 lifts that for the student of the request.
--
--   app.student_mentorship_decline_reason(p_request_id)  the reason of the
--                       caller's own declined request; null when the request
--                       is not declined or the teacher gave no reason.
--
-- Access comes from the relation alone (C-23): the caller must be the student
-- of that request, in the caller's institution, with the actor from the
-- session. The teacher who declined, another student, an administrator and a
-- request that does not exist all get the same ZD403; ZD401 without a
-- session. Errors carry no input. The audit table itself stays closed to every
-- role but its owner; this function reads one column of one row.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.student_mentorship_decline_reason(p_request_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT r.id, r.institution_id, r.declined_at INTO req FROM institution.mentorship_request r
   WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.student_id = actor.user_id;
  IF req.id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF req.declined_at IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT e.reason FROM audit.mentorship_event e
           WHERE e.request_id = req.id AND e.institution_id = req.institution_id AND e.kind = 'declined');
END
$$;
REVOKE ALL ON FUNCTION app.student_mentorship_decline_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_mentorship_decline_reason(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.student_mentorship_decline_reason(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
