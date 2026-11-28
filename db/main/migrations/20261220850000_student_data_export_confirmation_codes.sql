-- migrate:up
-- F4-1.1-4-6-SRV (Dizajn 1.1, val 2; continues SRV#964): the worker's read of
-- the confirmation codes for the package of an approved student data export,
-- so each receipt PDF in the package carries its code, the same bytes as
-- student.receipt-pdf.get. The worker has no session of the student, so no
-- reader bound to a session (app.my_submission_confirmation_code) can serve it.
--
--   app.worker_student_data_export_confirmation_codes   ductus_worker: for
--       the person's submissions that stand (a withdrawn one is left out), the
--       submission id and its bound code; a submission still waiting for its
--       receipt has no code and no row.
--
-- Like the other reads of the package (20261211120000) it takes only the
-- export id: the person comes from the export row through the private subject
-- step, and only while the export is approved. Another state, an unknown id
-- or no id answers no rows, so no other person's code is ever read. The codes
-- belong to ductus_evidence, which owns the function; only the worker executes
-- it. It returns the submission id and the code alone, nothing else of the
-- code row (no institution, person or time of issue).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE FUNCTION app.worker_student_data_export_confirmation_codes(p_export_id uuid)
RETURNS TABLE (submission_id uuid, code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.id, c.code
    FROM app.student_data_export_subject(p_export_id) x
    JOIN evidence.submission s ON s.institution_id = x.institution_id AND s.principal_id = x.student_id
    JOIN evidence.submission_confirmation_code c
      ON c.submission_id = s.id AND c.institution_id = s.institution_id AND c.principal_id = s.principal_id
   WHERE NOT evidence.submission_withdrawn(s.id)
   ORDER BY s.id
$$;
REVOKE ALL ON FUNCTION app.worker_student_data_export_confirmation_codes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_student_data_export_confirmation_codes(uuid) TO ductus_worker;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.worker_student_data_export_confirmation_codes(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
