-- DAN-826-3 (S-1J-g; contract on Ductus#1836, comment 6936739450): the read of
-- one settings level. ductus_app has no right on settings.value (DAN-801), so
-- the rows of a level reach the web process only through this function.
--
-- A level is the caller's exactly when settings.set_value would let the caller
-- write it (D-297, D-298): personal, every person for themselves; course, an
-- open teacher of the course or an administrator of its institution;
-- institution, its administrator; network_security, a network engineer with
-- an open appointment that has started; system, nobody yet. The rule is
-- written out here as it is in set_value, which stays as it is;
-- db/main/tests/139-settings-read.sql holds the two equal for every persona
-- of the fixture. Another's level or course, and a course that does not
-- exist, are the same ZD403 (C-23: another's is nonexistent).
--
-- ZD401 without a live session (app.current_actor() refuses a closed,
-- expired or idle one), ZD422 for a level outside the five or a course given
-- with the wrong level, ZD403 for a level that is not the caller's. The rows
-- are those of the level in the caller's scope, by key. The function only
-- reads, in one statement: no lock, and a concurrent write is seen whole or
-- not at all.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA settings TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION settings.read_values(p_level text, p_course uuid)
RETURNS TABLE (key text, value jsonb, bound jsonb, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_actor_institution uuid;
  v_allowed boolean;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_actor_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;

  IF p_level IS NULL OR p_level NOT IN ('personal', 'course', 'institution', 'system', 'network_security')
     OR (p_level = 'course') <> (p_course IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  -- The writer rule of settings.set_value, unchanged.
  v_allowed := CASE p_level
    WHEN 'personal' THEN true
    WHEN 'course' THEN institution.actor_course_role(p_course) IS NOT DISTINCT FROM 'teacher'
      OR (institution.actor_has_role('admin')
          AND EXISTS (SELECT 1 FROM institution.course c
                      WHERE c.id = p_course AND c.institution_id = v_actor_institution))
    WHEN 'institution' THEN institution.actor_has_role('admin')
    WHEN 'network_security' THEN EXISTS (
      SELECT 1 FROM identity.network_engineer_appointment n
       WHERE n.user_id = v_user AND n.institution_id = v_actor_institution AND n.revoked_at IS NULL
         AND n.appointed_at <= pg_catalog.now())
    ELSE false
  END;
  IF NOT coalesce(v_allowed, false) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD403';
  END IF;

  RETURN QUERY
  SELECT v.key, v.value, v.bound, v.updated_at
    FROM settings.value v
   WHERE v.level = p_level
     AND CASE p_level
       WHEN 'personal' THEN v.user_id = v_user AND v.institution_id = v_actor_institution
       WHEN 'course' THEN v.course_id = p_course
       WHEN 'institution' THEN v.institution_id = v_actor_institution
       ELSE v.institution_id IS NULL AND v.user_id IS NULL AND v.course_id IS NULL
     END
   ORDER BY v.key;
END
$$;

REVOKE ALL ON FUNCTION settings.read_values(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settings.read_values(text, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA settings FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA settings TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION settings.read_values(text, uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA settings FROM ductus_identity;
