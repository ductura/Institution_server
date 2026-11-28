-- migrate:up
-- F4-STU-R08-SRV (after M2.12-P01b): student.notice.get says whether the
-- current version of the caller's assignment differs from the faculty rule
-- version it is bound to (institution.assignment_version.faculty_rule_version).
-- A student does not read faculty_rule_version (faculty_rule_version_read is
-- for the administrator only), so this definer gives the one boolean and
-- nothing of the rule itself.
--
-- The row compared is the one check_mentorship_version reads: same
-- institution, same kind of work, version_no = the bound version. The fields
-- are the four that trigger checks and that a faculty rule prescribes: AI
-- policy, purposes (as a set), evidence profile and import. The answer is
-- whether any of them is different, narrower as well as wider: a teacher who
-- set less than the faculty allows has set something other than the rule.
--
-- NULL, with no error, when there is nothing to compare or nothing to tell:
-- no live session, an assignment that is not the caller's as a student (of an
-- open course membership or an open mentorship, actor_assignment_ids, the
-- helper of the read policies and of student.notice.get), an unknown one, or
-- a current version bound to no faculty rule version (none for its kind when
-- it was written). Nothing is written; who asks comes only from the session.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.student_assignment_differs_from_faculty_rule(p_assignment_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT (v.ai_policy, v.evidence_profile, v.import_allowed)
           IS DISTINCT FROM (r.ai_policy, r.evidence_profile, r.import_allowed)
         OR NOT (v.ai_purposes <@ r.ai_purposes AND r.ai_purposes <@ v.ai_purposes)
    FROM institution.assignment a
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version AND v.institution_id = a.institution_id
    JOIN institution.faculty_rule_version r
      ON r.institution_id = v.institution_id AND r.work_type = v.work_type
     AND r.version_no = v.faculty_rule_version
   WHERE a.id = p_assignment_id
     AND a.id = ANY ((SELECT institution.actor_assignment_ids('{student}'))::uuid[])
$$;
REVOKE ALL ON FUNCTION institution.student_assignment_differs_from_faculty_rule(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.student_assignment_differs_from_faculty_rule(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.student_assignment_differs_from_faculty_rule(uuid);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
