-- migrate:up
-- SRV-1308 (M10.5; D-271 MQ02): what the worker reads to build the package of
-- an approved student data export (SRV-1307). Each read takes only the export
-- id; the person comes from the export row, never from a parameter, and only
-- while the export is approved (the job runs between approval and ready).
-- Another state, an unknown id or no id answers no rows, so a stale or
-- foreign id never reads anyone's data.
--
--   app.student_data_export_subject              private: the institution and
--                                                person of an approved export;
--                                                ductus_evidence may call it
--   app.worker_student_data_export_submissions   ductus_worker: the person's
--                                                submissions that stand, the
--                                                exact submitted text and the
--                                                stored receipt (if signed)
--   app.worker_student_data_export_notes         ductus_worker: the person's
--                                                own submission notes
--   app.worker_student_data_export_access_log    ductus_worker: who opened the
--                                                person's works, the columns
--                                                of app.read_my_access_log
--
-- The evidence tables belong to ductus_evidence and the export and the access
-- log to ductus_identity, so each read is owned by the owner of its tables.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.student_data_export_subject(p_export_id uuid)
RETURNS TABLE (institution_id uuid, student_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.institution_id, e.student_id
    FROM app.student_data_export e
   WHERE e.id = p_export_id AND e.status = 'approved'
$$;

-- Every opening of the person's works by someone else, newest first, with the
-- reader's name as the person already sees it (S-42).
CREATE FUNCTION app.worker_student_data_export_access_log(p_export_id uuid)
RETURNS TABLE (entry_id uuid, opened_at timestamptz, surface text, reader_role text,
               reader_given_name text, reader_family_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT l.id, l.opened_at, l.surface, l.reader_role, n.given_name, n.family_name
    FROM app.student_data_export_subject(p_export_id) s
    JOIN audit.access_log l ON l.institution_id = s.institution_id AND l.owner_id = s.student_id
    LEFT JOIN identity.person_name n ON n.user_id = l.reader_id AND n.institution_id = l.institution_id
   ORDER BY l.opened_at DESC, l.id DESC
$$;

REVOKE ALL ON FUNCTION app.student_data_export_subject(uuid),
  app.worker_student_data_export_access_log(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_data_export_subject(uuid) TO ductus_evidence;
GRANT EXECUTE ON FUNCTION app.worker_student_data_export_access_log(uuid) TO ductus_worker;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;

-- The submissions that stand (a withdrawn one is left out), oldest first, each
-- with the exact text of its submitted revision and, once signed, its stored
-- receipt; the receipt columns are null while it waits for its signature.
CREATE FUNCTION app.worker_student_data_export_submissions(p_export_id uuid)
RETURNS TABLE (submission_id uuid, assignment_id uuid, revision bigint, requested_at timestamptz,
               body text, receipt_payload text, payload_digest_sha256 text, signature jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.id, s.assignment_id, s.revision, s.requested_at, c.body, r.receipt_payload,
         r.payload_digest_sha256, r.signature
    FROM app.student_data_export_subject(p_export_id) x
    JOIN evidence.submission s ON s.institution_id = x.institution_id AND s.principal_id = x.student_id
    JOIN evidence.submission_request q ON q.id = s.submission_request_id AND q.institution_id = s.institution_id
    JOIN evidence.document_checkpoint c
      ON c.institution_id = q.institution_id AND c.document_id = q.document_id AND c.revision = s.revision
    LEFT JOIN evidence.submission_receipt r
      ON r.submission_id = s.id AND r.institution_id = s.institution_id AND r.principal_id = s.principal_id
   WHERE NOT evidence.submission_withdrawn(s.id)
   ORDER BY s.requested_at, s.id
$$;

-- The person's own notes on their submissions, oldest first.
CREATE FUNCTION app.worker_student_data_export_notes(p_export_id uuid)
RETURNS TABLE (note_id uuid, assignment_id uuid, created_at timestamptz, text text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT n.id, n.assignment_id, n.created_at, n.text
    FROM app.student_data_export_subject(p_export_id) x
    JOIN evidence.submission_note n ON n.institution_id = x.institution_id AND n.student_id = x.student_id
   ORDER BY n.created_at, n.id
$$;

REVOKE ALL ON FUNCTION app.worker_student_data_export_submissions(uuid),
  app.worker_student_data_export_notes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_student_data_export_submissions(uuid),
  app.worker_student_data_export_notes(uuid) TO ductus_worker;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.worker_student_data_export_notes(uuid);
DROP FUNCTION app.worker_student_data_export_submissions(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.worker_student_data_export_access_log(uuid);
DROP FUNCTION app.student_data_export_subject(uuid);
