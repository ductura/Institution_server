-- migrate:up
-- M2.12-P01b (D-175, D-117; after DAN-315, M2.12-P01a): an assignment version
-- names the faculty rule version in force for its kind of work, and the rule
-- of a mentorship's work is checked against that version, not against the
-- current projection in faculty_work_rule.
--
-- institution.assignment_version.faculty_rule_version is set by a trigger on
-- insert, whatever the caller sent; a version is never updated afterwards
-- (assignment_version_immutable). The first version of an assignment, and the
-- first one of another kind of work, takes the latest published version of
-- the faculty for that kind; a later version of the same kind takes what the
-- version before it of that kind named, so the assignment stays on the rule
-- it was created under while the faculty publishes newer ones. No version for
-- the kind leaves the column NULL, as config_version does for an assignment
-- created before any configuration. The foreign key ties the value to a
-- version of the same institution and kind of work.
--
-- Existing versions take the latest version of their institution and kind at
-- this migration, which is version 1 of the conversion in P01a unless an
-- administrator has published since. Before that, a rule in faculty_work_rule
-- that has no version, or differs from its latest version (written directly
-- by the operator after P01a), becomes the next version of the operator, so
-- the projection and the chain agree and the mentorship check below decides
-- as it did.
--
-- check_mentorship_version now reads the version the new row names. A
-- mentorship's assignment is written once, as version 1, by the functions
-- that read faculty_work_rule FOR SHARE in the same transaction, and
-- publish_faculty_rule_version must update that row before it commits, so the
-- version named is the one the projection holds: the decision is the same
-- today. The difference is for later: a version written under a newer
-- faculty rule is checked against the rule the work was created under.
-- No new route, no change of RLS or grants: ductus_app still cannot write
-- assignment_version, and the column is read under the existing policies.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The projection and the chain agree before anything is bound.
INSERT INTO institution.faculty_rule_version
  (institution_id, work_type, version_no, ai_policy, ai_purposes, evidence_profile, import_allowed,
   origin, published_by)
SELECT r.institution_id, r.work_type, coalesce(l.version_no, 0) + 1, r.ai_policy, r.ai_purposes,
       r.evidence_profile, r.import_allowed, 'operator', NULL
  FROM institution.faculty_work_rule r
  LEFT JOIN LATERAL (
    SELECT v.version_no, v.ai_policy, v.ai_purposes, v.evidence_profile, v.import_allowed
      FROM institution.faculty_rule_version v
     WHERE v.institution_id = r.institution_id AND v.work_type = r.work_type
     ORDER BY v.version_no DESC LIMIT 1
  ) l ON true
 WHERE l.version_no IS NULL
    OR (l.ai_policy, l.ai_purposes, l.evidence_profile, l.import_allowed)
       IS DISTINCT FROM (r.ai_policy, r.ai_purposes, r.evidence_profile, r.import_allowed);

-- Versions are immutable; the trigger that says so is off for this one update.
ALTER TABLE institution.assignment_version ADD COLUMN faculty_rule_version integer;
ALTER TABLE institution.assignment_version DISABLE TRIGGER assignment_version_immutable;
UPDATE institution.assignment_version av
   SET faculty_rule_version = l.version_no
  FROM (SELECT v.institution_id, v.work_type, max(v.version_no) AS version_no
          FROM institution.faculty_rule_version v
         GROUP BY v.institution_id, v.work_type) l
 WHERE l.institution_id = av.institution_id AND l.work_type = av.work_type;
ALTER TABLE institution.assignment_version ENABLE TRIGGER assignment_version_immutable;
ALTER TABLE institution.assignment_version
  -- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
  ADD CONSTRAINT assignment_version_faculty_rule_version_fkey
  FOREIGN KEY (institution_id, work_type, faculty_rule_version)
  REFERENCES institution.faculty_rule_version (institution_id, work_type, version_no);

