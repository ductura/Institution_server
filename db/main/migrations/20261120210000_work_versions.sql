-- SRV-9A (Ductus#2028, c.7041207655; orchestrator's yes c.7041490161): the
-- versions of one work, for server/database/work-versions. A version is a
-- saved point of the document (its checkpoint, revision > 0) or the
-- submission. The owning student and the teacher of the assignment get the
-- same list (PRODUCT §5 rules 5 and 7; ✓ C-10), with the relation of the
-- replay (collaboration.document_scope and actor_role, 20261028121000); every
-- other caller gets the answer for a missing document. A teacher's read is
-- logged as a replay read, one row per reader, work and 5-minute interval: the
-- list is the replay's index, and a new surface would read as "unknown" in
-- the student's access log. The checkpoints are cut at the submitted
-- revision, as app.replay_document_checkpoints cuts the texts. The answer
-- names no text, hash, submission id or exact time: a kind, a revision, a
-- whole UTC minute (D-24) and, for the submission, whether it came after the
-- deadline (the same columns app.assignment_submissions gives the teacher).
--
-- The rows are read by a helper of the evidence role, executable only by the
-- identity role, so the identity role still has no access to schema evidence.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
-- The versions of a document of the caller's institution below p_before
-- (all for NULL), newest first: revision descending, the submission before
-- the checkpoint of its revision; at most 201 rows, the 201st only telling
-- the caller that more follow. The caller has already checked that the actor
-- may read the document.
CREATE FUNCTION app.work_version_rows(p_document_id text, p_before bigint)
RETURNS TABLE (kind text, revision bigint, saved_minute timestamptz, after_deadline boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH submitted AS (
    SELECT s.revision, s.requested_at, s.after_deadline
      FROM app.current_actor() a
      JOIN evidence.submission_request r ON r.institution_id = a.institution_id
      JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
     WHERE r.document_id = p_document_id
  )
  SELECT v.kind, v.revision, v.saved_minute, v.after_deadline
    FROM (
      SELECT 'submission'::text AS kind, s.revision, pg_catalog.date_trunc('minute', s.requested_at, 'UTC') AS saved_minute,
             s.after_deadline, 0 AS rank
        FROM submitted s
      UNION ALL
      SELECT 'checkpoint', c.revision, pg_catalog.date_trunc('minute', c.created_at, 'UTC'), NULL, 1
        FROM app.current_actor() a
        JOIN evidence.document_checkpoint c ON c.institution_id = a.institution_id
       WHERE c.document_id = p_document_id AND c.revision > 0
         AND NOT EXISTS (SELECT 1 FROM submitted s WHERE c.revision > s.revision)
    ) v
   WHERE p_before IS NULL OR v.revision < p_before
   ORDER BY v.revision DESC, v.rank
   LIMIT 201
$$;
REVOKE ALL ON FUNCTION app.work_version_rows(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_version_rows(text, bigint) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- ZD401 without an open session, whatever is asked; ZD422 for a cursor below
-- 2 (no version can be below it). One row not_found for every refusal, a
-- malformed id and a missing document alike (C-23); one row empty for a work
-- with no version yet; otherwise the found rows of app.work_version_rows.
CREATE FUNCTION app.read_work_versions(p_document_id text, p_before_revision bigint DEFAULT NULL)
RETURNS TABLE (outcome text, kind text, revision bigint, saved_minute timestamptz, after_deadline boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
  v_found boolean := false;
BEGIN
  PERFORM institution.require_actor();
  IF p_before_revision IS NOT NULL AND p_before_revision < 2 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  IF v_role = 'teacher' THEN
    PERFORM audit.record_work_opening(v_scope.institution_id, p_document_id, v_scope.assignment_id,
                                      v_scope.principal_id, 'replay');
  END IF;
  FOR outcome, kind, revision, saved_minute, after_deadline IN
    SELECT 'found'::text, w.kind, w.revision, w.saved_minute, w.after_deadline
      FROM app.work_version_rows(p_document_id, p_before_revision) w
  LOOP
    v_found := true;
    RETURN NEXT;
  END LOOP;
  IF NOT v_found THEN
    RETURN QUERY SELECT 'empty'::text, NULL::text, NULL::bigint, NULL::timestamptz, NULL::boolean;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.read_work_versions(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_versions(text, bigint) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.read_work_versions(text, bigint);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.work_version_rows(text, bigint);
RESET ROLE;
