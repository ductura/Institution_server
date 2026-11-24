-- migrate:up
-- SRV-MENTOR-3B (Ductus#2055; review of #669, owner decision of 23 Nov 2026
-- "student ih može obrisati na zahtjev"): two gaps around the data of
-- SRV-MENTOR-3 that no part of the server closed yet. Neither writes the
-- document, a revision, a segment, a receipt or a hash.
--
-- (a) The retention job had no call of the per-work deletions. The rows of a
--     work outside its document (the student's note to self and reading
--     place, the "student je vidio" marks, the messages and the teachers'
--     private notes) carry no foreign key to evidence.document, so a work
--     that no longer exists leaves them behind. One function for the
--     retention role finds every such work and calls, per work and in one
--     transaction, the deletions the earlier migrations gave that role:
--
--       collaboration.purge_orphan_work_data  retention only; returns the rows it removed
--         -> delete_work_self_notes, delete_work_items_seen (20261217100000)
--         -> delete_work_messages (20261121140000)
--         -> delete_teacher_notes (20261121120000)
--
--     A work "no longer exists" when collaboration.document_scope finds no
--     document of that id in that institution. A work that exists is never
--     touched, whatever its age: periods wait for D-30. The worker's dry run
--     calls the function in a transaction it always rolls back, so the count
--     is exactly what a deletion would remove (as app.purge_ended_sessions).
--     Takes no input and returns only a count: no identifier, no text.
--
-- (b) A student who no longer holds the student role on the work (left the
--     course, the mentorship ended) could neither read nor delete the own
--     note to self: every function asked for that role. The note is the
--     student's own text, so the student keeps the right to see it and to
--     delete it on request; nothing deletes it automatically while the work
--     exists (losing the role may be undone, and no period is decided). Only
--     reading and deleting fall back to the row's owner; writing still needs
--     the student role. Nobody else gains anything: the mentor, the teachers
--     and the administrator still get ZD403.
--
--       collaboration.self_note_owner_scope  the student owner of the work, else the owner of the kept row
--       collaboration.get_work_self_note     replaced: reads through the owner scope
--       collaboration.clear_work_self_note   replaced: deletes through the owner scope
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The institution of the caller's own note on a work. The student owner of an
-- existing work, as collaboration.self_note_scope; otherwise the author of a
-- note that is still kept on that work in the session's institution. ZD401
-- without a session, ZD403 for anyone else and when there is nothing to read.
CREATE FUNCTION collaboration.self_note_owner_scope(p_document_id text) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NOT NULL AND scope.principal_id = actor.user_id
     AND collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) = 'student' THEN
    RETURN scope.institution_id;
  END IF;
  IF actor.institution_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM collaboration.work_self_note n
        WHERE n.document_id = p_document_id AND n.institution_id = actor.institution_id
          AND n.owner_id = actor.user_id) THEN
    RETURN actor.institution_id;
  END IF;
  RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
END
$$;

CREATE OR REPLACE FUNCTION collaboration.get_work_self_note(p_document_id text)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution_id uuid;
BEGIN
  v_institution_id := collaboration.self_note_owner_scope(p_document_id);
  RETURN QUERY
    SELECT n.note_text, n.note_place, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
END
$$;

-- As before, but the answer is read here: after the last part of a note of a
-- student without the role is deleted, the owner scope has nothing left to
-- find, and the answer is simply no row.
CREATE OR REPLACE FUNCTION collaboration.clear_work_self_note(p_document_id text, p_part text)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution_id uuid;
BEGIN
  v_institution_id := collaboration.self_note_owner_scope(p_document_id);
  IF p_part IS NULL OR p_part NOT IN ('note', 'reading') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  DELETE FROM collaboration.work_self_note n
   WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id
     AND CASE p_part WHEN 'note' THEN n.reading_place IS NULL ELSE n.note_text IS NULL END;
  IF p_part = 'note' THEN
    UPDATE collaboration.work_self_note n SET note_text = NULL, note_place = NULL, note_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
  ELSE
    UPDATE collaboration.work_self_note n SET reading_place = NULL, reading_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
  END IF;
  RETURN QUERY
    SELECT n.note_text, n.note_place, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
END
$$;

-- For the retention role only. Every work of every institution that has rows
-- in the four tables but no document any more: its rows are counted and then
-- removed through the four per-work deletions, in the order of the works.
CREATE FUNCTION collaboration.purge_orphan_work_data() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  w record;
  v_rows bigint := 0;
BEGIN
  FOR w IN
    SELECT k.document_id, k.institution_id
      FROM (SELECT n.document_id, n.institution_id FROM collaboration.work_self_note n
            UNION SELECT s.document_id, s.institution_id FROM collaboration.work_item_seen s
            UNION SELECT m.document_id, m.institution_id FROM collaboration.work_message m
            UNION SELECT t.document_id, t.institution_id FROM collaboration.teacher_note t) k
      LEFT JOIN LATERAL collaboration.document_scope(k.document_id) d ON true
     WHERE d.institution_id IS DISTINCT FROM k.institution_id
     ORDER BY k.institution_id, k.document_id
  LOOP
    v_rows := v_rows
      + (SELECT count(*) FROM collaboration.work_self_note n
          WHERE n.document_id = w.document_id AND n.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_item_seen s
          WHERE s.document_id = w.document_id AND s.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_message m
          WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_note t
          WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id);
    PERFORM collaboration.delete_work_self_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_items_seen(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_messages(w.document_id, w.institution_id);
    PERFORM collaboration.delete_teacher_notes(w.document_id, w.institution_id);
  END LOOP;
  RETURN v_rows;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.self_note_owner_scope(text),
  collaboration.purge_orphan_work_data()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.purge_orphan_work_data() TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.purge_orphan_work_data();
CREATE OR REPLACE FUNCTION collaboration.clear_work_self_note(p_document_id text, p_part text)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  IF p_part IS NULL OR p_part NOT IN ('note', 'reading') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  DELETE FROM collaboration.work_self_note n
   WHERE n.document_id = p_document_id AND n.institution_id = v_scope.institution_id
     AND CASE p_part WHEN 'note' THEN n.reading_place IS NULL ELSE n.note_text IS NULL END;
  IF p_part = 'note' THEN
    UPDATE collaboration.work_self_note n SET note_text = NULL, note_place = NULL, note_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_scope.institution_id;
  ELSE
    UPDATE collaboration.work_self_note n SET reading_place = NULL, reading_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_scope.institution_id;
  END IF;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;
CREATE OR REPLACE FUNCTION collaboration.get_work_self_note(p_document_id text)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  RETURN QUERY
    SELECT n.note_text, n.note_place, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_scope.institution_id;
END
$$;
DROP FUNCTION collaboration.self_note_owner_scope(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
