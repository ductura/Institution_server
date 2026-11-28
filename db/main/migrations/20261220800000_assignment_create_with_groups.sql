-- migrate:up
-- F4 wave 2 #5, task 1.8 (SRV#977 review): a replay of the create request
-- with other groups is the key's conflict (ZD409, contracts/routes/
-- institution.ts), whichever way the set differs. The route linked through
-- add_assignment_groups, whose ON CONFLICT DO NOTHING made a replay with MORE
-- groups (or groups for an assignment of the whole course) widen the stored
-- set, after which the stored set matched the request. Nothing in
-- 20261220620000 changes; this adds one function the route calls instead.
--
--   create_assignment_with_groups(<the 17 arguments of create_assignment>,
--                   groups)  creates the assignment and links the groups in
--                   one statement. Whether the key was used is decided
--                   BEFORE anything is written, under a transaction lock on
--                   the caller and the key, so a concurrent first creation
--                   with the same key is seen as a replay:
--                   - a new key: create_assignment, then add_assignment_groups
--                     for a non-empty list (an empty list is the whole
--                     course, no link);
--                   - a used key: create_assignment answers the stored id or
--                     ZD409 for other content; then the stored links must be
--                     exactly the list (fewer, more, other, none against some
--                     and some against none are ZD409), and nothing is
--                     written.
--                   A null list, or a null or repeated id, is ZD422 before
--                   anything; a group of another course is ZD422 from
--                   add_assignment_groups. Who may is create_assignment's (a
--                   teacher of the course), so nobody gains anything.
--
-- Errors carry no input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.create_assignment_with_groups(
  p_course_id uuid, p_request_id uuid, p_title text, p_instructions text, p_work_type text,
  p_opens_at timestamptz, p_due_at timestamptz, p_ai_policy text, p_ai_purposes text[],
  p_evidence_profile text, p_import_allowed boolean,
  p_word_min integer, p_word_max integer, p_purpose_catalog_version integer, p_is_practice boolean,
  p_external_tools_allowed boolean, p_ai_summary_only boolean, p_group_ids uuid[]
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
     OR (SELECT count(DISTINCT u.g) FROM unnest(p_group_ids) AS u (g)) <> cardinality(p_group_ids) THEN
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
    IF EXISTS (SELECT l.group_id FROM institution.assignment_group l WHERE l.assignment_id = v_assignment
               EXCEPT SELECT u.g FROM unnest(p_group_ids) AS u (g))
       OR EXISTS (SELECT u.g FROM unnest(p_group_ids) AS u (g)
                  EXCEPT SELECT l.group_id FROM institution.assignment_group l
                          WHERE l.assignment_id = v_assignment) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
  ELSIF cardinality(p_group_ids) > 0 THEN
    PERFORM institution.add_assignment_groups(v_assignment, p_group_ids);
  END IF;
  RETURN v_assignment;
END
$$;

REVOKE ALL ON FUNCTION institution.create_assignment_with_groups(uuid, uuid, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, integer, boolean, boolean,
  boolean, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.create_assignment_with_groups(uuid, uuid, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, integer, boolean, boolean,
  boolean, uuid[]) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.create_assignment_with_groups(uuid, uuid, text, text, text,
  timestamptz, timestamptz, text, text[], text, boolean, integer, integer, integer, boolean, boolean,
  boolean, uuid[]);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
