-- SRV-33B (Ductus#2028, c.7041077037; Ductus docs/contracts/document-schema-v2.md
-- §7 t. 2 and 3): a work made from now on is v2. app.open_student_work
-- writes the v2 revision 0 (evidence.revision_zero_document_v2(), from
-- 20261120150000) as the new work's revision, hash and checkpoint, so the
-- work's version is 2 from its first revision to its submission; the
-- version trigger refuses a revision of any other version (ZD422, 422 on
-- the commit path since 20261120200000 and #446).
--
-- An existing work is not touched: its revision 0 stays what it is, so
-- every v1 work stays v1 and keeps taking v1 revisions. Only the body of
-- the function changes; its arguments, outcomes, owner, grants and
-- search_path are those of 20261031200000.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION app.open_student_work(p_assignment_id uuid, p_start boolean DEFAULT true)
RETURNS TABLE (
  outcome text, document_id text, evidence_profile_id text, current_revision bigint,
  document_hash text, head_segment_hash text, last_sequence_to bigint, snapshot text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_assignment record;
  v_domains uuid[];
  v_project_id text;
  v_document_id text;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;
  -- The assignment and the open membership stay locked FOR SHARE until the
  -- caller commits, as in the acceptance.
  SELECT * INTO v_assignment FROM app.lock_student_assignment(p_assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;
  IF NOT v_assignment.acknowledged OR v_assignment.opens_at > pg_catalog.clock_timestamp() THEN
    RETURN QUERY SELECT 'not_accepting'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;

  SELECT p.id INTO v_project_id FROM evidence.project p
   WHERE p.assignment_id = p_assignment_id AND p.institution_id = v_actor.institution_id
     AND p.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    -- F-137: only a request that asks to start makes the work; any other
    -- call opens an existing work and writes nothing.
    IF p_start IS NOT TRUE THEN
      RETURN QUERY SELECT 'not_started'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    SELECT pg_catalog.array_agg(d.id) INTO v_domains FROM evidence.domain d
     WHERE d.institution_id = v_actor.institution_id;
    IF pg_catalog.cardinality(v_domains) IS DISTINCT FROM 1 THEN
      RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    v_project_id := pg_catalog.gen_random_uuid()::text;
    -- A parallel first call waits here for the other one and then creates
    -- nothing: the unique key decides, never the lookup above.
    INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
    VALUES (v_project_id, v_actor.institution_id, p_assignment_id, v_actor.user_id)
    ON CONFLICT (assignment_id, institution_id, principal_id) DO NOTHING;
    IF FOUND THEN
      -- SRV-33B: a new work is v2 from its revision 0 (§7 t. 2); the version
      -- trigger keeps every later revision at schemaVersion 2.
      v_document_id := pg_catalog.gen_random_uuid()::text;
      INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision, current_content_hash)
      VALUES (v_document_id, v_actor.institution_id, v_project_id, v_actor.user_id, 0,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(evidence.revision_zero_document_v2(), 'UTF8')), 'hex'));
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
        FROM evidence.document d WHERE d.id = v_document_id;
      INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      VALUES (v_document_id, v_actor.institution_id, 0, evidence.revision_zero_document_v2());
      -- The capture profile is one constant shared with the client
      -- (src/domain/forensics/evidence-profile.ts); the payload limit is D-96.
      INSERT INTO evidence.package (
        id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id,
        max_payload_bytes
      ) VALUES (
        pg_catalog.gen_random_uuid()::text, v_actor.institution_id, v_domains[1], v_document_id, v_project_id,
        v_actor.user_id, 'standard-v1', 2097152
      );
    ELSE
      SELECT p.id INTO STRICT v_project_id FROM evidence.project p
       WHERE p.assignment_id = p_assignment_id AND p.institution_id = v_actor.institution_id
         AND p.principal_id = v_actor.user_id;
    END IF;
  END IF;

  -- The current state, also for reconciliation (ADR 5.4 t. 1). The snapshot
  -- is the current revision's checkpoint; package and institution stay here.
  RETURN QUERY
  SELECT 'opened'::text, d.id, k.evidence_profile_id, d.current_revision, d.current_content_hash,
         k.head_segment_hash, k.last_sequence_to, c.body
    FROM evidence.document d
    JOIN evidence.package k
      ON k.document_id = d.id AND k.institution_id = d.institution_id AND k.principal_id = d.principal_id
    LEFT JOIN evidence.document_checkpoint c
      ON c.document_id = d.id AND c.institution_id = d.institution_id AND c.revision = d.current_revision
   WHERE d.project_id = v_project_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id
   ORDER BY d.created_at, d.id, k.created_at, k.id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.open_student_work(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.open_student_work(uuid, boolean) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- New works are v1 again; works made as v2 stay v2.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION app.open_student_work(p_assignment_id uuid, p_start boolean DEFAULT true)
RETURNS TABLE (
  outcome text, document_id text, evidence_profile_id text, current_revision bigint,
  document_hash text, head_segment_hash text, last_sequence_to bigint, snapshot text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_assignment record;
  v_domains uuid[];
  v_project_id text;
  v_document_id text;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;
  -- The assignment and the open membership stay locked FOR SHARE until the
  -- caller commits, as in the acceptance.
  SELECT * INTO v_assignment FROM app.lock_student_assignment(p_assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;
  IF NOT v_assignment.acknowledged OR v_assignment.opens_at > pg_catalog.clock_timestamp() THEN
    RETURN QUERY SELECT 'not_accepting'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;

  SELECT p.id INTO v_project_id FROM evidence.project p
   WHERE p.assignment_id = p_assignment_id AND p.institution_id = v_actor.institution_id
     AND p.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    -- F-137: only a request that asks to start makes the work; any other
    -- call opens an existing work and writes nothing.
    IF p_start IS NOT TRUE THEN
      RETURN QUERY SELECT 'not_started'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    SELECT pg_catalog.array_agg(d.id) INTO v_domains FROM evidence.domain d
     WHERE d.institution_id = v_actor.institution_id;
    IF pg_catalog.cardinality(v_domains) IS DISTINCT FROM 1 THEN
      RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    v_project_id := pg_catalog.gen_random_uuid()::text;
    -- A parallel first call waits here for the other one and then creates
    -- nothing: the unique key decides, never the lookup above.
    INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
    VALUES (v_project_id, v_actor.institution_id, p_assignment_id, v_actor.user_id)
    ON CONFLICT (assignment_id, institution_id, principal_id) DO NOTHING;
    IF FOUND THEN
      v_document_id := pg_catalog.gen_random_uuid()::text;
      INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision, current_content_hash)
      VALUES (v_document_id, v_actor.institution_id, v_project_id, v_actor.user_id, 0,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(evidence.revision_zero_document(), 'UTF8')), 'hex'));
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
        FROM evidence.document d WHERE d.id = v_document_id;
      INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      VALUES (v_document_id, v_actor.institution_id, 0, evidence.revision_zero_document());
      -- The capture profile is one constant shared with the client
      -- (src/domain/forensics/evidence-profile.ts); the payload limit is D-96.
      INSERT INTO evidence.package (
        id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id,
        max_payload_bytes
      ) VALUES (
        pg_catalog.gen_random_uuid()::text, v_actor.institution_id, v_domains[1], v_document_id, v_project_id,
        v_actor.user_id, 'standard-v1', 2097152
      );
    ELSE
      SELECT p.id INTO STRICT v_project_id FROM evidence.project p
       WHERE p.assignment_id = p_assignment_id AND p.institution_id = v_actor.institution_id
         AND p.principal_id = v_actor.user_id;
    END IF;
  END IF;

  -- The current state, also for reconciliation (ADR 5.4 t. 1). The snapshot
  -- is the current revision's checkpoint; package and institution stay here.
  RETURN QUERY
  SELECT 'opened'::text, d.id, k.evidence_profile_id, d.current_revision, d.current_content_hash,
         k.head_segment_hash, k.last_sequence_to, c.body
    FROM evidence.document d
    JOIN evidence.package k
      ON k.document_id = d.id AND k.institution_id = d.institution_id AND k.principal_id = d.principal_id
    LEFT JOIN evidence.document_checkpoint c
      ON c.document_id = d.id AND c.institution_id = d.institution_id AND c.revision = d.current_revision
   WHERE d.project_id = v_project_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id
   ORDER BY d.created_at, d.id, k.created_at, k.id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.open_student_work(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.open_student_work(uuid, boolean) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
