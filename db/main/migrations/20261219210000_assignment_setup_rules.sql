-- migrate:up
-- SRV-ZAD-POSTAVKE (INT-32 finding; UGOVORI-API, Daniel 19. 11. 2026.,
-- c.7023243284; N-02/N-03 zs-3): the creation of an assignment records the
-- teacher's two rules the contract names in ASSIGNMENT_SETUP:
--
--   external_tools_allowed  "vanjski alati": the student may use tools
--                           outside Ductura (A-14); absent is false
--   ai_summary_only         "samo sažimanje": the AI assistant only
--                           summarises; absent is false
--
-- Both belong to the assignment, like is_practice (20261201100000): they are
-- fixed on creation, bound by the idempotency key, and no client role may
-- change them (the app role only reads institution.assignment). Summary only
-- is refused under a prohibited policy or with any AI purpose (ZD422), as the
-- contract says. Who may create comes from relations only (C-23), unchanged.
-- Groups (zs-2, groupIds) are not stored here; they stay their own task.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- A constant default keeps every existing assignment as it was created.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN external_tools_allowed boolean NOT NULL DEFAULT false;
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN ai_summary_only boolean NOT NULL DEFAULT false;

CREATE FUNCTION institution.refuse_assignment_setup_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'assignment setup is immutable' USING ERRCODE = 'ZD409';
END
$$;
REVOKE ALL ON FUNCTION institution.refuse_assignment_setup_change() FROM PUBLIC;
CREATE TRIGGER assignment_setup_immutable
  BEFORE UPDATE OF external_tools_allowed, ai_summary_only ON institution.assignment
  FOR EACH ROW WHEN (OLD.external_tools_allowed IS DISTINCT FROM NEW.external_tools_allowed
                     OR OLD.ai_summary_only IS DISTINCT FROM NEW.ai_summary_only)
  EXECUTE FUNCTION institution.refuse_assignment_setup_change();

