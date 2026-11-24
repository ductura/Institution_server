-- migrate:up
-- SRV-MENTOR-3C (Ductus#2055; owner decision of 24 Nov 2026, "Da za oboje",
-- on the open item of #678): collaboration.purge_orphan_work_data
-- (20261217120000) now also calls the other per-work deletions that the
-- retention role was given and that nothing called yet. Each removes rows of
-- a work outside its document that carry no foreign key to
-- evidence.document, so a work that no longer exists left them behind:
--
--   delete_live_state         live_state                         (20261019120000)
--   delete_revision_requests  revision_request, its versions and
--                             responses                          (20261106160000)
--   delete_working_criteria   teacher_working_criterion          (20261121150000)
--   delete_direct_edit        direct_edit_setting, its changes,
--                             teacher_edit                       (20261129100100)
--   delete_work_reviews       work_review                        (20261129100200)
--
-- The pattern is unchanged: SECURITY DEFINER with an empty search_path,
-- EXECUTE for ductus_retention alone (the grant of 20261217120000 stays, as
-- CREATE OR REPLACE keeps it), one transaction, works found per institution
-- and the rows of each kind counted before its deletion runs. A work "no
-- longer exists" when collaboration.document_scope finds no document of that
-- id in that institution; a work that exists is never touched. The versions
-- and responses of a revision request and the changes of a direct-edit
-- setting carry no document id and cannot outlive their parent (foreign
-- keys), so they are found and counted through it. Takes no input and returns
-- only the total count: no identifier, no text.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION collaboration.purge_orphan_work_data() RETURNS bigint
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
            UNION SELECT t.document_id, t.institution_id FROM collaboration.teacher_note t
            UNION SELECT l.document_id, l.institution_id FROM collaboration.live_state l
            UNION SELECT r.document_id, r.institution_id FROM collaboration.revision_request r
            UNION SELECT c.document_id, c.institution_id FROM collaboration.teacher_working_criterion c
            UNION SELECT e.document_id, e.institution_id FROM collaboration.direct_edit_setting e
            UNION SELECT e.document_id, e.institution_id FROM collaboration.teacher_edit e
            UNION SELECT v.document_id, v.institution_id FROM collaboration.work_review v) k
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
          WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.live_state l
          WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_request r
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_request_version rv
           JOIN collaboration.revision_request r ON r.id = rv.request_id AND r.institution_id = rv.institution_id
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_response rs
           JOIN collaboration.revision_request r ON r.id = rs.request_id AND r.institution_id = rs.institution_id
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_working_criterion c
          WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.direct_edit_setting e
          WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.direct_edit_setting_change ec
          WHERE ec.document_id = w.document_id AND ec.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_edit e
          WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_review v
          WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id);
    PERFORM collaboration.delete_work_self_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_items_seen(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_messages(w.document_id, w.institution_id);
    PERFORM collaboration.delete_teacher_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_live_state(w.document_id, w.institution_id);
    PERFORM collaboration.delete_revision_requests(w.document_id, w.institution_id);
    PERFORM collaboration.delete_working_criteria(w.document_id, w.institution_id);
    PERFORM collaboration.delete_direct_edit(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_reviews(w.document_id, w.institution_id);
  END LOOP;
  RETURN v_rows;
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- Back to the four kinds of 20261217120000.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION collaboration.purge_orphan_work_data() RETURNS bigint
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
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
