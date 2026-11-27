-- migrate:up
-- F4 wave 2 #5, task 1.8 (docs/plan/valovi-f4-srv.md, section 5; ODOBRENO of
-- 27. 11. 2026): the link between an assignment and the seminar groups of its
-- course. Today institution.course-assignments.post answers 422 for any
-- non-empty groupIds, because nothing could store them; this is that store.
-- The route is wired in a later PR and still answers 422 after this one.
--
--   institution.assignment_group      one row per assignment and group. Both
--                   carry the course: the group by its key (group, course,
--                   institution), the assignment by the trigger below, so a
--                   group of another course can never be linked, whoever
--                   writes. Rows are never deleted, like every row of a group
--                   (20261102160000), and the foreign keys are the default
--                   NO ACTION of every other reference to an assignment or a
--                   group: an assignment or a group with a link stays.
--   add_assignment_groups(a, groups)  a teacher of the assignment's course
--                   links groups of that course; the caller comes from the
--                   session. A null list, a null or repeated id, or a group
--                   that is not of the course is ZD422; an assignment that
--                   does not exist, or of a course the caller does not teach,
--                   is ZD403; ZD401 without a session. A link that exists
--                   stays one row (a replay of the create request changes
--                   nothing). Answers the number of new links.
--   assignment_groups(a)              the linked groups (id, name) by id, for
--                   the same teacher; anyone else is ZD403.
--
-- Who may is who creates the assignment (create_assignment: a teacher of the
-- course, C-23), so nobody gains anything here. ductus_app gets no privilege
-- on the table: it reads and writes only through the two functions.
-- Errors carry no input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.assignment_group (
  assignment_id uuid NOT NULL,
  group_id uuid NOT NULL,
  course_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, group_id),
  CONSTRAINT assignment_group_assignment_fkey
    FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  CONSTRAINT assignment_group_group_fkey
    FOREIGN KEY (group_id, course_id, institution_id) REFERENCES institution.seminar_group (id, course_id, institution_id),
  CONSTRAINT assignment_group_assigned_by_fkey
    FOREIGN KEY (assigned_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assignment_group_group_idx ON institution.assignment_group (group_id);

ALTER TABLE institution.assignment_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.assignment_group FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_group_owner ON institution.assignment_group TO ductus_identity
  USING (true) WITH CHECK (true);

-- The course of the row is the course of the assignment.
CREATE FUNCTION institution.check_assignment_group_course() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM institution.assignment a
                  WHERE a.id = NEW.assignment_id AND a.course_id = NEW.course_id
                    AND a.institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assignment_group_same_course
  BEFORE INSERT OR UPDATE ON institution.assignment_group
  FOR EACH ROW EXECUTE FUNCTION institution.check_assignment_group_course();

CREATE FUNCTION institution.add_assignment_groups(p_assignment_id uuid, p_group_ids uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_course uuid;
  v_added integer;
BEGIN
  SELECT a.course_id INTO v_course FROM institution.assignment a WHERE a.id = p_assignment_id;
  -- ZD401 without a session; ZD403 for no assignment, a course without one
  -- (a mentorship's) or one the caller does not teach.
  SELECT * INTO actor FROM institution.require_course_teacher(v_course);
  IF p_group_ids IS NULL OR coalesce(array_ndims(p_group_ids), 1) <> 1
     OR array_position(p_group_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u.g) FROM unnest(p_group_ids) AS u (g)) <> cardinality(p_group_ids)
     OR (SELECT count(*) FROM institution.seminar_group s
          WHERE s.id = ANY (p_group_ids) AND s.course_id = v_course
            AND s.institution_id = actor.institution_id) <> cardinality(p_group_ids) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.assignment_group (assignment_id, group_id, course_id, institution_id, assigned_by)
  SELECT p_assignment_id, u.g, v_course, actor.institution_id, actor.user_id
    FROM unnest(p_group_ids) AS u (g)
  ON CONFLICT (assignment_id, group_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_added;
END
$$;

CREATE FUNCTION institution.assignment_groups(p_assignment_id uuid)
RETURNS TABLE (group_id uuid, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_course uuid;
BEGIN
  SELECT a.course_id INTO v_course FROM institution.assignment a WHERE a.id = p_assignment_id;
  SELECT * INTO actor FROM institution.require_course_teacher(v_course);
  RETURN QUERY
  SELECT s.id, s.name
    FROM institution.assignment_group l
    JOIN institution.seminar_group s
      ON s.id = l.group_id AND s.course_id = l.course_id AND s.institution_id = l.institution_id
   WHERE l.assignment_id = p_assignment_id AND l.institution_id = actor.institution_id
   ORDER BY s.id;
END
$$;

REVOKE ALL ON FUNCTION
  institution.check_assignment_group_course(),
  institution.add_assignment_groups(uuid, uuid[]),
  institution.assignment_groups(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  institution.add_assignment_groups(uuid, uuid[]),
  institution.assignment_groups(uuid)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.assignment_groups(uuid), institution.add_assignment_groups(uuid, uuid[]);
DROP TABLE institution.assignment_group;
DROP FUNCTION institution.check_assignment_group_course();

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
