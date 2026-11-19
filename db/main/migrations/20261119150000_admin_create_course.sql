-- migrate:up
-- SRV-07 (Ductus#2028, c.7008147932; owner answers A-7 and A-9 of 19 Nov 2026):
-- the administrator of an institution creates a course and names its holder.
-- In one transaction the course is created, the holder becomes its first
-- teacher and its open holder (assigned_by is the administrator). The
-- administrator does not become a member of the course.
--
-- ZD401 without a session; ZD403 for anyone who is not an administrator of
-- their institution; ZD422 for a name that is not a plain label, an AI policy
-- outside the three, an academic year that is not YYYY/YYYY+1, or a holder who
-- is not a confirmed teacher of the caller's institution (another institution's
-- teacher reads the same as nobody, C-23). The same request again returns the
-- same course; the same course with another AI policy or holder is ZD409.
-- The teacher's institution.create_course stays as it is; the route stops
-- calling it (SRV-12).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.admin_create_course(
  p_name text, p_academic_year text, p_ai_policy text, p_holder_id uuid
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_course uuid;
  v_ai_policy text;
  v_holder uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- The administrator role row FOR SHARE until the end, as hand_over_course
  -- (20261111233000): a revocation waits for this transaction, and one that
  -- committed first, even while this call waited for the row, leaves no row.
  PERFORM 1 FROM institution.institution_role r
   WHERE r.institution_id = actor.institution_id AND r.user_id = actor.user_id AND r.role = 'admin'
     AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
   FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked here, before the table constraints, whose errors quote the row.
  IF NOT coalesce(
       institution.is_plain_label(p_name)
       AND p_ai_policy IN ('prohibited', 'partially_allowed', 'encouraged')
       AND CASE WHEN p_academic_year ~ '^[0-9]{4}/[0-9]{4}$'
                THEN right(p_academic_year, 4)::integer = left(p_academic_year, 4)::integer + 1
                ELSE false END,
       false)
     -- A confirmed, unrevoked teacher of the caller's institution, held FOR
     -- SHARE so the role cannot be revoked until this commits.
     OR institution.lock_teacher_role(p_holder_id) IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  INSERT INTO institution.course (institution_id, name, academic_year, ai_policy, created_by)
  VALUES (actor.institution_id, p_name, p_academic_year, p_ai_policy, actor.user_id)
  ON CONFLICT (institution_id, created_by, academic_year, name) DO NOTHING
  RETURNING id INTO v_course;
  IF v_course IS NULL THEN
    SELECT c.id, c.ai_policy INTO v_course, v_ai_policy
      FROM institution.course c
     WHERE c.institution_id = actor.institution_id AND c.created_by = actor.user_id
       AND c.academic_year = p_academic_year AND c.name = p_name;
    SELECT h.user_id INTO v_holder FROM institution.course_holder h
     WHERE h.course_id = v_course AND h.valid_to IS NULL;
    IF v_ai_policy <> p_ai_policy OR v_holder IS DISTINCT FROM p_holder_id THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    RETURN v_course;
  END IF;
  INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
  VALUES (v_course, actor.institution_id, p_holder_id, 'teacher');
  INSERT INTO institution.course_holder (course_id, institution_id, user_id, assigned_by)
  VALUES (v_course, actor.institution_id, p_holder_id, actor.user_id);
  RETURN v_course;
END
$$;

REVOKE ALL ON FUNCTION institution.admin_create_course(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.admin_create_course(text, text, text, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.admin_create_course(text, text, text, uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