-- The idempotency key binds the first version, practice and both rules.
CREATE FUNCTION institution.create_assignment(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean,
  p_external_tools_allowed boolean, p_ai_summary_only boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_assignment uuid;
  existing record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_request_id IS NULL OR p_is_practice IS NULL
     OR p_external_tools_allowed IS NULL OR p_ai_summary_only IS NULL
     OR (p_ai_summary_only AND (p_ai_policy = 'prohibited' OR coalesce(cardinality(p_ai_purposes), 0) > 0))
     OR NOT institution.is_assignment_content(p_title, p_instructions, p_work_type, p_opens_at, p_due_at,
                                              p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
                                              p_purpose_catalog_version)
     OR NOT institution.is_word_range(p_word_min, p_word_max)
     OR institution.ai_policy_rank(p_ai_policy)
        > (SELECT institution.ai_policy_rank(c.ai_policy) FROM institution.course c WHERE c.id = p_course_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  INSERT INTO institution.assignment (course_id, institution_id, created_by, request_id, is_practice,
                                      external_tools_allowed, ai_summary_only)
  VALUES (p_course_id, actor.institution_id, actor.user_id, p_request_id, p_is_practice,
          p_external_tools_allowed, p_ai_summary_only)
  ON CONFLICT (created_by, request_id) WHERE request_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_assignment;

  IF v_assignment IS NOT NULL THEN
    INSERT INTO institution.assignment_version (
      assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy,
      ai_purposes, evidence_profile, import_allowed, word_min, word_max, purpose_catalog_version, created_by
    )
    VALUES (v_assignment, 1, p_title, p_instructions, p_work_type, p_opens_at, p_due_at, p_ai_policy,
            p_ai_purposes, p_evidence_profile, p_import_allowed, p_word_min, p_word_max,
            p_purpose_catalog_version, actor.user_id);
    RETURN v_assignment;
  END IF;

  -- A key belongs to one creator. Replays return the original assignment only
  -- when every field of its immutable first version, its course and its
  -- creation flags match.
  SELECT a.id, a.course_id, v.title, v.instructions, v.work_type, v.opens_at, v.due_at,
         v.ai_policy, v.ai_purposes, v.evidence_profile, v.import_allowed, v.word_min, v.word_max,
         v.purpose_catalog_version, a.is_practice, a.external_tools_allowed, a.ai_summary_only
    INTO existing
    FROM institution.assignment a
    JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = 1
   WHERE a.created_by = actor.user_id AND a.request_id = p_request_id;
  IF existing.id IS NULL
     OR existing.course_id IS DISTINCT FROM p_course_id
     OR existing.title IS DISTINCT FROM p_title
     OR existing.instructions IS DISTINCT FROM p_instructions
     OR existing.work_type IS DISTINCT FROM p_work_type
     OR existing.opens_at IS DISTINCT FROM p_opens_at
     OR existing.due_at IS DISTINCT FROM p_due_at
     OR existing.ai_policy IS DISTINCT FROM p_ai_policy
     OR existing.ai_purposes IS DISTINCT FROM p_ai_purposes
     OR existing.evidence_profile IS DISTINCT FROM p_evidence_profile
     OR existing.import_allowed IS DISTINCT FROM p_import_allowed
     OR existing.word_min IS DISTINCT FROM p_word_min
     OR existing.word_max IS DISTINCT FROM p_word_max
     OR existing.purpose_catalog_version IS DISTINCT FROM p_purpose_catalog_version
     OR existing.is_practice IS DISTINCT FROM p_is_practice
     OR existing.external_tools_allowed IS DISTINCT FROM p_external_tools_allowed
     OR existing.ai_summary_only IS DISTINCT FROM p_ai_summary_only THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN existing.id;
END
$$;

REVOKE ALL ON FUNCTION institution.create_assignment(uuid, uuid, text, text, text, timestamptz, timestamptz,
  text, text[], text, boolean, integer, integer, integer, boolean, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.create_assignment(uuid, uuid, text, text, text, timestamptz, timestamptz,
  text, text[], text, boolean, integer, integer, integer, boolean, boolean, boolean) TO ductus_app;

-- The earlier signature keeps its meaning: both rules absent, so false.
CREATE OR REPLACE FUNCTION institution.create_assignment(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN institution.create_assignment(p_course_id, p_request_id, p_title, p_instructions, p_work_type,
    p_opens_at, p_due_at, p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
    p_word_min, p_word_max, p_purpose_catalog_version, p_is_practice, false, false);
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The body of 20261201100000_assignment_practice.sql.
CREATE OR REPLACE FUNCTION institution.create_assignment(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_assignment uuid;
  existing record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_request_id IS NULL OR p_is_practice IS NULL
     OR NOT institution.is_assignment_content(p_title, p_instructions, p_work_type, p_opens_at, p_due_at,
                                              p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
                                              p_purpose_catalog_version)
     OR NOT institution.is_word_range(p_word_min, p_word_max)
     OR institution.ai_policy_rank(p_ai_policy)
        > (SELECT institution.ai_policy_rank(c.ai_policy) FROM institution.course c WHERE c.id = p_course_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  INSERT INTO institution.assignment (course_id, institution_id, created_by, request_id, is_practice)
  VALUES (p_course_id, actor.institution_id, actor.user_id, p_request_id, p_is_practice)
  ON CONFLICT (created_by, request_id) WHERE request_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_assignment;

  IF v_assignment IS NOT NULL THEN
    INSERT INTO institution.assignment_version (
      assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy,
      ai_purposes, evidence_profile, import_allowed, word_min, word_max, purpose_catalog_version, created_by
    )
    VALUES (v_assignment, 1, p_title, p_instructions, p_work_type, p_opens_at, p_due_at, p_ai_policy,
            p_ai_purposes, p_evidence_profile, p_import_allowed, p_word_min, p_word_max,
            p_purpose_catalog_version, actor.user_id);
    RETURN v_assignment;
  END IF;

  -- A key belongs to one creator. Replays return the original assignment only
  -- when every field of its immutable first version and its course match.
  SELECT a.id, a.course_id, v.title, v.instructions, v.work_type, v.opens_at, v.due_at,
         v.ai_policy, v.ai_purposes, v.evidence_profile, v.import_allowed, v.word_min, v.word_max,
         v.purpose_catalog_version, a.is_practice
    INTO existing
    FROM institution.assignment a
    JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = 1
   WHERE a.created_by = actor.user_id AND a.request_id = p_request_id;
  IF existing.id IS NULL
     OR existing.course_id IS DISTINCT FROM p_course_id
     OR existing.title IS DISTINCT FROM p_title
     OR existing.instructions IS DISTINCT FROM p_instructions
     OR existing.work_type IS DISTINCT FROM p_work_type
     OR existing.opens_at IS DISTINCT FROM p_opens_at
     OR existing.due_at IS DISTINCT FROM p_due_at
     OR existing.ai_policy IS DISTINCT FROM p_ai_policy
     OR existing.ai_purposes IS DISTINCT FROM p_ai_purposes
     OR existing.evidence_profile IS DISTINCT FROM p_evidence_profile
     OR existing.import_allowed IS DISTINCT FROM p_import_allowed
     OR existing.word_min IS DISTINCT FROM p_word_min
     OR existing.word_max IS DISTINCT FROM p_word_max
     OR existing.purpose_catalog_version IS DISTINCT FROM p_purpose_catalog_version
     OR existing.is_practice IS DISTINCT FROM p_is_practice THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN existing.id;
END
$$;

DROP FUNCTION institution.create_assignment(uuid, uuid, text, text, text, timestamptz, timestamptz,
  text, text[], text, boolean, integer, integer, integer, boolean, boolean, boolean);
DROP TRIGGER assignment_setup_immutable ON institution.assignment;
DROP FUNCTION institution.refuse_assignment_setup_change();
ALTER TABLE institution.assignment DROP COLUMN ai_summary_only;
ALTER TABLE institution.assignment DROP COLUMN external_tools_allowed;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
