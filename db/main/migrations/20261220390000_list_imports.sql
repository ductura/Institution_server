-- migrate:up
-- SRV-F4-PM2-R14-SRV (F4 row PM2-R14, M8.13 "Povijest dokumenta"; Daniel's
-- decision of 26. 11. 2026, Ductus#2059 c.7202802486): the list of the imports
-- of a work, the same for both roles (D-198 item 6). No table changes.
--
--   collaboration.list_imports   the imports prepared into one work, newest
--                       first: only their metadata (the import id, the kind and
--                       format of the file, its size, its normalised file name
--                       or null, the base revision, the time it was prepared,
--                       its state and, once confirmed, the time and the one
--                       event id). Never the manifest, a hash of the file or
--                       any content of it.
--
-- Who may: the student who owns the work and a teacher of its assignment,
-- decided on every call from the relation (collaboration.actor_role, C-23),
-- never from the role alone. Another student, a teacher of another course,
-- another institution, a missing work and a work with no relation are refused
-- with one answer (ZD403); ZD401 without a session. The state is derived as in
-- confirm_import: confirmed when its confirmation exists, expired after 60
-- minutes, else pending. At most the 200 newest imports are returned. The read
-- writes nothing: no access log row, no evidence row. Errors carry no input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION collaboration.list_imports(p_document_id text)
RETURNS TABLE (
  import_id uuid, import_kind text, file_format text, raw_byte_length integer,
  file_name text, base_revision bigint, prepared_at timestamptz, state text,
  confirmed_at timestamptz, event_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  scope record;
BEGIN
  PERFORM 1 FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT e.import_id, e.import_kind, e.file_format, e.raw_byte_length, e.file_name,
           e.base_revision, e.prepared_at,
           CASE WHEN c.import_id IS NOT NULL THEN 'confirmed'
                WHEN statement_timestamp() >= e.prepared_at + interval '60 minutes' THEN 'expired'
                ELSE 'pending' END,
           c.confirmed_at, c.event_id
      FROM collaboration.import_event e
      LEFT JOIN collaboration.import_confirmation c ON c.import_id = e.import_id
     WHERE e.document_id = p_document_id AND e.institution_id = scope.institution_id
     ORDER BY e.prepared_at DESC, e.import_id DESC
     LIMIT 200;
END
$$;

REVOKE ALL ON FUNCTION collaboration.list_imports(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_imports(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.list_imports(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
