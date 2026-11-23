-- INT-21 C (Daniel's decision C, through the orchestrator): the server records
-- that a revision restored the text of an earlier one, next to the revision.
-- The evidence format (v4) is unchanged: a restore is still an ordinary change
-- of the author that the editor saves as a new revision; this row only says
-- which earlier revision that text came from ("vraćeno iz verzije N").
--
-- The client never names the new revision. It names the revision it restored
-- from; the server records against the lowest revision after it, written by
-- the same student, whose committed hash equals the hash of that revision and
-- which has no record yet. When the student typed before the save, the hash
-- differs and nothing is recorded (no_matching_revision): a label the server
-- cannot verify is never written.
--
-- Only the owning student records; every other caller, a malformed id and a
-- missing document get the same not_found (C-23). The owner and the teacher
-- of the assignment read the restored-from revision in the versions list
-- (app.read_work_versions), which keeps its access and its replay log.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.revision_restore (
  document_id text NOT NULL,
  institution_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 2 AND 9007199254740991),
  restored_from_revision bigint NOT NULL CHECK (restored_from_revision BETWEEN 1 AND 9007199254740991),
  principal_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (document_id, institution_id, revision),
  CHECK (restored_from_revision < revision),
  FOREIGN KEY (document_id, institution_id, revision)
    REFERENCES evidence.document_revision (document_id, institution_id, revision),
  FOREIGN KEY (document_id, institution_id, restored_from_revision)
    REFERENCES evidence.document_revision (document_id, institution_id, revision)
);
CREATE INDEX revision_restore_from
  ON evidence.revision_restore (document_id, institution_id, restored_from_revision);

CREATE TRIGGER revision_restore_immutable BEFORE UPDATE OR DELETE ON evidence.revision_restore
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER revision_restore_no_truncate BEFORE TRUNCATE ON evidence.revision_restore
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.revision_restore ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.revision_restore FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_revision_restore_owner ON evidence.revision_restore
  TO ductus_evidence USING (true) WITH CHECK (true);

-- The record of the actor's own document: identity and institution come from
-- current_actor(), never a parameter. The caller has already checked that the
-- actor is the owning student. Outcomes: recorded, already_recorded (no
-- unrecorded match is left and the revision restored from already has one),
-- no_matching_revision.
CREATE FUNCTION app.revision_restore_record(p_document_id text, p_from_revision bigint)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_from_hash text;
  v_candidate bigint;
BEGIN
  SELECT a.institution_id, a.user_id INTO v_actor FROM app.current_actor() a;
  SELECT r.content_hash INTO v_from_hash
    FROM evidence.document d
    JOIN evidence.document_revision r ON r.document_id = d.id AND r.institution_id = d.institution_id
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id AND r.revision = p_from_revision;
  IF v_from_hash IS NULL THEN
    RETURN 'no_matching_revision';
  END IF;
  -- Lowest first, so two restores of the same revision land in their order;
  -- a concurrent record of the same revision waits on the key and moves on.
  FOR v_candidate IN
    SELECT r.revision FROM evidence.document_revision r
     WHERE r.document_id = p_document_id AND r.institution_id = v_actor.institution_id
       AND r.revision > p_from_revision AND r.principal_id = v_actor.user_id
       AND r.content_hash = v_from_hash
       AND NOT EXISTS (SELECT 1 FROM evidence.revision_restore x
                        WHERE x.document_id = r.document_id AND x.institution_id = r.institution_id
                          AND x.revision = r.revision)
     ORDER BY r.revision
  LOOP
    INSERT INTO evidence.revision_restore (document_id, institution_id, revision, restored_from_revision, principal_id)
    VALUES (p_document_id, v_actor.institution_id, v_candidate, p_from_revision, v_actor.user_id)
    ON CONFLICT (document_id, institution_id, revision) DO NOTHING;
    IF FOUND THEN
      RETURN 'recorded';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM evidence.revision_restore x
              WHERE x.document_id = p_document_id AND x.institution_id = v_actor.institution_id
                AND x.restored_from_revision = p_from_revision) THEN
    RETURN 'already_recorded';
  END IF;
  RETURN 'no_matching_revision';