-- Runs after assignment_version_institution_fill and before
-- assignment_version_mentorship_rule, which fire in the order of their names.
-- A definer: ductus_app does not read the versions, and whichever role
-- writes the row, the value comes from the database.
CREATE FUNCTION institution.link_assignment_rule_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_earlier record;
BEGIN
  SELECT p.faculty_rule_version INTO v_earlier
    FROM institution.assignment_version p
   WHERE p.assignment_id = NEW.assignment_id AND p.version_no < NEW.version_no AND p.work_type = NEW.work_type
   ORDER BY p.version_no DESC
   LIMIT 1;
  IF FOUND THEN
    NEW.faculty_rule_version := v_earlier.faculty_rule_version;
  ELSE
    NEW.faculty_rule_version := (SELECT max(r.version_no) FROM institution.faculty_rule_version r
                                  WHERE r.institution_id = NEW.institution_id AND r.work_type = NEW.work_type);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION institution.link_assignment_rule_version() FROM PUBLIC;
CREATE TRIGGER assignment_version_link_faculty_rule BEFORE INSERT ON institution.assignment_version
  FOR EACH ROW EXECUTE FUNCTION institution.link_assignment_rule_version();

-- A version of a mentorship's assignment is of the mentorship's work type and
-- never wider than the faculty rule version it names. Without a rule for the
-- mentorship's kind nothing is written (ZD503), as before; another kind of
-- work is refused (ZD422), as before.
CREATE OR REPLACE FUNCTION institution.check_mentorship_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
  v_rule record;
BEGIN
  SELECT m.institution_id, m.work_type INTO v_work
    FROM institution.assignment a
    JOIN institution.mentorship m ON m.id = a.mentorship_id AND m.institution_id = a.institution_id
   WHERE a.id = NEW.assignment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.work_type IS DISTINCT FROM v_work.work_type THEN
    IF NOT EXISTS (SELECT 1 FROM institution.faculty_rule_version r
                    WHERE r.institution_id = v_work.institution_id AND r.work_type = v_work.work_type) THEN
      RAISE EXCEPTION 'not set up' USING ERRCODE = 'ZD503';
    END IF;
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT r.ai_policy, r.ai_purposes, r.evidence_profile, r.import_allowed INTO v_rule
    FROM institution.faculty_rule_version r
   WHERE r.institution_id = v_work.institution_id AND r.work_type = v_work.work_type
     AND r.version_no = NEW.faculty_rule_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not set up' USING ERRCODE = 'ZD503';
  END IF;
  IF NOT coalesce(
       institution.ai_policy_rank(NEW.ai_policy) <= institution.ai_policy_rank(v_rule.ai_policy)
       AND NEW.ai_purposes <@ v_rule.ai_purposes
       AND (NEW.evidence_profile = 'basic' OR v_rule.evidence_profile = 'extended')
       AND (NOT NEW.import_allowed OR v_rule.import_allowed),
       false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
-- The versions the operator gained above stay: a published version never
-- goes, and each equals the projection it came from.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION institution.check_mentorship_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_work record;
  v_rule record;
BEGIN
  SELECT m.institution_id, m.work_type INTO v_work
    FROM institution.assignment a
    JOIN institution.mentorship m ON m.id = a.mentorship_id AND m.institution_id = a.institution_id
   WHERE a.id = NEW.assignment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT r.ai_policy, r.ai_purposes, r.evidence_profile, r.import_allowed INTO v_rule
    FROM institution.faculty_work_rule r
   WHERE r.institution_id = v_work.institution_id AND r.work_type = v_work.work_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not set up' USING ERRCODE = 'ZD503';
  END IF;
  IF NOT coalesce(
       NEW.work_type = v_work.work_type
       AND institution.ai_policy_rank(NEW.ai_policy) <= institution.ai_policy_rank(v_rule.ai_policy)
       AND NEW.ai_purposes <@ v_rule.ai_purposes
       AND (NEW.evidence_profile = 'basic' OR v_rule.evidence_profile = 'extended')
       AND (NOT NEW.import_allowed OR v_rule.import_allowed),
       false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER assignment_version_link_faculty_rule ON institution.assignment_version;
DROP FUNCTION institution.link_assignment_rule_version();
ALTER TABLE institution.assignment_version DROP CONSTRAINT assignment_version_faculty_rule_version_fkey;
ALTER TABLE institution.assignment_version DROP COLUMN faculty_rule_version;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
