-- migrate:up
-- F4-V13-R01 (Ductus#2059, order of 27. 11. 2026; WEB docs/nalazi/
-- pregled-funkcija-f4.md, row V13-R01). app.open_student_work opens a work of
-- a slides assignment: it answered 'not_configured' for any kind but text, so
-- no student could start a slides work on a real stack.
--
--   evidence.slides_revision_zero_document()  the exact JCS bytes of revision
--                   0 of every slides work (contract section 7): one slide of
--                   the layout titleContent, no blocks. Beside the text
--                   function, which stays as it is. The same bytes and hash
--                   are fixed in server/domain/slides/revision-zero.ts
--                   (SLIDES_REVISION_ZERO_JCS, SLIDES_REVISION_ZERO_SHA256) and
--                   checked against this file by a test.
--   app.open_student_work  same signature, same grants, same answers. A slides
--                   assignment now starts a work of kind slides from that
--                   revision 0 (document, revision, checkpoint and package in
--                   one transaction, as for text); a text assignment is as
--                   before; a spreadsheet assignment is still 'not_configured'
--                   (its revision 0 is a later task). A work that exists opens
--                   as before, whatever the assignment says now.
--
-- No new table, no grant change, no API field (the contract already has
-- workKind and slidesSchemaVersion on evidence.open). Slides revision 0 has
-- schemaVersion 1, so keep_document_schema_version judges later revisions as
-- it does for any version-1 work.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app, evidence TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE FUNCTION evidence.slides_revision_zero_document() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT '{"documentKind":"slides","schemaVersion":1,"slides":[{"blocks":[],"id":"00000000-0000-4000-8000-000000000000","layout":"titleContent"}]}'::text
$$;
REVOKE ALL ON FUNCTION evidence.slides_revision_zero_document() FROM PUBLIC;

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
  v_revision_zero text;
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
    -- The kind of the work is the kind of its assignment, fixed at the start,
    -- and with it the revision 0 the work begins from. A spreadsheet has none
    -- here yet.
    v_kind := app.assignment_document_kind(p_assignment_id);
    IF pg_catalog.cardinality(v_domains) IS DISTINCT FROM 1 OR v_kind NOT IN ('text', 'slides') THEN
      RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    v_revision_zero := CASE v_kind
      WHEN 'slides' THEN evidence.slides_revision_zero_document()
      ELSE evidence.revision_zero_document() END;
    v_project_id := pg_catalog.gen_random_uuid()::text;
    INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
    VALUES (v_project_id, v_actor.institution_id, p_assignment_id, v_actor.user_id)
    ON CONFLICT (assignment_id, institution_id, principal_id) DO NOTHING;
    IF FOUND THEN
      v_document_id := pg_catalog.gen_random_uuid()::text;
      INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision,
                                     current_content_hash, document_kind)
      VALUES (v_document_id, v_actor.institution_id, v_project_id, v_actor.user_id, 0,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_revision_zero, 'UTF8')), 'hex'),
              v_kind);
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
        FROM evidence.document d WHERE d.id = v_document_id;
      INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      VALUES (v_document_id, v_actor.institution_id, 0, v_revision_zero);
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
REVOKE CREATE ON SCHEMA app, evidence FROM ductus_evidence;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SELECT 1;
