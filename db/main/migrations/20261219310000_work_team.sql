-- migrate:up
-- SRV-V19-GRUPA-BAZA (Ductus#2055; val 19, docs/nalazi/val19-razlika.md §5
-- task 7; contract docs/contracts/work-team-v1.md): teams of students on an
-- assignment. The teacher turns teams on per assignment (size 2 to 6, formed by
-- the students or by the teacher); every member does their own part of the
-- work, there is no shared document. Nothing here enters a grade, ranks,
-- compares or sanctions anyone, and the contribution (a later task) is not
-- stored here.
--
--   institution.assignment_team_setting   the versions of the setting of an
--                                         assignment: enabled, fewest and most
--                                         members, formation; the latest holds
--   institution.work_team                 one team of an assignment; never
--                                         deleted
--   institution.work_team_member_event    who joined or left which team, by
--                                         whom (the student or a teacher); the
--                                         latest event of a student on an
--                                         assignment says whether and where
--                                         they are a member
--
-- Every table is append-only (no UPDATE, DELETE or TRUNCATE, for the owner
-- too), has forced RLS and no privilege for ductus_app: only the RPCs below
-- read and write. Who (C-23, from the relation, never from a role alone; the
-- relation is institution.work_relation of a course assignment):
--   student   sees and changes only their own team and the names of its
--             members; of another team an open one shows an id and a count
--             (student choice only), never a name
--   teacher   the teachers of the course of the assignment (owner, assistant,
--             group teacher by the existing course membership) read the teams
--             and set, create, add and remove; another course, another
--             institution, a mentorship assignment, an unknown or a malformed
--             id is the same refusal
-- Errors carry no input: ZD401 no session, ZD404 not there or no part in it,
-- ZD409 wrong state, ZD422 invalid input.
--
-- A student is in at most one team of an assignment (the latest event). A
-- member leaves, or is removed, only until their own part is submitted (a
-- withdrawn submission is not a submission). The team is not deleted when the
-- last member leaves; it stays and the teacher may fill it again. minSize is a
-- setting for the screens (a team below it is allowed, the teacher decides);
-- only maxSize is enforced. All changes to one assignment's teams run under one
-- advisory lock.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;

