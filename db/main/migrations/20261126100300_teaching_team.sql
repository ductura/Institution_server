-- migrate:up
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The holder remains in course_holder. An assistant has no course_member
-- teacher row from this feature: only open seminar places can grant access.
CREATE TABLE institution.course_assistant (
  course_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (course_id, user_id),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
ALTER TABLE institution.course_assistant ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.course_assistant FORCE ROW LEVEL SECURITY;
CREATE POLICY course_assistant_owner ON institution.course_assistant TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.course_assistant FROM PUBLIC;

-- Existing group teachers are still supported. For a managed assistant,
-- a revocation takes precedence over even a group place written by the
-- earlier management RPC. All existing work readers share this decision.
CREATE OR REPLACE FUNCTION institution.actor_group_student(p_course_id uuid, p_student_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.current_actor() a
      JOIN institution.institution_role r ON r.user_id = a.user_id AND r.institution_id = a.institution_id
       AND r.role = 'teacher' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
      JOIN institution.seminar_group_teacher t ON t.user_id = a.user_id AND t.institution_id = a.institution_id
       AND t.course_id = p_course_id AND t.valid_to IS NULL
      JOIN institution.seminar_group_member g ON g.group_id = t.group_id AND g.institution_id = t.institution_id
       AND g.user_id = p_student_id AND g.valid_to IS NULL
      JOIN institution.course_member m ON m.course_id = p_course_id AND m.institution_id = a.institution_id
       AND m.user_id = p_student_id AND m.role = 'student' AND m.member_to IS NULL
     WHERE p_student_id IS DISTINCT FROM a.user_id
       AND NOT EXISTS (
         SELECT 1 FROM institution.course_assistant x
          WHERE x.course_id = t.course_id AND x.institution_id = t.institution_id
            AND x.user_id = a.user_id AND x.revoked_at IS NOT NULL
       )
  )
$$;

CREATE FUNCTION institution.read_teaching_team(p_course_id uuid)
RETURNS TABLE (holder_id uuid, assistant_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT h.user_id INTO holder_id FROM institution.course_holder h
   WHERE h.course_id = p_course_id AND h.institution_id = actor.institution_id AND h.valid_to IS NULL;
  SELECT ARRAY(
    SELECT x.user_id FROM institution.course_assistant x
     WHERE x.course_id = p_course_id AND x.institution_id = actor.institution_id
       AND x.revoked_at IS NULL AND x.user_id IS DISTINCT FROM holder_id
       AND institution.is_confirmed_teacher(x.user_id, p_course_id)
     ORDER BY x.user_id
  ) INTO assistant_ids;

  IF (actor.user_id IS DISTINCT FROM holder_id OR institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher')
     AND NOT (actor.user_id = ANY (assistant_ids)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEXT;
END
$$;

CREATE FUNCTION institution.lock_teaching_team(p_course_id uuid, OUT user_id uuid, OUT institution_id uuid)
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
BEGIN
  SELECT a.user_id, a.institution_id INTO user_id, institution_id FROM institution.require_course_teacher(p_course_id) a;
  -- The course row serializes with holder handover. Recheck the holder after
  -- the wait, and share-lock the confirmed role against concurrent revocation.
  PERFORM 1 FROM institution.course c WHERE c.id = p_course_id FOR NO KEY UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM institution.course_holder h WHERE h.course_id = p_course_id
      AND h.institution_id = lock_teaching_team.institution_id
      AND h.user_id = lock_teaching_team.user_id AND h.valid_to IS NULL
  ) OR institution.lock_teacher_role(user_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.seminar_group:' || p_course_id, 0));
END
$$;

CREATE FUNCTION institution.check_teaching_member_ids(p_ids uuid[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) > 500 OR array_ndims(p_ids) > 1
     OR cardinality(p_ids) <> (SELECT count(DISTINCT u.id) FROM unnest(p_ids) u(id)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
END
$$;

CREATE FUNCTION institution.replace_course_assistants(p_course_id uuid, p_assistant_ids uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_id uuid;
BEGIN
  SELECT * INTO actor FROM institution.lock_teaching_team(p_course_id);
  PERFORM institution.check_teaching_member_ids(p_assistant_ids);
  FOR v_id IN SELECT u.id FROM unnest(p_assistant_ids) u(id) ORDER BY u.id LOOP
    IF institution.lock_teacher_role(v_id) IS NULL OR EXISTS (
      SELECT 1 FROM institution.course_member m WHERE m.course_id = p_course_id
        AND m.institution_id = actor.institution_id AND m.user_id = v_id
        AND m.role = 'teacher' AND m.member_to IS NULL
    ) THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
  END LOOP;

  UPDATE institution.course_assistant x SET revoked_at = now()
   WHERE x.course_id = p_course_id AND x.revoked_at IS NULL AND NOT (x.user_id = ANY (p_assistant_ids));
  -- Also discard old-path places written while an assistant was revoked
  -- before reactivation. The holder must explicitly grant a new place.
  UPDATE institution.seminar_group_teacher t SET valid_to = greatest(now(), t.valid_from)
    FROM institution.course_assistant x
   WHERE x.course_id = p_course_id AND x.revoked_at IS NOT NULL
     AND t.course_id = x.course_id AND t.institution_id = x.institution_id AND t.user_id = x.user_id
     AND t.valid_to IS NULL;
  INSERT INTO institution.course_assistant AS x (course_id, institution_id, user_id)
  SELECT p_course_id, actor.institution_id, u.id FROM unnest(p_assistant_ids) u(id)
  ON CONFLICT (course_id, user_id) DO UPDATE SET revoked_at = NULL WHERE x.revoked_at IS NOT NULL;
END
$$;

CREATE FUNCTION institution.replace_teaching_group_members(
  p_course_id uuid, p_group_id uuid, p_assistant_ids uuid[], p_student_ids uuid[]
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_id uuid;
BEGIN
  SELECT * INTO actor FROM institution.lock_teaching_team(p_course_id);
  PERFORM 1 FROM institution.seminar_group g WHERE g.id = p_group_id
    AND g.course_id = p_course_id AND g.institution_id = actor.institution_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM institution.check_teaching_member_ids(p_assistant_ids);
  PERFORM institution.check_teaching_member_ids(p_student_ids);
  FOR v_id IN SELECT u.id FROM unnest(p_assistant_ids) u(id) ORDER BY u.id LOOP
    IF NOT EXISTS (
      SELECT 1 FROM institution.course_assistant x WHERE x.course_id = p_course_id
        AND x.user_id = v_id AND x.revoked_at IS NULL
    ) OR institution.lock_teacher_role(v_id) IS NULL THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
  END LOOP;

  UPDATE institution.seminar_group_teacher t SET valid_to = greatest(now(), t.valid_from)
   WHERE t.group_id = p_group_id AND t.valid_to IS NULL AND NOT (t.user_id = ANY (p_assistant_ids));
  UPDATE institution.seminar_group_member s SET valid_to = greatest(now(), s.valid_from)
   WHERE s.group_id = p_group_id AND s.valid_to IS NULL AND NOT (s.user_id = ANY (p_student_ids));
  -- Reuse the rules for active enrollment, one group per student, and the
  -- time boundary protecting works started before a place began.
  FOR v_id IN SELECT u.id FROM unnest(p_student_ids) u(id) ORDER BY u.id LOOP
    PERFORM institution.assign_group_student(p_group_id, v_id);
  END LOOP;
  FOR v_id IN SELECT u.id FROM unnest(p_assistant_ids) u(id) ORDER BY u.id LOOP
    PERFORM institution.assign_group_teacher(p_group_id, v_id);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION
  institution.lock_teaching_team(uuid),
  institution.check_teaching_member_ids(uuid[]),
  institution.read_teaching_team(uuid),
  institution.replace_course_assistants(uuid, uuid[]),
  institution.replace_teaching_group_members(uuid, uuid, uuid[], uuid[])
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  institution.read_teaching_team(uuid),
  institution.replace_course_assistants(uuid, uuid[]),
  institution.replace_teaching_group_members(uuid, uuid, uuid[], uuid[])
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only. Ended group places stay ended on rollback.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION institution.actor_group_student(p_course_id uuid, p_student_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.current_actor() a
      JOIN institution.institution_role r ON r.user_id = a.user_id AND r.institution_id = a.institution_id
       AND r.role = 'teacher' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
      JOIN institution.seminar_group_teacher t ON t.user_id = a.user_id AND t.institution_id = a.institution_id
       AND t.course_id = p_course_id AND t.valid_to IS NULL
      JOIN institution.seminar_group_member g ON g.group_id = t.group_id AND g.institution_id = t.institution_id
       AND g.user_id = p_student_id AND g.valid_to IS NULL
      JOIN institution.course_member m ON m.course_id = p_course_id AND m.institution_id = a.institution_id
       AND m.user_id = p_student_id AND m.role = 'student' AND m.member_to IS NULL
     WHERE p_student_id IS DISTINCT FROM a.user_id
  )
$$;

DROP FUNCTION institution.replace_teaching_group_members(uuid, uuid, uuid[], uuid[]);
DROP FUNCTION institution.replace_course_assistants(uuid, uuid[]);
DROP FUNCTION institution.check_teaching_member_ids(uuid[]);
DROP FUNCTION institution.lock_teaching_team(uuid);
DROP FUNCTION institution.read_teaching_team(uuid);
DROP TABLE institution.course_assistant;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
