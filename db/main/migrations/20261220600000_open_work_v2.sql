-- migrate:up
-- SRV-33B (Ductus#2028, c.7041077037, Ductus#2059 order wsrv33bv2; Ductus
-- docs/contracts/document-schema-v2.md §7 t. 2): a new work is made as v2.
-- app.open_student_work writes the v2 revision 0 (evidence.revision_zero_
-- document_v2, hash 8f8aa504...) instead of the v1 one, for the checkpoint and
-- for the hash of the document and of revision 0, and nothing else changes:
-- signature, result, owner, grants, search_path and every outcome are those
-- of 20261219360000 (CREATE OR REPLACE keeps the grants). A work that exists
-- stays as it is, v1 or v2: no row is read or written for it here, and the
-- checkpoint trigger of 20261120150000 keeps every later revision of a work
-- in the version of its revision 0. So a v1 snapshot of a new work is refused
-- as 422 (SRV-33B 1/2, #446) and a v2 snapshot of an old v1 work still is.
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
  v_kind text;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
      NULL::bigint, NULL::text;
    RETURN;
  END IF;
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
    IF p_start IS NOT TRUE THEN
      RETURN QUERY SELECT 'not_started'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    SELECT pg_catalog.array_agg(d.id) INTO v_domains FROM evidence.domain d
     WHERE d.institution_id = v_actor.institution_id;
    -- The kind of the work is the kind of its assignment, fixed at the start.
    -- Only text has a revision 0 here (see the assumption above).
    v_kind := app.assignment_document_kind(p_assignment_id);
    IF pg_catalog.cardinality(v_domains) IS DISTINCT FROM 1 OR v_kind IS DISTINCT FROM 'text' THEN
      RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    v_project_id := pg_catalog.gen_random_uuid()::text;
    INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
    VALUES (v_project_id, v_actor.institution_id, p_assignment_id, v_actor.user_id)
    ON CONFLICT (assignment_id, institution_id, principal_id) DO NOTHING;
    IF FOUND THEN
      v_document_id := pg_catalog.gen_random_uuid()::text;
      INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision,
                                     current_content_hash, document_kind)
      VALUES (v_document_id, v_actor.institution_id, v_project_id, v_actor.user_id, 0,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(evidence.revision_zero_document_v2(), 'UTF8')), 'hex'),
              v_kind);
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
        FROM evidence.document d WHERE d.id = v_document_id;
      INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      VALUES (v_document_id, v_actor.institution_id, 0, evidence.revision_zero_document_v2());
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
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SELECT 1;
