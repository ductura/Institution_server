-- migrate:up
-- SRV-05 (Ductus#2028, c.7008147932; owner answer A-2 of 19 Nov 2026): the
-- answer of institution.enroll_with_code names what happened, so the student
-- sees why a code did not work. This replaces owner decision 1 of 10 Oct 2026
-- (one answer for every refused code) for the expired and cancelled code only.
--
--   too_many_attempts       the caller's attempts in the window are used up
--   invalid_code            no code of the caller's institution has this hash,
--                           the code is malformed, or the caller was removed
--                           from its course and may not return (as before,
--                           indistinguishable from a wrong code)
--   expired_code            the code of the caller's institution exists but is
--                           past valid_until or no longer active (revoked or
--                           replaced); the course is not named
--   already_enrolled        the caller is already in the course; nothing is
--                           written and no attempt is counted
--   enrolled                a new membership, and the course has an assignment
--   enrolled_no_assignment  a new membership in a course with no assignment yet
--
-- invalid_code and expired_code count as an attempt, as refused did. The code
-- is normalised as before: spaces and hyphens removed, upper case, 8 to 32
-- letters or digits, and only its hash is compared. A code of another
-- institution is invalid_code, never expired_code (C-23: another's is
-- nonexistent). Same signature, owner and grants; the body is that of
-- 20261104100000 apart from the outcome.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION institution.enroll_with_code(p_code text, OUT outcome text, OUT enrolled_course_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  settings record;
  v_code text;
  v_course uuid;
  v_valid boolean;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- The count below must see what a parallel request has just committed.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'READ COMMITTED required' USING ERRCODE = 'ZD500';
  END IF;
  SELECT s.enrollment_attempt_limit AS attempt_limit, s.enrollment_attempt_window AS attempt_window
    INTO settings
    FROM institution.institution_settings s WHERE s.institution_id = actor.institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'institution is not configured' USING ERRCODE = 'ZD503';
  END IF;

  -- One attempt of a user at a time, so parallel requests cannot pass the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.enroll_with_code:' || actor.user_id, 0));
  DELETE FROM institution.enrollment_attempt t
   WHERE t.user_id = actor.user_id AND t.attempted_at <= now() - settings.attempt_window;
  IF (SELECT count(*) FROM institution.enrollment_attempt t WHERE t.user_id = actor.user_id)
     >= settings.attempt_limit THEN
    outcome := 'too_many_attempts';
    RETURN;
  END IF;

  -- Spaces, hyphens and letter case do not matter; only the hash is compared.
  IF length(p_code) <= 64 THEN
    v_code := regexp_replace(p_code, '[\s-]', '', 'g');
  END IF;
  IF v_code ~ '^[0-9A-Za-z]{8,32}$' THEN
    v_code := upper(v_code);
    SELECT c.id, e.active AND e.valid_until > now()
      INTO v_course, v_valid
      FROM institution.course_enrollment_code e
      JOIN institution.course c ON c.id = e.course_id
     WHERE e.code_hash = sha256(convert_to(v_code, 'UTF8'))
       AND c.institution_id = actor.institution_id
       AND NOT EXISTS (
         SELECT 1 FROM institution.course_member m
          WHERE m.course_id = c.id AND m.user_id = actor.user_id
            AND m.removed_by IS NOT NULL AND m.return_allowed_at IS NULL
       );
  END IF;

  IF v_course IS NOT NULL THEN
    -- A member who enters the code again is told so, even after the code
    -- expired: the course is already theirs to read.
    IF institution.actor_course_role(v_course) IS NOT NULL THEN
      outcome := 'already_enrolled';
      enrolled_course_id := v_course;
      RETURN;
    END IF;
    IF v_valid THEN
      enrolled_course_id := v_course;
      -- A student who comes back to the course may still hold an open place in
      -- one of its seminar groups (#1372, repair round 4); held FOR SHARE
      -- before the membership is written, as in 20261104100000.
      PERFORM 1 FROM institution.seminar_group g
        JOIN institution.seminar_group_member s ON s.group_id = g.id AND s.institution_id = g.institution_id
       WHERE s.course_id = enrolled_course_id AND s.institution_id = actor.institution_id
         AND s.user_id = actor.user_id AND s.valid_to IS NULL
       ORDER BY g.id
         FOR SHARE OF g;
      INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
      VALUES (enrolled_course_id, actor.institution_id, actor.user_id, 'student')
      ON CONFLICT (course_id, user_id) WHERE member_to IS NULL DO NOTHING;
      IF institution.actor_course_role(enrolled_course_id) IS NOT NULL THEN
        outcome := CASE
          WHEN EXISTS (SELECT 1 FROM institution.assignment a WHERE a.course_id = enrolled_course_id)
            THEN 'enrolled'
          ELSE 'enrolled_no_assignment'
        END;
        RETURN;
      END IF;
      -- An open membership the actor cannot use (a teacher whose role was
      -- revoked): refused as a wrong code, as before.
      enrolled_course_id := NULL;
    ELSE
      INSERT INTO institution.enrollment_attempt (user_id) VALUES (actor.user_id);
      outcome := 'expired_code';
      RETURN;
    END IF;
  END IF;
  INSERT INTO institution.enrollment_attempt (user_id) VALUES (actor.user_id);
  outcome := 'invalid_code';
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- The body of 20261104100000, unchanged.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION institution.enroll_with_code(p_code text, OUT outcome text, OUT enrolled_course_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  settings record;
  v_code text;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- The count below must see what a parallel request has just committed.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'READ COMMITTED required' USING ERRCODE = 'ZD500';
  END IF;
  SELECT s.enrollment_attempt_limit AS attempt_limit, s.enrollment_attempt_window AS attempt_window
    INTO settings
    FROM institution.institution_settings s WHERE s.institution_id = actor.institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'institution is not configured' USING ERRCODE = 'ZD503';
  END IF;

  -- One attempt of a user at a time, so parallel requests cannot pass the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('institution.enroll_with_code:' || actor.user_id, 0));
  DELETE FROM institution.enrollment_attempt t
   WHERE t.user_id = actor.user_id AND t.attempted_at <= now() - settings.attempt_window;
  IF (SELECT count(*) FROM institution.enrollment_attempt t WHERE t.user_id = actor.user_id)
     >= settings.attempt_limit THEN
    outcome := 'too_many_attempts';
    RETURN;
  END IF;

  -- Spaces, hyphens and letter case do not matter; only the hash is compared.
  IF length(p_code) <= 64 THEN
    v_code := regexp_replace(p_code, '[\s-]', '', 'g');
  END IF;
  IF v_code ~ '^[0-9A-Za-z]{8,32}$' THEN
    SELECT c.id INTO enrolled_course_id
      FROM institution.course_enrollment_code e
      JOIN institution.course c ON c.id = e.course_id
     WHERE e.code_hash = sha256(convert_to(upper(v_code), 'UTF8'))
       AND e.active AND e.valid_until > now()
       AND c.institution_id = actor.institution_id
       AND NOT EXISTS (
         SELECT 1 FROM institution.course_member m
          WHERE m.course_id = c.id AND m.user_id = actor.user_id
            AND m.removed_by IS NOT NULL AND m.return_allowed_at IS NULL
       );
  END IF;
  IF enrolled_course_id IS NOT NULL THEN
    -- A student who comes back to the course may still hold an open place in
    -- one of its seminar groups (#1372, repair round 4). Those group rows are
    -- held FOR SHARE before the new course membership is written, so a
    -- return waits for assign_group_teacher, which holds the group row FOR NO
    -- KEY UPDATE until it commits, and no work of the returning student can
    -- start, and commit, while a new teacher of that group is being assigned.
    -- A student without an open place waits for nothing new.
    PERFORM 1 FROM institution.seminar_group g
      JOIN institution.seminar_group_member s ON s.group_id = g.id AND s.institution_id = g.institution_id
     WHERE s.course_id = enrolled_course_id AND s.institution_id = actor.institution_id
       AND s.user_id = actor.user_id AND s.valid_to IS NULL
     ORDER BY g.id
       FOR SHARE OF g;
    INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
    VALUES (enrolled_course_id, actor.institution_id, actor.user_id, 'student')
    ON CONFLICT (course_id, user_id) WHERE member_to IS NULL DO NOTHING;
    IF institution.actor_course_role(enrolled_course_id) IS NOT NULL THEN
      outcome := 'enrolled';
      RETURN;
    END IF;
  END IF;
  enrolled_course_id := NULL;
  INSERT INTO institution.enrollment_attempt (user_id) VALUES (actor.user_id);
  outcome := 'refused';
END
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
