-- migrate:up
-- SRV-F4-V14-R01 (Ductus#2059, order wf4v14-r01; WEB docs/nalazi/
-- pregled-funkcija-f4.md, row V14-R01). app.open_student_work starts the work
-- of a spreadsheet assignment: until now it answered 'not_configured' for any
-- kind but text (20261219360000), so the kind 'spreadsheet' that
-- 20261220120000 allows could not be reached. Precondition for V14-R02..R04.
--
--   evidence.revision_zero_sheet_document()  the exact JCS bytes of the
--       spreadsheet revision 0 (one empty sheet "List1", 100 rows, 10
--       columns, fixed id), the same bytes as sheetRevisionZeroDocument() of
--       server/domain/sheet and SHEET_REVISION_ZERO_SHA256 of
--       server/database/evidence-work-version.ts (a test checks both).
--   app.open_student_work(uuid, boolean)  CREATE OR REPLACE, the signature,
--       the result columns, the owner and the grants are unchanged. A work
--       of a spreadsheet assignment is made like a text work (project,
--       document, revision 0, checkpoint 0, package), with the revision 0 of
--       its kind and kind 'spreadsheet'. Slides stay 'not_configured' and
--       write nothing. A text work is made exactly as before.
--
-- No new table, no grant change, no API change: the route reads the kind of
-- the work from evidence.document (server/database/open-work.ts).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT CREATE ON SCHEMA app TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION evidence.revision_zero_sheet_document() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT '{"kind":"spreadsheet","schemaVersion":1,"sheets":[{"cells":{},"columns":10,"id":"00000000-0000-4000-8000-000000000000","name":"List1","rows":100}]}'::text
$$;
REVOKE ALL ON FUNCTION evidence.revision_zero_sheet_document() FROM PUBLIC;

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
  v_zero text;
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
    -- Text and spreadsheet have a revision 0 here; slides do not yet.
    v_kind := app.assignment_document_kind(p_assignment_id);
    IF pg_catalog.cardinality(v_domains) IS DISTINCT FROM 1
       OR v_kind NOT IN ('text', 'spreadsheet') THEN
      RETURN QUERY SELECT 'not_configured'::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::text,
        NULL::bigint, NULL::text;
      RETURN;
    END IF;
    v_zero := CASE v_kind WHEN 'spreadsheet' THEN evidence.revision_zero_sheet_document()
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
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_zero, 'UTF8')), 'hex'),
              v_kind);
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
      SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
        FROM evidence.document d WHERE d.id = v_document_id;
      INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      VALUES (v_document_id, v_actor.institution_id, 0, v_zero);
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
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SELECT 1;