END
$$;
REVOKE ALL ON FUNCTION app.revision_restore_record(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revision_restore_record(text, bigint) TO ductus_identity;

-- The versions list of 20261201100100 with the revision each saved point was
-- restored from (NULL when it was not a restore, and for the submission).
DROP FUNCTION app.work_version_rows(text, bigint);
CREATE FUNCTION app.work_version_rows(p_document_id text, p_before bigint)
RETURNS TABLE(kind text, revision bigint, saved_minute timestamptz, after_deadline boolean,
              restored_from_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH submitted AS (
    SELECT s.revision, s.requested_at, s.after_deadline
      FROM app.current_actor() a
      JOIN evidence.submission_request r ON r.institution_id = a.institution_id
      JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
     WHERE r.document_id = p_document_id
       AND NOT evidence.submission_withdrawn(s.id)
  )
  SELECT v.kind, v.revision, v.saved_minute, v.after_deadline, v.restored_from_revision
    FROM (
      SELECT 'submission'::text AS kind, s.revision,
             pg_catalog.date_trunc('minute', s.requested_at, 'UTC') AS saved_minute, s.after_deadline,
             NULL::bigint AS restored_from_revision, 0 AS rank
        FROM submitted s
      UNION ALL
      SELECT 'checkpoint', c.revision, pg_catalog.date_trunc('minute', c.created_at, 'UTC'), NULL,
             x.restored_from_revision, 1
        FROM app.current_actor() a
        JOIN evidence.document_checkpoint c ON c.institution_id = a.institution_id
        LEFT JOIN evidence.revision_restore x
          ON x.document_id = c.document_id AND x.institution_id = c.institution_id AND x.revision = c.revision
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

-- ZD401 without an open session, whatever is asked; ZD422 for a revision that
-- cannot be one restored from. One row not_found for every refusal, a
-- malformed id and a missing document alike (C-23): only the owning student
-- records.
CREATE FUNCTION app.record_revision_restore(p_document_id text, p_from_revision bigint)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  PERFORM institution.require_actor();
  IF p_from_revision IS NULL OR p_from_revision NOT BETWEEN 1 AND 9007199254740990 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS NULL
     OR collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id)
        IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT app.revision_restore_record(p_document_id, p_from_revision);
END
$$;
REVOKE ALL ON FUNCTION app.record_revision_restore(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_revision_restore(text, bigint) TO ductus_app;

-- The read of 20261120210000, unchanged but for the new column.
DROP FUNCTION app.read_work_versions(text, bigint);
CREATE FUNCTION app.read_work_versions(p_document_id text, p_before_revision bigint DEFAULT NULL)
RETURNS TABLE (outcome text, kind text, revision bigint, saved_minute timestamptz, after_deadline boolean,
               restored_from_revision bigint)
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
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint, NULL::timestamptz, NULL::boolean, NULL::bigint;
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint, NULL::timestamptz, NULL::boolean, NULL::bigint;
    RETURN;
  END IF;
  IF v_role = 'teacher' THEN
    PERFORM audit.record_work_opening(v_scope.institution_id, p_document_id, v_scope.assignment_id,
                                      v_scope.principal_id, 'replay');
  END IF;
  FOR outcome, kind, revision, saved_minute, after_deadline, restored_from_revision IN
    SELECT 'found'::text, w.kind, w.revision, w.saved_minute, w.after_deadline, w.restored_from_revision
      FROM app.work_version_rows(p_document_id, p_before_revision) w
  LOOP
    v_found := true;
    RETURN NEXT;
  END LOOP;
  IF NOT v_found THEN
    RETURN QUERY SELECT 'empty'::text, NULL::text, NULL::bigint, NULL::timestamptz, NULL::boolean, NULL::bigint;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.read_work_versions(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_versions(text, bigint) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Forward only, as 20261201100100: staging and production only go forward
-- (docs/BACKEND.md §6), and the versions list below has no earlier shape to
-- go back to without restating that migration. A local database is made again
-- with db:up instead.
DO $$
BEGIN
  RAISE EXCEPTION 'INT-21 (20261214100000) does not go down; recreate the local database';
END
$$;
