-- migrate:up
-- DEMO-POP-4-SRV (Ductus#2058): the people the holder can add as assistants.
-- Only the current holder with the teacher role in the course reads it;
-- anyone else is refused with ZD403 (also for a course that does not exist).
-- A candidate is a confirmed, unrevoked teacher of the caller's institution
-- who is not an open teacher of the course (the holder included) and not an
-- active assistant: exactly the IDs replace_course_assistants accepts beyond
-- the current roster. Only the ID and the name pair identity.person_name
-- holds for this institution, joined with a space, or an empty text. Never
-- an AAI identifier, an address, an OIB or a login time.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.read_teaching_team_candidates(p_course_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_holder uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT h.user_id INTO v_holder FROM institution.course_holder h
   WHERE h.course_id = p_course_id AND h.institution_id = actor.institution_id AND h.valid_to IS NULL;
  IF v_holder IS NULL OR actor.user_id IS DISTINCT FROM v_holder
     OR institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name, c.id)
      FROM (
        SELECT r.user_id AS id,
               coalesce(nullif(btrim(concat_ws(' ', n.given_name, n.family_name)), ''), '') AS name
          FROM institution.institution_role r
          LEFT JOIN identity.person_name n ON n.user_id = r.user_id AND n.institution_id = actor.institution_id
         WHERE r.institution_id = actor.institution_id AND r.role = 'teacher'
           AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
           AND r.user_id IS DISTINCT FROM v_holder
           AND NOT EXISTS (
             SELECT 1 FROM institution.course_member m
              WHERE m.course_id = p_course_id AND m.institution_id = actor.institution_id
                AND m.user_id = r.user_id AND m.role = 'teacher' AND m.member_to IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM institution.course_assistant x
              WHERE x.course_id = p_course_id AND x.institution_id = actor.institution_id
                AND x.user_id = r.user_id AND x.revoked_at IS NULL)
         ORDER BY name, id
         LIMIT 5000
      ) c
  ), '[]'::jsonb);
END
$$;

REVOKE ALL ON FUNCTION institution.read_teaching_team_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.read_teaching_team_candidates(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.read_teaching_team_candidates(uuid);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
