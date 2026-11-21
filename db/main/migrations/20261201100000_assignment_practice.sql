-- migrate:up
-- SRV-1901 (P-D1): record practice before anything can be submitted or exported.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- A constant default keeps existing and legacy-created assignments regular.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN is_practice boolean NOT NULL DEFAULT false;

CREATE FUNCTION institution.refuse_assignment_practice_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'practice status is immutable' USING ERRCODE = 'ZD409';
END
$$;
REVOKE ALL ON FUNCTION institution.refuse_assignment_practice_change() FROM PUBLIC;
CREATE TRIGGER assignment_practice_immutable BEFORE UPDATE OF is_practice ON institution.assignment
  FOR EACH ROW WHEN (OLD.is_practice IS DISTINCT FROM NEW.is_practice)
  EXECUTE FUNCTION institution.refuse_assignment_practice_change();

-- A practice assignment cannot acquire a package via the request RPC or an empty roster.
CREATE FUNCTION institution.refuse_practice_merlin_package() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM institution.assignment a WHERE a.id = NEW.assignment_id
             AND a.institution_id = NEW.institution_id AND a.is_practice) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION institution.refuse_practice_merlin_package() FROM PUBLIC;
CREATE TRIGGER merlin_package_practice BEFORE INSERT ON institution.merlin_package
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_practice_merlin_package();

-- The pilot has no grade storage. The relation and eligibility share one snapshot.
CREATE FUNCTION institution.assignment_grade_state(p_assignment_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM app.current_actor() WHERE user_id IS NOT NULL)
              THEN 'unauthorized'
         ELSE coalesce((
           SELECT CASE WHEN a.is_practice THEN 'practice' ELSE 'eligible' END
           FROM institution.assignment a
           WHERE a.id = p_assignment_id AND institution.actor_assignment_role(a.id) = 'teacher'
         ), 'not_found') END
$$;
REVOKE ALL ON FUNCTION institution.assignment_grade_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.assignment_grade_state(uuid) TO ductus_app;

-- The idempotency key binds the immutable first version and practice flag.

CREATE FUNCTION institution.create_assignment(
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

REVOKE ALL ON FUNCTION institution.create_assignment(uuid, uuid, text, text, text, timestamptz, timestamptz,
  text, text[], text, boolean, integer, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.create_assignment(uuid, uuid, text, text, text, timestamptz, timestamptz,
  text, text[], text, boolean, integer, integer, integer, boolean) TO ductus_app;

CREATE OR REPLACE FUNCTION institution.create_assignment(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN institution.create_assignment(p_course_id, p_request_id, p_title, p_instructions, p_work_type,
    p_opens_at, p_due_at, p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
    p_word_min, p_word_max, p_purpose_catalog_version, false);
END
$$;

-- Refuse before reading evidence or recording a teacher opening.

CREATE OR REPLACE FUNCTION app.read_work_export(p_document_id text, p_revision bigint DEFAULT NULL)
RETURNS TABLE (outcome text, revision bigint, kind text, body text, saved_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
  v_row record;
BEGIN
  PERFORM institution.require_actor();
  IF p_revision IS NOT NULL AND p_revision < 1 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL OR EXISTS (
    SELECT 1 FROM institution.assignment a
    WHERE a.id = v_scope.assignment_id AND a.institution_id = v_scope.institution_id AND a.is_practice
  ) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM app.work_export_rows(p_document_id, p_revision);
  IF v_row.revision IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_role = 'teacher' THEN
    PERFORM audit.record_work_opening(v_scope.institution_id, p_document_id, v_scope.assignment_id,
                                      v_scope.principal_id, 'replay');
  END IF;
  RETURN QUERY SELECT 'found'::text, v_row.revision, v_row.kind, v_row.body, v_row.saved_at;
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION app.read_work_export(p_document_id text, p_revision bigint DEFAULT NULL)
RETURNS TABLE (outcome text, revision bigint, kind text, body text, saved_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
  v_row record;
BEGIN
  PERFORM institution.require_actor();
  IF p_revision IS NOT NULL AND p_revision < 1 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM app.work_export_rows(p_document_id, p_revision);
  IF v_row.revision IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_role = 'teacher' THEN
    PERFORM audit.record_work_opening(v_scope.institution_id, p_document_id, v_scope.assignment_id,
                                      v_scope.principal_id, 'replay');
  END IF;
  RETURN QUERY SELECT 'found'::text, v_row.revision, v_row.kind, v_row.body, v_row.saved_at;
END
$$;

CREATE OR REPLACE FUNCTION institution.create_assignment(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer
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
  IF p_request_id IS NULL
     OR NOT institution.is_assignment_content(p_title, p_instructions, p_work_type, p_opens_at, p_due_at,
                                              p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
                                              p_purpose_catalog_version)
     OR NOT institution.is_word_range(p_word_min, p_word_max)
     OR institution.ai_policy_rank(p_ai_policy)
        > (SELECT institution.ai_policy_rank(c.ai_policy) FROM institution.course c WHERE c.id = p_course_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  INSERT INTO institution.assignment (course_id, institution_id, created_by, request_id)
  VALUES (p_course_id, actor.institution_id, actor.user_id, p_request_id)
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
         v.purpose_catalog_version
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
     OR existing.purpose_catalog_version IS DISTINCT FROM p_purpose_catalog_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN existing.id;
END
$$;

DROP FUNCTION institution.create_assignment(uuid, uuid, text, text, text, timestamptz, timestamptz,
  text, text[], text, boolean, integer, integer, integer, boolean);
DROP FUNCTION institution.assignment_grade_state(uuid);
DROP TRIGGER merlin_package_practice ON institution.merlin_package;
DROP FUNCTION institution.refuse_practice_merlin_package();
DROP TRIGGER assignment_practice_immutable ON institution.assignment;
DROP FUNCTION institution.refuse_assignment_practice_change();
ALTER TABLE institution.assignment DROP COLUMN is_practice;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
