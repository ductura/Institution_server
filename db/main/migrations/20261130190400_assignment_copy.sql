-- migrate:up
-- SRV-1904 (pilot addition P-D4, owner's decision 21. 11. 2026.): a teacher
-- copies an assignment into a course they teach, for example the same
-- seminar paper for next year's course. The copy is a new assignment whose
-- version 1 is the content of the source's current version; the source is
-- not changed.
--
-- What is copied is only what the teacher wrote: the title, the
-- instructions, the work type, the dates (or new ones), the rules on AI
-- tools, the evidence profile, the import rule, the word range, the purpose
-- catalogue and the work language. Nothing a student made or received is
-- copied: no submission, work, evidence, acknowledgment, deadline extension,
-- individual work language, accommodation, grant, source, attachment,
-- comment or note. Groups belong to the source's course and stay there.
--
-- Who may copy comes from relations only (C-23): the caller teaches the
-- source assignment's course and the target course, in the caller's
-- institution. A mentorship assignment is not copied (it belongs to one
-- thesis). The target course's AI rule bounds the copy as it bounds a new
-- assignment (D-52).
--
--   institution.copy_assignment  the teacher copies an assignment; returns
--                                the new id
--
-- The institution and the author come from the session. p_request_id is the
-- client's key for one form: the same key with the same source content and
-- dates answers the same id, with anything else ZD409. Errors carry no
-- input: ZD401 no session, ZD403 no relation (one answer for every refusal,
-- also for an assignment or course that does not exist), ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.copy_assignment(
  p_assignment_id uuid, p_course_id uuid, p_request_id uuid, p_opens_at timestamptz, p_due_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  src record;
  existing record;
  v_opens_at timestamptz;
  v_due_at timestamptz;
  v_assignment uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- The source's current version, only of a course assignment of the
  -- caller's institution that the caller teaches.
  SELECT v.title, v.instructions, v.work_type, v.opens_at, v.due_at, v.ai_policy, v.ai_purposes,
         v.evidence_profile, v.import_allowed, v.word_min, v.word_max, v.purpose_catalog_version,
         v.work_language
    INTO src
    FROM institution.assignment a
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version AND v.institution_id = a.institution_id
   WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id AND a.course_id IS NOT NULL
     AND institution.actor_course_role(a.course_id) = 'teacher';
  IF NOT FOUND OR institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  v_opens_at := coalesce(p_opens_at, src.opens_at);
  v_due_at := coalesce(p_due_at, src.due_at);
  -- Checked here, before the table constraint, whose error quotes the row.
  IF p_request_id IS NULL
     OR NOT institution.is_assignment_content(src.title, src.instructions, src.work_type, v_opens_at, v_due_at,
                                              src.ai_policy, src.ai_purposes, src.evidence_profile,
                                              src.import_allowed, src.purpose_catalog_version)
     OR NOT institution.is_word_range(src.word_min, src.word_max)
     OR institution.ai_policy_rank(src.ai_policy)
        > (SELECT institution.ai_policy_rank(c.ai_policy) FROM institution.course c
            WHERE c.id = p_course_id AND c.institution_id = actor.institution_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  INSERT INTO institution.assignment (course_id, institution_id, created_by, request_id)
  VALUES (p_course_id, actor.institution_id, actor.user_id, p_request_id)
  ON CONFLICT (created_by, request_id) WHERE request_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_assignment;

  IF v_assignment IS NOT NULL THEN
    INSERT INTO institution.assignment_version (
      assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
      evidence_profile, import_allowed, word_min, word_max, purpose_catalog_version, work_language, created_by
    )
    VALUES (v_assignment, 1, src.title, src.instructions, src.work_type, v_opens_at, v_due_at, src.ai_policy,
            src.ai_purposes, src.evidence_profile, src.import_allowed, src.word_min, src.word_max,
            src.purpose_catalog_version, src.work_language, actor.user_id);
    RETURN v_assignment;
  END IF;

  -- A key belongs to one creator. A replay answers the earlier copy only when
  -- its course and its first version are what this call would write.
  SELECT a.id, a.course_id, v.title, v.instructions, v.work_type, v.opens_at, v.due_at, v.ai_policy,
         v.ai_purposes, v.evidence_profile, v.import_allowed, v.word_min, v.word_max,
         v.purpose_catalog_version, v.work_language
    INTO existing
    FROM institution.assignment a
    JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = 1
   WHERE a.created_by = actor.user_id AND a.request_id = p_request_id;
  IF existing.id IS NULL
     OR existing.course_id IS DISTINCT FROM p_course_id
     OR existing.title IS DISTINCT FROM src.title
     OR existing.instructions IS DISTINCT FROM src.instructions
     OR existing.work_type IS DISTINCT FROM src.work_type
     OR existing.opens_at IS DISTINCT FROM v_opens_at
     OR existing.due_at IS DISTINCT FROM v_due_at
     OR existing.ai_policy IS DISTINCT FROM src.ai_policy
     OR existing.ai_purposes IS DISTINCT FROM src.ai_purposes
     OR existing.evidence_profile IS DISTINCT FROM src.evidence_profile
     OR existing.import_allowed IS DISTINCT FROM src.import_allowed
     OR existing.word_min IS DISTINCT FROM src.word_min
     OR existing.word_max IS DISTINCT FROM src.word_max
     OR existing.purpose_catalog_version IS DISTINCT FROM src.purpose_catalog_version
     OR existing.work_language IS DISTINCT FROM src.work_language THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN existing.id;
END
$$;

REVOKE ALL ON FUNCTION institution.copy_assignment(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.copy_assignment(uuid, uuid, uuid, timestamptz, timestamptz) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.copy_assignment(uuid, uuid, uuid, timestamptz, timestamptz);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
