-- SRV-1310 (plan M8.4): the source of the DOCX export of one work, for
-- server/database/work-export. One saved version of the document (its
-- checkpoint, revision > 0, cut at the submitted revision as app.work_version_rows
-- cuts the list) with the exact bytes of its text, for the owning student and
-- the teacher of the assignment, by the relation of the replay
-- (collaboration.document_scope and actor_role); every other caller, an unknown
-- document and an unknown version get the same one answer for a missing work
-- (C-23). Without a revision the newest saved version is read. A teacher's read
-- is logged as a replay read, as app.read_work_versions does: the export is a
-- reading of the same versions, and a new surface would read as "unknown" in
-- the student's access log.
--
-- The rows are read by a helper of the evidence role, executable only by the
-- identity role, so the identity role still has no access to schema evidence.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- The version of a document of the caller's institution: the given revision, or
-- the newest when p_revision is NULL; at most one row. The caller has already
-- checked that the actor may read the document.
CREATE FUNCTION app.work_export_rows(p_document_id text, p_revision bigint)
RETURNS TABLE (revision bigint, kind text, body text, saved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.revision,
         CASE WHEN EXISTS (
           SELECT 1 FROM evidence.submission_request r
             JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
            WHERE r.institution_id = c.institution_id AND r.document_id = c.document_id AND s.revision = c.revision
         ) THEN 'submitted' ELSE 'saved' END,
         c.body, c.created_at
    FROM app.current_actor() a
    JOIN evidence.document_checkpoint c ON c.institution_id = a.institution_id
   WHERE c.document_id = p_document_id AND c.revision > 0
     AND (p_revision IS NULL OR c.revision = p_revision)
     AND NOT EXISTS (
       SELECT 1 FROM evidence.submission_request r
         JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
        WHERE r.institution_id = c.institution_id AND r.document_id = c.document_id AND c.revision > s.revision
     )
   ORDER BY c.revision DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.work_export_rows(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_export_rows(text, bigint) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- ZD401 without an open session, whatever is asked; ZD422 for a revision below
-- 1. One row not_found for every refusal, a malformed id, a missing document
-- and a missing version alike (C-23); otherwise one found row.
CREATE FUNCTION app.read_work_export(p_document_id text, p_revision bigint DEFAULT NULL)
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
REVOKE ALL ON FUNCTION app.read_work_export(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_export(text, bigint) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.read_work_export(text, bigint);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.work_export_rows(text, bigint);
RESET ROLE;
