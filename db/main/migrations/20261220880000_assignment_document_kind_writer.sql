-- migrate:up
-- SRV-V13-VRSTA-PISAC (Ductus#2059, orchestrator 28. 11. 2026; finding on the
-- stack for WEB#1146 / F4-V13-R04: a slides assignment was the route's 422).
-- institution.assignment.document_kind (20261219360000, 20261220120000) had
-- no writer, so the route accepted only 'text'. This gives the column its one
-- writer, the creation, and lets a new version name the kind it belongs to.
--
--   create_assignment_with_groups(<the 18 arguments of 20261220800000>,
--                   p_document_kind DEFAULT 'text')  as before, and the kind:
--                   'text', 'slides' or 'spreadsheet'; anything else (NULL
--                   included) is ZD422 before anything is written.
--                   - a new key: the assignment is created as before, then
--                     its document_kind is set to the kind in the same
--                     statement (the only UPDATE of the column, on the row
--                     this call has just inserted);
--                   - a used key: a stored kind other than the kind is ZD409,
--                     as is other content (the key binds the kind too), and
--                     nothing is written.
--   publish_assignment_version(<the 13 arguments of 20261110120000>,
--                   p_document_kind DEFAULT NULL)  as before; the kind of an
--                   assignment is fixed at its creation, so a version that
--                   names a kind other than the stored one is ZD422 (after
--                   the existing ZD403, before anything is written). NULL
--                   checks nothing, as before.
--
-- No access change. Both functions are replaced (DROP and CREATE, as a new
-- argument needs), each with exactly the grant it had: EXECUTE for
-- ductus_app, nothing for PUBLIC. Who may stays the old body's: a teacher of
-- the course creates (create_assignment), a teacher of the assignment
-- publishes. No table, column, policy or grant on a table changes; the
-- application role still only reads document_kind. The new last argument has
-- a default, so every existing call keeps its meaning. Errors carry no input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.create_assignment_with_groups(uuid, uuid, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, integer, boolean, boolean,
  boolean, uuid[]);

CREATE FUNCTION institution.create_assignment_with_groups(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean,
  p_external_tools_allowed boolean, p_ai_summary_only boolean, p_group_ids uuid[],
  p_document_kind text DEFAULT 'text'
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_used boolean;
  v_assignment uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_group_ids IS NULL OR coalesce(array_ndims(p_group_ids), 1) <> 1
     OR array_position(p_group_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u.g) FROM unnest(p_group_ids) AS u (g)) <> cardinality(p_group_ids)
     OR p_document_kind IS NULL OR p_document_kind NOT IN ('text', 'slides', 'spreadsheet') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One creation per caller and key at a time; the read below then sees a
  -- first creation that committed while this one waited.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('institution.create_assignment:' || actor.user_id::text || ':'
                                || coalesce(p_request_id::text, ''), 0));
  v_used := EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.created_by = actor.user_id AND a.request_id = p_request_id);

  v_assignment := institution.create_assignment(p_course_id, p_request_id, p_title, p_instructions,
    p_work_type, p_opens_at, p_due_at, p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
    p_word_min, p_word_max, p_purpose_catalog_version, p_is_practice,
    p_external_tools_allowed, p_ai_summary_only);

  IF v_used THEN
    IF EXISTS (SELECT 1 FROM institution.assignment a
                WHERE a.id = v_assignment AND a.document_kind IS DISTINCT FROM p_document_kind)
       OR EXISTS (SELECT l.group_id FROM institution.assignment_group l WHERE l.assignment_id = v_assignment
                  EXCEPT SELECT u.g FROM unnest(p_group_ids) AS u (g))
       OR EXISTS (SELECT u.g FROM unnest(p_group_ids) AS u (g)
                  EXCEPT SELECT l.group_id FROM institution.assignment_group l
                          WHERE l.assignment_id = v_assignment) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
  ELSE
    IF p_document_kind <> 'text' THEN
      UPDATE institution.assignment a SET document_kind = p_document_kind WHERE a.id = v_assignment;
    END IF;
    IF cardinality(p_group_ids) > 0 THEN
      PERFORM institution.add_assignment_groups(v_assignment, p_group_ids);
    END IF;
  END IF;
  RETURN v_assignment;
END
$$;

REVOKE ALL ON FUNCTION institution.create_assignment_with_groups(uuid, uuid, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, integer, boolean, boolean,
  boolean, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.create_assignment_with_groups(uuid, uuid, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, integer, boolean, boolean,
  boolean, uuid[], text) TO ductus_app;

DROP FUNCTION institution.publish_assignment_version(uuid, integer, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer);

-- The body of 20261110120000 with one check added after the ZD403.
CREATE FUNCTION institution.publish_assignment_version(
  p_assignment_id uuid, p_expected_version integer, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_document_kind text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  cur record;
  v_current integer;
  v_catalog integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'teacher'
     OR EXISTS (SELECT 1 FROM institution.assignment a WHERE a.id = p_assignment_id AND a.mentorship_id IS NOT NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The kind is the assignment's, fixed at its creation: a version cannot change it.
  IF p_document_kind IS NOT NULL AND EXISTS (
       SELECT 1 FROM institution.assignment a
        WHERE a.id = p_assignment_id AND a.document_kind IS DISTINCT FROM p_document_kind) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT v.purpose_catalog_version INTO v_catalog FROM institution.assignment_version v
   WHERE v.assignment_id = p_assignment_id AND v.version_no = 1;
  IF NOT institution.is_assignment_content(p_title, p_instructions, p_work_type, p_opens_at, p_due_at,
                                           p_ai_policy, p_ai_purposes, p_evidence_profile, p_import_allowed,
                                           v_catalog)
     OR NOT institution.is_word_range(p_word_min, p_word_max) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- Two teachers at once: the second waits here, then fails the comparison.
  SELECT a.current_version INTO v_current FROM institution.assignment a WHERE a.id = p_assignment_id FOR UPDATE;
  IF v_current IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  SELECT v.* INTO cur FROM institution.assignment_version v
   WHERE v.assignment_id = p_assignment_id AND v.version_no = v_current;
  IF institution.ai_policy_rank(p_ai_policy) > institution.ai_policy_rank(cur.ai_policy)
     OR NOT p_ai_purposes <@ cur.ai_purposes
     OR (p_evidence_profile = 'extended' AND cur.evidence_profile = 'basic')
     OR (p_import_allowed AND NOT cur.import_allowed)
     -- Rule 14: a bound may be dropped or relaxed, never added or tightened.
     OR (p_word_min IS NOT NULL AND (cur.word_min IS NULL OR p_word_min > cur.word_min))
     OR (p_word_max IS NOT NULL AND (cur.word_max IS NULL OR p_word_max < cur.word_max)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.assignment_version (
    assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy,
    ai_purposes, evidence_profile, import_allowed, word_min, word_max, purpose_catalog_version, created_by
  )
  VALUES (p_assignment_id, v_current + 1, p_title, p_instructions, p_work_type, p_opens_at, p_due_at, p_ai_policy,
          p_ai_purposes, p_evidence_profile, p_import_allowed, p_word_min, p_word_max, v_catalog, actor.user_id);
  UPDATE institution.assignment a SET current_version = v_current + 1 WHERE a.id = p_assignment_id;
  RETURN v_current + 1;
END
$$;

REVOKE ALL ON FUNCTION institution.publish_assignment_version(uuid, integer, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.publish_assignment_version(uuid, integer, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
RESET ROLE;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SELECT 1;