-- The state of the own part of each student: a fact read from the evidence
-- (a live submission, an opened work, neither). Owned by the evidence role
-- because the identity role reads no evidence table; callable only by the
-- identity role, from the RPCs below after the relation is checked. It takes no
-- institution (an assignment belongs to one; U1): the assignment and the student
-- ids are enough.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION app.work_team_part_states(p_assignment_id uuid, p_student_ids uuid[])
RETURNS TABLE (student_id uuid, work_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT u.id,
         CASE
           WHEN EXISTS (SELECT 1 FROM evidence.submission s
                         WHERE s.assignment_id = p_assignment_id AND s.principal_id = u.id
                           AND NOT evidence.submission_withdrawn(s.id)) THEN 'submitted'
           WHEN EXISTS (SELECT 1 FROM evidence.project p
                         WHERE p.assignment_id = p_assignment_id AND p.principal_id = u.id) THEN 'in_progress'
           ELSE 'not_started'
         END
    FROM pg_catalog.unnest(p_student_ids) AS u (id)
$$;
REVOKE ALL ON FUNCTION app.work_team_part_states(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_team_part_states(uuid, uuid[]) TO ductus_identity;

SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.assignment_team_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the versions; the latest for an assignment holds.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  enabled boolean NOT NULL,
  min_size integer NOT NULL CHECK (min_size BETWEEN 2 AND 6),
  max_size integer NOT NULL CHECK (max_size BETWEEN 2 AND 6),
  formation text NOT NULL CHECK (formation IN ('student_choice', 'teacher_assigned')),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (min_size <= max_size),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (set_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assignment_team_setting_assignment_idx
  ON institution.assignment_team_setting (assignment_id, institution_id, seq);
CREATE INDEX assignment_team_setting_author_idx ON institution.assignment_team_setting (set_by, institution_id);

CREATE TABLE institution.work_team (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, assignment_id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_team_assignment_idx ON institution.work_team (assignment_id, institution_id);
CREATE INDEX work_team_author_idx ON institution.work_team (created_by, institution_id);

CREATE TABLE institution.work_team_member_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  team_id uuid NOT NULL,
  student_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('join', 'leave')),
  actor_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('student', 'teacher')),
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- Whoever acts as a student acts on themselves.
  CHECK (actor_role <> 'student' OR actor_id = student_id),
  FOREIGN KEY (team_id, assignment_id, institution_id)
    REFERENCES institution.work_team (id, assignment_id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_team_member_event_student_idx
  ON institution.work_team_member_event (assignment_id, student_id, seq);
CREATE INDEX work_team_member_event_team_idx
  ON institution.work_team_member_event (team_id, assignment_id, institution_id);
CREATE INDEX work_team_member_event_student_user_idx
  ON institution.work_team_member_event (student_id, institution_id);
CREATE INDEX work_team_member_event_actor_idx ON institution.work_team_member_event (actor_id, institution_id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
CREATE FUNCTION institution.reject_work_team_record_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assignment_team_setting', 'work_team', 'work_team_member_event'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_work_team_record_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_work_team_record_change()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- The setting in force: the latest version, or teams off (minSize 2, maxSize 6,
-- student choice) when there is none.
CREATE FUNCTION institution.work_team_setting_of(p_assignment_id uuid,
                                                 OUT o_enabled boolean, OUT o_min_size integer,
                                                 OUT o_max_size integer, OUT o_formation text)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.enabled FROM institution.assignment_team_setting s
                    WHERE s.assignment_id = p_assignment_id
                    ORDER BY s.seq DESC LIMIT 1), false),
         coalesce((SELECT s.min_size FROM institution.assignment_team_setting s
                    WHERE s.assignment_id = p_assignment_id
                    ORDER BY s.seq DESC LIMIT 1), 2),
         coalesce((SELECT s.max_size FROM institution.assignment_team_setting s
                    WHERE s.assignment_id = p_assignment_id
                    ORDER BY s.seq DESC LIMIT 1), 6),
         coalesce((SELECT s.formation FROM institution.assignment_team_setting s
                    WHERE s.assignment_id = p_assignment_id
                    ORDER BY s.seq DESC LIMIT 1), 'student_choice')
$$;

-- Who is in which team now: the latest event of each student of the assignment,
-- when it is a join.
CREATE FUNCTION institution.work_team_members_now(p_assignment_id uuid)
RETURNS TABLE (team_id uuid, student_id uuid)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT l.team_id, l.student_id
    FROM (SELECT DISTINCT ON (e.student_id) e.team_id, e.student_id, e.action
            FROM institution.work_team_member_event e
           WHERE e.assignment_id = p_assignment_id
           ORDER BY e.student_id, e.seq DESC) l
   WHERE l.action = 'join'
$$;

-- The caller's part in the teams of one assignment: p_part 'student' or
-- 'teacher'. The assignment must be one of a course (a mentorship assignment has
-- no teams). ZD401 without a session; ZD404 for anything else, an unknown id
-- included (C-23).
CREATE FUNCTION institution.work_team_context(
  p_assignment_id uuid, p_part text,
  OUT o_user_id uuid, OUT o_institution_id uuid,
  OUT o_enabled boolean, OUT o_min_size integer, OUT o_max_size integer, OUT o_formation text
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.assignment a
        WHERE a.id = p_assignment_id AND a.institution_id = o_institution_id AND a.course_id IS NOT NULL)
     OR institution.work_relation(o_user_id, p_assignment_id) IS DISTINCT FROM p_part THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT s.o_enabled, s.o_min_size, s.o_max_size, s.o_formation
    INTO o_enabled, o_min_size, o_max_size, o_formation
    FROM institution.work_team_setting_of(p_assignment_id) s;
END
$$;

-- One writer of the teams of an assignment at a time.
CREATE FUNCTION institution.work_team_lock(p_assignment_id uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('work_team:' || p_assignment_id, 0))
$$;

-- Has the student's own part been submitted (and not withdrawn)?
CREATE FUNCTION institution.work_team_part_submitted(p_assignment_id uuid, p_student_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce((SELECT st.work_state = 'submitted'
                     FROM app.work_team_part_states(p_assignment_id, ARRAY[p_student_id]) st), false)
$$;

-- The teacher sets the setting; each call adds a version.
CREATE FUNCTION app.set_assignment_team_setting(p_assignment_id uuid, p_enabled boolean, p_min_size integer,
                                                p_max_size integer, p_formation text)
RETURNS TABLE (enabled boolean, min_size integer, max_size integer, formation text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  IF p_enabled IS NULL OR p_min_size IS NULL OR p_max_size IS NULL OR p_formation IS NULL
     OR p_min_size NOT BETWEEN 2 AND 6 OR p_max_size NOT BETWEEN 2 AND 6 OR p_min_size > p_max_size
     OR p_formation NOT IN ('student_choice', 'teacher_assigned') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.work_team_lock(p_assignment_id);
  -- A setting that would leave a team above the most members is refused.
  IF EXISTS (SELECT 1 FROM institution.work_team_members_now(p_assignment_id) m
              GROUP BY m.team_id HAVING count(*) > p_max_size) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.assignment_team_setting
    (institution_id, assignment_id, enabled, min_size, max_size, formation, set_by)
  VALUES (v_ctx.o_institution_id, p_assignment_id, p_enabled, p_min_size, p_max_size, p_formation, v_ctx.o_user_id);
  RETURN QUERY SELECT p_enabled, p_min_size, p_max_size, p_formation;
END
$$;

-- The setting in force, for the teachers of the course.
CREATE FUNCTION app.assignment_team_setting(p_assignment_id uuid)
RETURNS TABLE (enabled boolean, min_size integer, max_size integer, formation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  RETURN QUERY SELECT v_ctx.o_enabled, v_ctx.o_min_size, v_ctx.o_max_size, v_ctx.o_formation;
END
$$;

-- The student creates a team (becoming its first member), joins an open team
-- or leaves the own. Returns the team the student is in afterwards (null after
-- leaving).
CREATE FUNCTION app.team_action(p_assignment_id uuid, p_action text, p_team_id uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_current uuid;
  v_team uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'student');
  IF p_action IS NULL OR p_action NOT IN ('create', 'join', 'leave')
     OR (p_action = 'join') <> (p_team_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.work_team_lock(p_assignment_id);
  -- The setting may have changed while waiting for the lock.
  SELECT s.o_enabled, s.o_min_size, s.o_max_size, s.o_formation
    INTO v_ctx.o_enabled, v_ctx.o_min_size, v_ctx.o_max_size, v_ctx.o_formation
    FROM institution.work_team_setting_of(p_assignment_id) s;
  SELECT m.team_id INTO v_current
    FROM institution.work_team_members_now(p_assignment_id) m
   WHERE m.student_id = v_ctx.o_user_id;
  IF p_action = 'leave' THEN
    IF v_current IS NULL
       OR institution.work_team_part_submitted(p_assignment_id, v_ctx.o_user_id) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    INSERT INTO institution.work_team_member_event
      (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
    VALUES (v_ctx.o_institution_id, p_assignment_id, v_current, v_ctx.o_user_id, 'leave', v_ctx.o_user_id, 'student');
    RETURN NULL;
  END IF;
  IF p_action = 'join' THEN
    -- Another's, unknown and still empty team: the same refusal as no team.
    IF NOT EXISTS (SELECT 1 FROM institution.work_team t
                    JOIN institution.work_team_members_now(p_assignment_id) m
                      ON m.team_id = t.id
                   WHERE t.id = p_team_id AND t.assignment_id = p_assignment_id
                     AND t.institution_id = v_ctx.o_institution_id) THEN
      RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
    END IF;
  END IF;
  IF NOT v_ctx.o_enabled OR v_ctx.o_formation <> 'student_choice' OR v_current IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF p_action = 'join' THEN
    IF (SELECT count(*) FROM institution.work_team_members_now(p_assignment_id) m
         WHERE m.team_id = p_team_id) >= v_ctx.o_max_size THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    v_team := p_team_id;
  ELSE
    INSERT INTO institution.work_team (institution_id, assignment_id, created_by)
    VALUES (v_ctx.o_institution_id, p_assignment_id, v_ctx.o_user_id)
    RETURNING id INTO v_team;
  END IF;
  INSERT INTO institution.work_team_member_event
    (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
  VALUES (v_ctx.o_institution_id, p_assignment_id, v_team, v_ctx.o_user_id, 'join', v_ctx.o_user_id, 'student');
  RETURN v_team;
END
$$;

-- The student's team state as rows: one 'disabled' row; or a 'none' row followed
-- by 'open' rows (student choice only: a team with a member and a free place,
-- with its count and no name); or 'member' rows, one per member of the own team
-- in the order of family name, given name, id. The formation is on every row.
CREATE FUNCTION app.student_team(p_assignment_id uuid)
RETURNS TABLE (row_kind text, formation text, team_id uuid, member_count integer, given_name text, family_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_current uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'student');
  IF NOT v_ctx.o_enabled THEN
    RETURN QUERY SELECT 'disabled'::text, v_ctx.o_formation, NULL::uuid, NULL::integer, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT m.team_id INTO v_current
    FROM institution.work_team_members_now(p_assignment_id) m
   WHERE m.student_id = v_ctx.o_user_id;
  IF v_current IS NULL THEN
    RETURN QUERY SELECT 'none'::text, v_ctx.o_formation, NULL::uuid, NULL::integer, NULL::text, NULL::text;
    IF v_ctx.o_formation = 'student_choice' THEN
      RETURN QUERY
        SELECT 'open'::text, v_ctx.o_formation, c.team_id, c.n::integer, NULL::text, NULL::text
          FROM (SELECT m.team_id, count(*) AS n
                  FROM institution.work_team_members_now(p_assignment_id) m
                 GROUP BY m.team_id) c
         WHERE c.n < v_ctx.o_max_size
         ORDER BY c.team_id;
    END IF;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT 'member'::text, v_ctx.o_formation, v_current, NULL::integer, n.given_name, n.family_name
      FROM institution.work_team_members_now(p_assignment_id) m
      LEFT JOIN identity.person_name n ON n.user_id = m.student_id AND n.institution_id = v_ctx.o_institution_id
     WHERE m.team_id = v_current
     ORDER BY n.family_name, n.given_name, m.student_id;
END
$$;

-- The teams of the assignment and the enrolled students without a team, for
-- the teachers of the course, as rows of facts. A row with a team_id and no
-- student_id is an empty team; a row without a team_id is a student without a
-- team. Members and unassigned students in the order of family name, given
-- name, id; teams by the first member in that order (empty ones last), then id;
-- the unassigned last. work_state is not_started, in_progress or submitted.
CREATE FUNCTION app.teacher_teams(p_assignment_id uuid)
RETURNS TABLE (team_id uuid, student_id uuid, given_name text, family_name text, work_state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_course uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  SELECT a.course_id INTO v_course FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_ctx.o_institution_id;
  RETURN QUERY
    WITH now_in AS (
      SELECT m.team_id, m.student_id FROM institution.work_team_members_now(p_assignment_id) m
    ),
    people AS (
      SELECT t.id AS team_id, m.student_id
        FROM institution.work_team t
        LEFT JOIN now_in m ON m.team_id = t.id
       WHERE t.assignment_id = p_assignment_id AND t.institution_id = v_ctx.o_institution_id
      UNION ALL
      SELECT NULL::uuid, cm.user_id
        FROM institution.course_member cm
       WHERE cm.course_id = v_course AND cm.institution_id = v_ctx.o_institution_id
         AND cm.role = 'student' AND cm.member_to IS NULL
         AND NOT EXISTS (SELECT 1 FROM now_in m WHERE m.student_id = cm.user_id)
    ),
    named AS (
      SELECT p.team_id, p.student_id, n.given_name, n.family_name
        FROM people p
        LEFT JOIN identity.person_name n ON n.user_id = p.student_id AND n.institution_id = v_ctx.o_institution_id
    ),
    states AS (
      SELECT s.student_id, s.work_state
        FROM app.work_team_part_states(p_assignment_id,
               (SELECT coalesce(array_agg(DISTINCT x.student_id), ARRAY[]::uuid[]) FROM named x
                 WHERE x.student_id IS NOT NULL)) s
    ),
    first_member AS (
      SELECT d.team_id, row_number() OVER (ORDER BY d.family_name NULLS LAST, d.given_name NULLS LAST,
                                                    d.student_id NULLS LAST, d.team_id) AS team_rank
        FROM (SELECT DISTINCT ON (x.team_id) x.team_id, x.family_name, x.given_name, x.student_id
                FROM named x WHERE x.team_id IS NOT NULL
               ORDER BY x.team_id, x.family_name, x.given_name, x.student_id) d
    )
    SELECT x.team_id, x.student_id, x.given_name, x.family_name, st.work_state
      FROM named x
      LEFT JOIN states st ON st.student_id = x.student_id
      LEFT JOIN first_member f ON f.team_id = x.team_id
     ORDER BY (x.team_id IS NULL), f.team_rank, x.family_name, x.given_name, x.student_id;
END
$$;

-- The teacher creates an empty team.
CREATE FUNCTION app.teacher_create_team(p_assignment_id uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  PERFORM institution.work_team_lock(p_assignment_id);
  SELECT s.o_enabled INTO v_ctx.o_enabled FROM institution.work_team_setting_of(p_assignment_id) s;
  IF NOT v_ctx.o_enabled THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_team (institution_id, assignment_id, created_by)
  VALUES (v_ctx.o_institution_id, p_assignment_id, v_ctx.o_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The teacher adds an enrolled student to a team or removes one from it.
CREATE FUNCTION app.teacher_team_member(p_assignment_id uuid, p_team_id uuid, p_student_id uuid, p_action text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_current uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  IF p_team_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.work_team t
        WHERE t.id = p_team_id AND t.assignment_id = p_assignment_id AND t.institution_id = v_ctx.o_institution_id)
     OR p_student_id IS NULL
     OR institution.work_relation(p_student_id, p_assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.work_team_lock(p_assignment_id);
  SELECT s.o_enabled, s.o_max_size INTO v_ctx.o_enabled, v_ctx.o_max_size
    FROM institution.work_team_setting_of(p_assignment_id) s;
  SELECT m.team_id INTO v_current
    FROM institution.work_team_members_now(p_assignment_id) m
   WHERE m.student_id = p_student_id;
  -- Teams off: neither an addition nor a removal (work-team-v1.md).
  IF NOT v_ctx.o_enabled THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF p_action = 'remove' THEN
    IF v_current IS DISTINCT FROM p_team_id THEN
      RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
    END IF;
    IF institution.work_team_part_submitted(p_assignment_id, p_student_id) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    INSERT INTO institution.work_team_member_event
      (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
    VALUES (v_ctx.o_institution_id, p_assignment_id, p_team_id, p_student_id, 'leave', v_ctx.o_user_id, 'teacher');
    RETURN;
  END IF;
  IF v_current IS NOT NULL
     OR (SELECT count(*) FROM institution.work_team_members_now(p_assignment_id) m
          WHERE m.team_id = p_team_id) >= v_ctx.o_max_size THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_team_member_event
    (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
  VALUES (v_ctx.o_institution_id, p_assignment_id, p_team_id, p_student_id, 'join', v_ctx.o_user_id, 'teacher');
END
$$;

REVOKE ALL ON FUNCTION institution.reject_work_team_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_team_setting_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_team_members_now(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_team_context(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_team_lock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_team_part_submitted(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_assignment_team_setting(uuid, boolean, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assignment_team_setting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.team_action(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_team(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_teams(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_create_team(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_team_member(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_assignment_team_setting(uuid, boolean, integer, integer, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.assignment_team_setting(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.team_action(uuid, text, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.student_team(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.teacher_teams(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.teacher_create_team(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.teacher_team_member(uuid, uuid, uuid, text) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_team_member(uuid, uuid, uuid, text);
DROP FUNCTION app.teacher_create_team(uuid);
DROP FUNCTION app.teacher_teams(uuid);
DROP FUNCTION app.student_team(uuid);
DROP FUNCTION app.team_action(uuid, text, uuid);
DROP FUNCTION app.assignment_team_setting(uuid);
DROP FUNCTION app.set_assignment_team_setting(uuid, boolean, integer, integer, text);
DROP FUNCTION institution.work_team_part_submitted(uuid, uuid);
DROP FUNCTION institution.work_team_lock(uuid);
DROP FUNCTION institution.work_team_context(uuid, text);
DROP FUNCTION institution.work_team_members_now(uuid);
DROP FUNCTION institution.work_team_setting_of(uuid);
DROP TABLE institution.work_team_member_event;
DROP TABLE institution.work_team;
DROP TABLE institution.assignment_team_setting;
DROP FUNCTION institution.reject_work_team_record_change();
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.work_team_part_states(uuid, uuid[]);
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
