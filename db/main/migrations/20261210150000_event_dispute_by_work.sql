-- migrate:up
-- SRV-1315 (Ductus#2052; plan M7.8, R-08): the HTTP routes name a work by its
-- document id, while SRV-1314 keys a record by assignment and student. These
-- two functions resolve the work (collaboration.document_scope, as the
-- comments and the consultation records do) and call the SRV-1314 functions,
-- so every access rule stays in one place:
--
--   app.add_work_event_dispute  the caller adds a record to a work they own;
--                               a reader of the work, another student of the
--                               course and anyone else get ZD403
--   app.work_event_disputes     the records of a work for its owner or a
--                               reader of it (app.event_disputes)
--
-- Both answer ZD403 for a work that does not exist, one of another
-- institution and an id that cannot be one (C-23); ZD422 for invalid input,
-- checked before the work is looked up. Reading writes nothing.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.add_work_event_dispute(p_document_id text, p_kind text, p_event_id text, p_text text)
RETURNS TABLE (id uuid, kind text, event_id text, text text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_scope record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_kind IS NULL OR p_kind NOT IN ('amendment', 'dispute')
     OR p_event_id IS NULL OR p_event_id !~ '^[a-z][a-z0-9_.:/-]{0,127}$'
     OR p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 1000 OR p_text !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS DISTINCT FROM v_institution OR v_scope.principal_id IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.add_event_dispute(v_scope.assignment_id, p_kind, p_event_id, p_text);
END
$$;
REVOKE ALL ON FUNCTION app.add_work_event_dispute(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_work_event_dispute(text, text, text, text) TO ductus_app;

CREATE FUNCTION app.work_event_disputes(p_document_id text)
RETURNS TABLE (id uuid, kind text, event_id text, text text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_scope record;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS DISTINCT FROM v_institution THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.event_disputes(v_scope.assignment_id, v_scope.principal_id);
END
$$;
REVOKE ALL ON FUNCTION app.work_event_disputes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_event_disputes(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.work_event_disputes(text);
DROP FUNCTION app.add_work_event_dispute(text, text, text, text);
RESET ROLE;
