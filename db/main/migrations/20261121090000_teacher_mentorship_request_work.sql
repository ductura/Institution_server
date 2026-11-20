-- migrate:up
-- SRV-31: read the name only through the open request relationship, and
-- create the mentored work in the same transaction as the approval.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.teacher_mentorship_requests()
RETURNS TABLE (
  request_id uuid, given_name text, family_name text, work_type text, requested_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.id, n.given_name, n.family_name, r.work_type, r.requested_at
  FROM app.current_actor() a
  JOIN institution.mentorship_request r ON r.institution_id = a.institution_id AND r.teacher_id = a.user_id
  LEFT JOIN identity.person_name n ON n.institution_id = r.institution_id AND n.user_id = r.student_id
  WHERE r.withdrawn_at IS NULL AND r.approved_at IS NULL AND r.declined_at IS NULL
    AND institution.actor_has_role('teacher')
$$;

CREATE FUNCTION app.approve_mentorship_request_with_work(p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req institution.mentorship_request;
  work_rule institution.faculty_work_rule;
  v_mentorship uuid;
  v_assignment uuid;
  v_title text;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  -- The legacy approval acquires these same locks in this order. The row
  -- lock also serializes this decision with a decline.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'institution.mentorship_request:' || req.institution_id || ':' || req.student_id || ':' || req.work_type, 0));
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id
  FOR UPDATE;
  v_mentorship := institution.approve_mentorship_request(p_request_id);
  IF req.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;

  SELECT * INTO work_rule FROM institution.faculty_work_rule r
  WHERE r.institution_id = req.institution_id AND r.work_type = req.work_type
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not set up' USING ERRCODE = 'ZD503';
  END IF;
  v_title := CASE req.work_type
    WHEN 'bachelor_thesis' THEN 'Završni rad'
    WHEN 'master_thesis' THEN 'Diplomski rad'
    WHEN 'specialist_thesis' THEN 'Specijalistički rad'
    WHEN 'doctoral_thesis' THEN 'Doktorski rad'
  END;

  INSERT INTO institution.assignment (institution_id, mentorship_id, created_by)
  VALUES (req.institution_id, v_mentorship, actor.user_id)
  RETURNING id INTO v_assignment;
  INSERT INTO institution.assignment_version (
    assignment_id, version_no, title, instructions, work_type, opens_at, due_at,
    ai_policy, ai_purposes, evidence_profile, import_allowed, created_by
  ) VALUES (
    v_assignment, 1, v_title, '', req.work_type, now(), now() + interval '365 days',
    work_rule.ai_policy, work_rule.ai_purposes, work_rule.evidence_profile, work_rule.import_allowed, actor.user_id
  );
  RETURN v_mentorship;
END
$$;

REVOKE ALL ON FUNCTION app.teacher_mentorship_requests(),
  app.approve_mentorship_request_with_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_mentorship_requests(),
  app.approve_mentorship_request_with_work(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.approve_mentorship_request_with_work(uuid);
DROP FUNCTION app.teacher_mentorship_requests();
