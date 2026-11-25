-- migrate:up
-- SRV-V13-MIG-VRSTA (Ductus#2055, order of 25. 11. 2026; WEB docs/nalazi/
-- val13-razlika.md, task 3). The kind of document an assignment asks for:
-- 'text' (every assignment today) or 'slides'. Expand only: constant
-- defaults, so every existing assignment and work stays a text document.
--
--   institution.assignment.document_kind  the kind of the assignment, set when
--                   the assignment is made; no function changes it, and the
--                   application role only reads it (existing SELECT grant).
--                   Read through the existing reads of the assignment.
--   evidence.document.document_kind  the kind of the work, written once by
--                   app.open_student_work when the work starts (revision 0
--                   and the kind belong together) and never updated.
--   app.assignment_document_kind(uuid)  the bridge for the evidence role,
--                   which does not read schema institution; no grant to the
--                   application.
--
-- No API field: the contract is a later task (SRV-V13-UGOVOR-VRSTA). No
-- access change: the new columns follow the row security of their tables.
--
-- Assumption: the revision 0 of a slides work is made by the slides domain
-- (SRV-V13-UGOVOR-SLAJD, not on this base). Until then app.open_student_work
-- answers 'not_configured' for a slides assignment and writes nothing; no
-- route can make such an assignment yet. Everything else is as in
-- 20261031200000.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_identity;
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN document_kind text NOT NULL DEFAULT 'text'
  CONSTRAINT assignment_document_kind_check CHECK (document_kind IN ('text', 'slides'));

CREATE FUNCTION app.assignment_document_kind(p_assignment_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT a.document_kind FROM institution.assignment a
                    WHERE a.id = p_assignment_id), 'text')
$$;
REVOKE ALL ON FUNCTION app.assignment_document_kind(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_document_kind(uuid) TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- squawk-ignore adding-not-nullable-field
ALTER TABLE evidence.document ADD COLUMN document_kind text NOT NULL DEFAULT 'text'
  CONSTRAINT document_document_kind_check CHECK (document_kind IN ('text', 'slides'));

DROP FUNCTION app.open_student_work(uuid, boolean);
CREATE FUNCTION app.open_student_work(p_assignment_id uuid, p_start boolean DEFAULT true)
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
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(evidence.revision_zero_document(), 'UTF8')), 'hex'),
              v_kind);
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
        FROM evidence.document d WHERE d.id = v_document_id;
      INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      VALUES (v_document_id, v_actor.institution_id, 0, evidence.revision_zero_document());
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
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SELECT 1;
