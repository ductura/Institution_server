-- migrate:up
-- SRV-2007 (Ductus#2052): the teaching team screen in one read. The holder
-- sees the roster, every enrolled student with the current group place and
-- every group with its assistants. An assistant sees only the groups where
-- they hold an open place and the students in those groups. Anyone else is
-- refused with ZD403 (also for a course that does not exist). Names are the
-- pair identity.person_name holds for this institution, joined with a space,
-- or an empty text. Never an AAI identifier, an address or a login time.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.read_teaching_team_view(p_course_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_holder uuid;
  v_assistants uuid[];
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT h.user_id INTO v_holder FROM institution.course_holder h
   WHERE h.course_id = p_course_id AND h.institution_id = actor.institution_id AND h.valid_to IS NULL;
  SELECT ARRAY(
    SELECT x.user_id FROM institution.course_assistant x
     WHERE x.course_id = p_course_id AND x.institution_id = actor.institution_id
       AND x.revoked_at IS NULL AND x.user_id IS DISTINCT FROM v_holder
       AND institution.is_confirmed_teacher(x.user_id, p_course_id)
     ORDER BY x.user_id
  ) INTO v_assistants;

  IF actor.user_id IS NOT DISTINCT FROM v_holder
     AND institution.actor_course_role(p_course_id) IS NOT DISTINCT FROM 'teacher' THEN
    RETURN jsonb_build_object(
      'role', 'holder',
      'holderId', v_holder,
      'assistants', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.id)
          FROM (
            SELECT u.id, coalesce(nullif(btrim(concat_ws(' ', n.given_name, n.family_name)), ''), '') AS name
              FROM unnest(v_assistants) u(id)
              LEFT JOIN identity.person_name n ON n.user_id = u.id AND n.institution_id = actor.institution_id
          ) a
      ), '[]'::jsonb),
      'students', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'groupId', s.group_id) ORDER BY s.id)
          FROM (
            SELECT m.user_id AS id,
                   coalesce(nullif(btrim(concat_ws(' ', n.given_name, n.family_name)), ''), '') AS name,
                   (SELECT g.group_id FROM institution.seminar_group_member g
                     WHERE g.course_id = p_course_id AND g.institution_id = actor.institution_id
                       AND g.user_id = m.user_id AND g.valid_to IS NULL
                     ORDER BY g.valid_from DESC, g.id LIMIT 1) AS group_id
              FROM institution.course_member m
              LEFT JOIN identity.person_name n ON n.user_id = m.user_id AND n.institution_id = actor.institution_id
             WHERE m.course_id = p_course_id AND m.institution_id = actor.institution_id
               AND m.role = 'student' AND m.member_to IS NULL
          ) s
      ), '[]'::jsonb),
      'groups', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', g.id, 'name', g.name,
                 'assistantIds', ARRAY(
                   SELECT t.user_id FROM institution.seminar_group_teacher t
                    WHERE t.group_id = g.id AND t.valid_to IS NULL AND t.user_id = ANY (v_assistants)
                    ORDER BY t.user_id)
               ) ORDER BY g.name, g.id)
          FROM institution.seminar_group g
         WHERE g.course_id = p_course_id AND g.institution_id = actor.institution_id
      ), '[]'::jsonb)
    );
  ELSIF actor.user_id = ANY (v_assistants) THEN
    RETURN jsonb_build_object(
      'role', 'assistant',
      'groups', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', g.id, 'name', g.name,
                 'students', coalesce((
                   SELECT jsonb_agg(jsonb_build_object(
                            'id', m.user_id,
                            'name', coalesce(nullif(btrim(concat_ws(' ', n.given_name, n.family_name)), ''), ''))
                          ORDER BY m.user_id)
                     FROM institution.seminar_group_member sm
                     JOIN institution.course_member m ON m.course_id = p_course_id
                      AND m.institution_id = actor.institution_id AND m.user_id = sm.user_id
                      AND m.role = 'student' AND m.member_to IS NULL
                     LEFT JOIN identity.person_name n ON n.user_id = m.user_id AND n.institution_id = actor.institution_id
                    WHERE sm.group_id = g.id AND sm.valid_to IS NULL
                      AND sm.user_id IS DISTINCT FROM actor.user_id
                 ), '[]'::jsonb)
               ) ORDER BY g.name, g.id)
          FROM institution.seminar_group g
         WHERE g.course_id = p_course_id AND g.institution_id = actor.institution_id
           AND EXISTS (
             SELECT 1 FROM institution.seminar_group_teacher t
              WHERE t.group_id = g.id AND t.user_id = actor.user_id AND t.valid_to IS NULL)
      ), '[]'::jsonb)
    );
  END IF;
  RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
END
$$;

REVOKE ALL ON FUNCTION institution.read_teaching_team_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.read_teaching_team_view(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.read_teaching_team_view(uuid);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
