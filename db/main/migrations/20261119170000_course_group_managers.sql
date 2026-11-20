-- migrate:up
-- SRV-15 (Ductus#2028, c.7008147932; owner decision "A opcija" of 19 Nov 2026
-- on the question c.7016215710): who manages the seminar groups of a course,
-- and the read of them.
--
--   create_seminar_group   a teacher of the course (the holder among them), an
--                          administrator of the course's institution, or a
--                          collaborator of the course team (C-7: an open,
--                          confirmed teacher of one of its groups who is not a
--                          student of it, institution.is_course_team_member)
--   assign_group_teacher   a teacher of the course or an administrator of the
--   end_group_assignment   course's institution; a collaborator stays ZD403
--
-- Anyone else, an administrator of another institution included, is ZD403,
-- the same as for a course or a group that does not exist; ZD401 without a
-- session. set_course_holder and assign_group_student keep
-- require_course_teacher. The bodies are those of 20261102160000 and
-- 20261104100000; only the guard changes, and assign_group_teacher now answers
-- whether it opened a place: an administrator does not read the group tables
-- (their policies are unchanged), so only the function can tell.
--
-- institution.course_groups(p_course_id) reads the groups of the course for
-- the same three (a teacher, a collaborator, an administrator of the course's
-- institution): each group with its open teachers who still hold a confirmed
-- teacher role, their names from identity.person_name (NULL while there is
-- none), and the number of its open places of open students of the course; no
-- student is named. Everyone else is ZD403.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Why the actor of the session may manage or read the groups of the course:
-- 'teacher', 'admin' or 'collaborator', in that order, or NULL. The
-- administrator holds the role in the course's own institution, which is the
-- session's. Called only from definer functions of ductus_identity.
CREATE FUNCTION institution.actor_group_access(p_course_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN institution.actor_course_role(p_course_id) = 'teacher' THEN 'teacher'
    WHEN EXISTS (
      SELECT 1 FROM institution.course c
        JOIN institution.institution_role r ON r.institution_id = c.institution_id
       WHERE c.id = p_course_id AND c.institution_id = a.institution_id
         AND r.user_id = a.user_id AND r.role = 'admin'
         AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
    ) THEN 'admin'
    WHEN institution.is_course_team_member(a.user_id, p_course_id) THEN 'collaborator'
  END
  FROM app.current_actor() a
$$;

-- The caller, who must manage the groups of the course (a collaborator only
-- when p_collaborator): ZD403 otherwise. An administrator's role row is held
-- FOR SHARE until the end, as in hand_over_course (20261111233000), so a
-- revocation waits for this transaction or leaves no row to find.
CREATE FUNCTION institution.require_group_manager(
  p_course_id uuid, p_collaborator boolean, OUT user_id uuid, OUT institution_id uuid
)
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_access text;
BEGIN
  SELECT a.user_id, a.institution_id INTO user_id, institution_id FROM institution.require_actor() a;
  v_access := institution.actor_group_access(p_course_id);
  IF v_access = 'admin' THEN
    PERFORM 1 FROM institution.institution_role r
     WHERE r.institution_id = require_group_manager.institution_id
       AND r.user_id = require_group_manager.user_id AND r.role = 'admin'
       AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
     FOR SHARE OF r;
    IF NOT FOUND THEN
      v_access := NULL;
    END IF;
  END IF;
  IF v_access IS NULL OR (v_access = 'collaborator' AND NOT coalesce(p_collaborator, false)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

-- As 20261102160000, with the guard of the decision.
CREATE OR REPLACE FUNCTION institution.create_seminar_group(p_course_id uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_group uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_group_manager(p_course_id, true);
  IF NOT coalesce(institution.is_plain_label(p_name), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.seminar_group (course_id, institution_id, name, created_by)
  VALUES (p_course_id, actor.institution_id, p_name, actor.user_id)
  ON CONFLICT (course_id, name) DO NOTHING
  RETURNING id INTO v_group;
  IF v_group IS NULL THEN
    SELECT g.id INTO STRICT v_group FROM institution.seminar_group g WHERE g.course_id = p_course_id AND g.name = p_name;
  END IF;
  RETURN v_group;
END
$$;

-- As 20261104100000, with the guard of the decision, answering whether a new
-- place was opened (false when the teacher already teaches the group). The
-- return type changes, so the function is dropped and made again, with its
-- grant.
DROP FUNCTION institution.assign_group_teacher(uuid, uuid);
CREATE FUNCTION institution.assign_group_teacher(p_group_id uuid, p_teacher_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_course uuid;
  v_students uuid[];
  v_last timestamptz;
  v_from timestamptz;
BEGIN
  SELECT g.course_id INTO v_course FROM institution.seminar_group g WHERE g.id = p_group_id;
  SELECT * INTO actor FROM institution.require_group_manager(v_course, false);
  IF NOT institution.is_confirmed_teacher(p_teacher_id, v_course) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.seminar_group:' || v_course, 0));
  PERFORM 1 FROM institution.seminar_group g WHERE g.id = p_group_id FOR NO KEY UPDATE;
  PERFORM 1
     FROM (SELECT m.id
             FROM institution.course_member m
             JOIN institution.seminar_group_member s ON s.course_id = m.course_id AND s.user_id = m.user_id
            WHERE s.group_id = p_group_id AND s.valid_to IS NULL
              AND m.course_id = v_course AND m.role = 'student' AND m.member_to IS NULL
            ORDER BY m.id
              FOR UPDATE OF m) l;
  -- The boundary covers every open place of the group, also of a student
  -- removed from the course after this transaction began: a work started
  -- before that removal stays theirs when they return (Codex, #1372).
  v_students := ARRAY(SELECT s.user_id FROM institution.seminar_group_member s
                       WHERE s.group_id = p_group_id AND s.valid_to IS NULL);
  v_last := collaboration.works_started_last(
              actor.institution_id,
              ARRAY(SELECT a.id FROM institution.assignment a
                     WHERE a.course_id = v_course AND a.institution_id = actor.institution_id),
              v_students);
  v_from := CASE WHEN v_last > now() THEN v_last + interval '1 microsecond' ELSE now() END;
  INSERT INTO institution.seminar_group_teacher (group_id, course_id, institution_id, user_id, assigned_by, valid_from)
  VALUES (p_group_id, v_course, actor.institution_id, p_teacher_id, actor.user_id, v_from)
  ON CONFLICT (group_id, user_id) WHERE valid_to IS NULL DO NOTHING;
  -- The course's group lock above makes this the answer for the committed state.
  RETURN FOUND;
END
$$;

-- As 20261104100000, with the guard of the decision.
CREATE OR REPLACE FUNCTION institution.end_group_assignment(p_group_id uuid, p_user_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_course uuid;
BEGIN
  SELECT g.course_id INTO v_course FROM institution.seminar_group g WHERE g.id = p_group_id;
  PERFORM institution.require_group_manager(v_course, false);
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.seminar_group:' || v_course, 0));
  UPDATE institution.seminar_group_teacher t SET valid_to = greatest(now(), t.valid_from)
   WHERE t.group_id = p_group_id AND t.user_id = p_user_id AND t.valid_to IS NULL;
  UPDATE institution.seminar_group_member s SET valid_to = greatest(now(), s.valid_from)
   WHERE s.group_id = p_group_id AND s.user_id = p_user_id AND s.valid_to IS NULL;
END
$$;

-- The groups of the course, see the header. One row per group, by id;
-- teachers is [{id, given_name, family_name}] by id. SECURITY DEFINER because
-- ductus_app may not read names, and an administrator or a collaborator not
-- the groups; every predicate is written out here.
CREATE FUNCTION institution.course_groups(p_course_id uuid)
RETURNS TABLE (group_id uuid, name text, teachers jsonb, students integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF institution.actor_group_access(p_course_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
  SELECT g.id, g.name,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.user_id, 'given_name', pn.given_name,
                                          'family_name', pn.family_name) ORDER BY t.user_id)
        FROM institution.seminar_group_teacher t
        LEFT JOIN identity.person_name pn ON pn.user_id = t.user_id AND pn.institution_id = t.institution_id
       WHERE t.group_id = g.id AND t.institution_id = v_institution AND t.valid_to IS NULL
         -- A group place outlives a revoked teacher role (revoke_teacher_role).
         AND institution.is_confirmed_teacher(t.user_id, g.course_id)), '[]'::jsonb),
    (SELECT count(*)::integer
       FROM institution.seminar_group_member s
       JOIN institution.course_member m ON m.course_id = s.course_id AND m.user_id = s.user_id
        AND m.institution_id = v_institution AND m.role = 'student' AND m.member_to IS NULL
      WHERE s.group_id = g.id AND s.institution_id = v_institution AND s.valid_to IS NULL)
    FROM institution.seminar_group g
   WHERE g.course_id = p_course_id AND g.institution_id = v_institution
   ORDER BY g.id;
END
$$;

REVOKE ALL ON FUNCTION
  institution.actor_group_access(uuid),
  institution.require_group_manager(uuid, boolean),
  institution.assign_group_teacher(uuid, uuid),
  institution.course_groups(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  institution.assign_group_teacher(uuid, uuid),
  institution.course_groups(uuid)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- The three functions go back to require_course_teacher and
-- assign_group_teacher to returning nothing.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.course_groups(uuid);

CREATE OR REPLACE FUNCTION institution.create_seminar_group(p_course_id uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_group uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_course_teacher(p_course_id);
  IF NOT coalesce(institution.is_plain_label(p_name), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.seminar_group (course_id, institution_id, name, created_by)
  VALUES (p_course_id, actor.institution_id, p_name, actor.user_id)
  ON CONFLICT (course_id, name) DO NOTHING
  RETURNING id INTO v_group;
  IF v_group IS NULL THEN
    SELECT g.id INTO STRICT v_group FROM institution.seminar_group g WHERE g.course_id = p_course_id AND g.name = p_name;
  END IF;
  RETURN v_group;
END
$$;

DROP FUNCTION institution.assign_group_teacher(uuid, uuid);
CREATE FUNCTION institution.assign_group_teacher(p_group_id uuid, p_teacher_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_course uuid;
  v_students uuid[];
  v_last timestamptz;
  v_from timestamptz;
BEGIN
  SELECT g.course_id INTO v_course FROM institution.seminar_group g WHERE g.id = p_group_id;
  SELECT * INTO actor FROM institution.require_course_teacher(v_course);
  IF NOT institution.is_confirmed_teacher(p_teacher_id, v_course) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.seminar_group:' || v_course, 0));
  PERFORM 1 FROM institution.seminar_group g WHERE g.id = p_group_id FOR NO KEY UPDATE;
  PERFORM 1
     FROM (SELECT m.id
             FROM institution.course_member m
             JOIN institution.seminar_group_member s ON s.course_id = m.course_id AND s.user_id = m.user_id
            WHERE s.group_id = p_group_id AND s.valid_to IS NULL
              AND m.course_id = v_course AND m.role = 'student' AND m.member_to IS NULL
            ORDER BY m.id
              FOR UPDATE OF m) l;
  v_students := ARRAY(SELECT s.user_id FROM institution.seminar_group_member s
                       WHERE s.group_id = p_group_id AND s.valid_to IS NULL);
  v_last := collaboration.works_started_last(
              actor.institution_id,
              ARRAY(SELECT a.id FROM institution.assignment a
                     WHERE a.course_id = v_course AND a.institution_id = actor.institution_id),
              v_students);
  v_from := CASE WHEN v_last > now() THEN v_last + interval '1 microsecond' ELSE now() END;
  INSERT INTO institution.seminar_group_teacher (group_id, course_id, institution_id, user_id, assigned_by, valid_from)
  VALUES (p_group_id, v_course, actor.institution_id, p_teacher_id, actor.user_id, v_from)
  ON CONFLICT (group_id, user_id) WHERE valid_to IS NULL DO NOTHING;
END
$$;
REVOKE ALL ON FUNCTION institution.assign_group_teacher(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.assign_group_teacher(uuid, uuid) TO ductus_app;

CREATE OR REPLACE FUNCTION institution.end_group_assignment(p_group_id uuid, p_user_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_course uuid;
BEGIN
  SELECT g.course_id INTO v_course FROM institution.seminar_group g WHERE g.id = p_group_id;
  PERFORM institution.require_course_teacher(v_course);
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.seminar_group:' || v_course, 0));
  UPDATE institution.seminar_group_teacher t SET valid_to = greatest(now(), t.valid_from)
   WHERE t.group_id = p_group_id AND t.user_id = p_user_id AND t.valid_to IS NULL;
  UPDATE institution.seminar_group_member s SET valid_to = greatest(now(), s.valid_from)
   WHERE s.group_id = p_group_id AND s.user_id = p_user_id AND s.valid_to IS NULL;
END
$$;

DROP FUNCTION institution.require_group_manager(uuid, boolean), institution.actor_group_access(uuid);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
