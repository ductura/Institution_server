-- SRV-7E, C-12: the editor reads only its two institution settings. The
-- session selects the institution, and the administrator keeps the full view.
-- migrate:up
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA settings TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION settings.read_institution_values()
RETURNS TABLE (editor_only boolean, key text, value jsonb, bound jsonb, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_admin boolean;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  v_admin := institution.actor_has_role('admin');
  IF NOT (v_admin OR institution.actor_has_role('teacher') OR EXISTS (
    SELECT 1 FROM institution.course_member m
     WHERE m.institution_id = v_actor.institution_id AND m.user_id = v_actor.user_id
       AND m.role = 'student' AND m.member_to IS NULL
  ) OR EXISTS (
    SELECT 1 FROM institution.mentorship m
     WHERE m.institution_id = v_actor.institution_id AND m.student_id = v_actor.user_id
       AND m.ended_at IS NULL
  )) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD403';
  END IF;

  -- The left join returns the access scope even if no setting is stored.
  RETURN QUERY SELECT NOT v_admin, v.key, v.value, v.bound, v.updated_at
  FROM (SELECT 1) AS scope
  LEFT JOIN settings.value v ON v.level = 'institution' AND v.institution_id = v_actor.institution_id
    AND (v_admin OR v.key IN ('citation.style', 'lekta.profile'))
  ORDER BY v.key;
END
$$;

REVOKE ALL ON FUNCTION settings.read_institution_values() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settings.read_institution_values() TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA settings FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA settings TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION settings.read_institution_values();
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA settings FROM ductus_identity;
