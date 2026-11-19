-- migrate:up
-- SRV-20 (Ductus#2028, c.7009405737): the state of a student's submission on
-- an assignment, read by assignment and student instead of by submission id
-- (app.read_submission_receipt, 20261027090000), so the student's screen and
-- the teacher's read one shape from one function (PRODUCT 5 rule 5).
--
--   app.submission_state_of        the one reader of the shape; no side
--                                  effect, no access check, not executable
--                                  by ductus_app (only by the definer
--                                  functions of ductus_identity that check
--                                  access first)
--   app.my_submission_state        the caller's own state on an assignment of
--                                  a course where they hold an open student
--                                  membership; writes nothing
--   app.my_assignment_requirements the word range of the current version, for
--                                  the same caller
--
-- States: none (no recorded submission), ceka (recorded, no receipt bound
-- yet: the signer was unavailable, SRV-18 503 signing), potvrdeno (the bound
-- receipt, byte for byte as stored). "Submitted" is a row in
-- evidence.submission, as in app.assignment_submissions: a request alone is
-- not a submission. A caller with no relation gets not_found, the same as
-- for an assignment that does not exist; no session is ZD401.
--
-- The teacher's read (app.teacher_submission_state) logs the read in
-- audit.access_log in the same transaction (rule 17) and waits for the
-- surface (P-5 on Ductus#2028); it reuses app.submission_state_of unchanged.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- The institution comes from the session, never from a parameter. At most
-- one submission per student and assignment (its unique key) and at most one
-- receipt per submission (its primary key), so at most one row.
CREATE FUNCTION app.submission_state_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (
  state text, revision bigint, requested_at timestamptz,
  receipt_payload text, payload_digest_sha256 text, signature jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN x.id IS NULL THEN 'none' WHEN r.submission_id IS NULL THEN 'ceka' ELSE 'potvrdeno' END,
         x.revision, x.requested_at, r.receipt_payload, r.payload_digest_sha256, r.signature
    FROM app.current_actor() a
    LEFT JOIN evidence.submission x
      ON x.assignment_id = p_assignment_id AND x.institution_id = a.institution_id
     AND x.principal_id = p_student_id
    LEFT JOIN evidence.submission_receipt r
      ON r.submission_id = x.id AND r.institution_id = x.institution_id AND r.principal_id = x.principal_id
   WHERE a.institution_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.submission_state_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submission_state_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The caller's own state. The relation is collaboration.actor_role's student
-- branch: an open student membership in the course of the assignment and the
-- caller as owner. A removed student, a teacher of the course and anyone else
-- get not_found.
CREATE FUNCTION app.my_submission_state(p_assignment_id uuid)
RETURNS TABLE (
  state text, revision bigint, requested_at timestamptz,
  receipt_payload text, payload_digest_sha256 text, signature jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::timestamptz, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.submission_state_of(p_assignment_id, v_user);
END
$$;
REVOKE ALL ON FUNCTION app.my_submission_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_submission_state(uuid) TO ductus_app;

-- The word range of the assignment's current version (20261022090000), for a
-- student of its course; NULL bounds are "no bound". Anyone else: not_found.
CREATE FUNCTION app.my_assignment_requirements(p_assignment_id uuid)
RETURNS TABLE (outcome text, word_min integer, word_max integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT 'found'::text, v.word_min, v.word_max
    FROM institution.assignment a
    JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution;
END
$$;
REVOKE ALL ON FUNCTION app.my_assignment_requirements(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_assignment_requirements(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.my_assignment_requirements(uuid);
DROP FUNCTION app.my_submission_state(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.submission_state_of(uuid, uuid);
RESET ROLE;
