-- migrate:up
-- SRV-MENTOR-3 (Ductus#2055; NF-6 MK-8, MK-9, MK-11 and NF-5 PG-9; owner
-- decisions of 23 Nov 2026): three additions to mentorship, none of which
-- writes the document, a revision, a segment, a receipt or a hash, so none of
-- them enters the hash chain of a work (D-266, like a comment or a message).
--
-- (a) MK-9 "Poruka sebi" and "Dokle sam stao": the student's own note on a
--     work (at most 280 characters, with an optional place in the work) and
--     the student's reading place, kept on the server per work so they follow
--     the student to another computer. Only the student who owns the work
--     reads and writes them: never the mentor, a teacher of the course or the
--     administrator. The student deletes either at any time; the retention
--     role deletes both with the work (delete_work_self_notes, as messages).
--     A place is a node of the document and an offset, never a quote, so no
--     text of the work is copied here.
--
--       collaboration.work_self_note          one row per work; forced RLS, owner policy only
--       collaboration.get_work_self_note      the owner reads both
--       collaboration.set_work_self_note      the owner writes the note
--       collaboration.set_work_reading_place  the owner writes the reading place
--       collaboration.clear_work_self_note    the owner deletes the note or the reading place
--       collaboration.delete_work_self_notes  retention only
--
-- (c) MK-11 "student je vidio": the instant a reader first opened a published
--     comment, a revision request (anchored, or of a milestone) or a message
--     of a work. The client reports what was opened; the first instant stays
--     and a later report changes nothing. The author of an item reads only
--     when the student owner of the work first saw the author's own items.
--     A teacher's report on a message is what (b) counts as read.
--
--       collaboration.work_item_seen              one row per item and reader; forced RLS, owner policy only
--       collaboration.mark_work_items_seen        a reader of the work reports opened items
--       collaboration.list_work_items_seen_by_student  the author's items the student has seen
--       collaboration.delete_work_items_seen      retention only
--
-- (b) MK-8 "Moji studenti" (NF-5 PG-9): one read for the mentor of every open
--     mentorship: the current stage, whom the work waits on, the days to the
--     next deadline and the number of the student's messages the mentor has
--     not opened. The order is that of teacher.mentorships.get (newest
--     mentorship first): no score, no rank, no comparison of students.
--
--       collaboration.mentor_student_overview  the caller's mentorships
--
-- Access comes from the relation, never from the role alone (C-23):
-- collaboration.actor_role for a work, institution.actor_mentorship_role for
-- a mentorship, decided on every call. The institution, the reader and the
-- author come from the session, never from a parameter. Errors carry no
-- input: ZD401 no session, ZD403 no relation or not the owner (one answer,
-- also for a work that does not exist), ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- A place in a work: exactly {nodeId, offset}. nodeId as in a text anchor,
-- offset 0 to 1000000 characters into that node.
CREATE FUNCTION collaboration.is_work_place(p_place jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_typeof(p_place) = 'object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_place) k) = ARRAY['nodeId', 'offset']
    AND jsonb_typeof(p_place->'nodeId') = 'string'
    AND p_place->>'nodeId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(p_place->'offset') = 'number'
    AND p_place->>'offset' ~ '^(0|[1-9][0-9]{0,6})$'
    AND (p_place->>'offset')::integer <= 1000000,
    false)
$$;

-- A note to oneself: a comment body of at most 280 characters.
CREATE FUNCTION collaboration.is_self_note_text(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(collaboration.is_comment_body(p_text) AND char_length(p_text) <= 280, false)
$$;

-- No foreign key to evidence.document, as a message: the document is checked
-- when the row is written and its owner copied then.
CREATE TABLE collaboration.work_self_note (
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  owner_id uuid NOT NULL,
  note_text text CHECK (note_text IS NULL OR collaboration.is_self_note_text(note_text)),
  note_place jsonb CHECK (note_place IS NULL OR collaboration.is_work_place(note_place)),
  note_updated_at timestamptz,
  reading_place jsonb CHECK (reading_place IS NULL OR collaboration.is_work_place(reading_place)),
  reading_updated_at timestamptz,
  PRIMARY KEY (document_id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  CHECK ((note_text IS NULL) = (note_updated_at IS NULL)),
  CHECK (note_text IS NOT NULL OR note_place IS NULL),
  CHECK ((reading_place IS NULL) = (reading_updated_at IS NULL)),
  -- A row with nothing in it is deleted, never kept.
  CHECK (note_text IS NOT NULL OR reading_place IS NOT NULL)
);

CREATE TABLE collaboration.work_item_seen (
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  item_kind text NOT NULL CHECK (item_kind IN ('comment', 'revision_request', 'milestone_revision', 'message')),
  item_id uuid NOT NULL,
  viewer_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (item_kind, item_id, viewer_id),
  FOREIGN KEY (viewer_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_item_seen_document_idx ON collaboration.work_item_seen (document_id, institution_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_self_note', 'work_item_seen'] LOOP
    EXECUTE format('ALTER TABLE collaboration.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE collaboration.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON collaboration.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t
    );
  END LOOP;
END
$$;

-- The scope of a work for its student owner alone. ZD401 without a session,
-- ZD403 for anyone else, the mentor and the teachers of the work included,
-- and for a work that does not exist.
CREATE FUNCTION collaboration.self_note_scope(p_document_id text, OUT institution_id uuid, OUT owner_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL OR scope.principal_id IS DISTINCT FROM actor.user_id
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id)
        IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  institution_id := scope.institution_id;
  owner_id := scope.principal_id;
END
$$;

-- The owner's note and reading place on a work: no row when neither is kept.
CREATE FUNCTION collaboration.get_work_self_note(p_document_id text)
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

-- The owner writes the note, replacing the earlier one; the place is optional.
CREATE FUNCTION collaboration.set_work_self_note(p_document_id text, p_text text, p_place jsonb)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  -- Checked before the table constraints, whose errors would quote the row.
  IF NOT collaboration.is_self_note_text(p_text)
     OR (p_place IS NOT NULL AND NOT collaboration.is_work_place(p_place)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.work_self_note AS n
    (institution_id, document_id, owner_id, note_text, note_place, note_updated_at)
  VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_text, p_place, statement_timestamp())
  ON CONFLICT (document_id, institution_id) DO UPDATE
    SET note_text = EXCLUDED.note_text, note_place = EXCLUDED.note_place, note_updated_at = EXCLUDED.note_updated_at;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;

-- The owner writes the reading place ("Dokle sam stao"), replacing the earlier one.
CREATE FUNCTION collaboration.set_work_reading_place(p_document_id text, p_place jsonb)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  IF NOT collaboration.is_work_place(p_place) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.work_self_note AS n
    (institution_id, document_id, owner_id, reading_place, reading_updated_at)
  VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_place, statement_timestamp())
  ON CONFLICT (document_id, institution_id) DO UPDATE
    SET reading_place = EXCLUDED.reading_place, reading_updated_at = EXCLUDED.reading_updated_at;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;

-- The owner deletes the note ('note') or the reading place ('reading'); a row
-- left with nothing goes. Deleting what is not there changes nothing.
CREATE FUNCTION collaboration.clear_work_self_note(p_document_id text, p_part text)
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

-- An item of a work as its readers see it: its author, or no row when it is
-- not on this work, not published, deleted, or not one the caller may see.
CREATE FUNCTION collaboration.work_item_author(
  p_institution_id uuid, p_document_id text, p_kind text, p_item_id uuid
) RETURNS uuid
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE p_kind
    WHEN 'comment' THEN (
      SELECT c.author_id FROM collaboration.comment c
        JOIN collaboration.comment_thread t ON t.id = c.thread_id AND t.institution_id = c.institution_id
       WHERE c.id = p_item_id AND c.institution_id = p_institution_id AND t.document_id = p_document_id
         AND c.published_at IS NOT NULL AND c.deleted_at IS NULL)
    WHEN 'revision_request' THEN (
      SELECT r.created_by FROM collaboration.revision_request r
       WHERE r.id = p_item_id AND r.institution_id = p_institution_id AND r.document_id = p_document_id)
    WHEN 'milestone_revision' THEN (
      SELECT e.actor_id FROM institution.work_milestone_event e
       WHERE e.id = p_item_id AND e.institution_id = p_institution_id AND e.document_id = p_document_id
         AND e.kind = 'revision_requested')
    WHEN 'message' THEN (
      SELECT m.author_id FROM collaboration.work_message m
       WHERE m.id = p_item_id AND m.institution_id = p_institution_id AND m.document_id = p_document_id)
  END
$$;

-- A reader of the work reports the items it opened, at most 200 at a time:
-- p_kinds[i] and p_ids[i] name one item. An item that is not on the work, not
-- visible or the caller's own is passed over; the answer is every reported
-- item that is kept, with the instant it was first seen. A second report
-- keeps the first instant.
CREATE FUNCTION collaboration.mark_work_items_seen(p_document_id text, p_kinds text[], p_ids uuid[])
RETURNS TABLE (item_kind text, item_id uuid, first_seen_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR coalesce(collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id), '')
        NOT IN ('student', 'teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_kinds IS NULL OR p_ids IS NULL
     OR coalesce(array_ndims(p_kinds), 1) <> 1 OR coalesce(array_ndims(p_ids), 1) <> 1
     OR cardinality(p_kinds) <> cardinality(p_ids) OR cardinality(p_kinds) NOT BETWEEN 1 AND 200
     OR array_position(p_ids, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(p_kinds) k
                 WHERE k IS NULL OR k NOT IN ('comment', 'revision_request', 'milestone_revision', 'message')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.work_item_seen (institution_id, document_id, item_kind, item_id, viewer_id)
  SELECT DISTINCT scope.institution_id, p_document_id, i.kind, i.id, actor.user_id
    FROM unnest(p_kinds, p_ids) AS i (kind, id)
   WHERE collaboration.work_item_author(scope.institution_id, p_document_id, i.kind, i.id)
         IS DISTINCT FROM actor.user_id
     AND collaboration.work_item_author(scope.institution_id, p_document_id, i.kind, i.id) IS NOT NULL
  ON CONFLICT (item_kind, item_id, viewer_id) DO NOTHING;
  RETURN QUERY
    SELECT s.item_kind, s.item_id, s.first_seen_at
      FROM collaboration.work_item_seen s
     WHERE s.institution_id = scope.institution_id AND s.document_id = p_document_id
       AND s.viewer_id = actor.user_id
       AND (s.item_kind, s.item_id) IN (SELECT * FROM unnest(p_kinds, p_ids))
     ORDER BY s.first_seen_at, s.item_kind, s.item_id;
END
$$;

-- The caller's own items of the work that its student owner has opened, with
-- the instant of the first opening. An item the student has not opened has
-- no row; so has one that is gone or no longer visible.
CREATE FUNCTION collaboration.list_work_items_seen_by_student(p_document_id text)
RETURNS TABLE (item_kind text, item_id uuid, first_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR coalesce(collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id), '')
        NOT IN ('student', 'teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT s.item_kind, s.item_id, s.first_seen_at
      FROM collaboration.work_item_seen s
     WHERE s.institution_id = scope.institution_id AND s.document_id = p_document_id
       AND s.viewer_id = scope.principal_id
       AND collaboration.work_item_author(scope.institution_id, p_document_id, s.item_kind, s.item_id) = actor.user_id
     ORDER BY s.first_seen_at, s.item_kind, s.item_id;
END
$$;

-- The mentor's overview of every open mentorship of the caller, one row each.
-- The stage is the first milestone, in workflow order, that is not approved.
-- waiting_on: 'mentor' when that milestone is submitted or a message of the
-- student is unopened by the caller; 'student' when the work is not started
-- or the stage is not submitted or under revision; 'none' otherwise. The next
-- deadline is the earliest of the work's milestones that are not approved (a
-- revision deadline before the milestone's), past ones included; its days are
-- calendar days in Europe/Zagreb, negative once it has passed.
CREATE FUNCTION collaboration.mentor_student_overview()
RETURNS TABLE (
  mentorship_id uuid, assignment_id uuid, document_id text, given_name text, family_name text,
  work_type text, title text, stage_milestone_id uuid, stage_title text, stage_position integer,
  stage_count integer, stage_state text, waiting_on text, next_deadline_at timestamptz,
  days_to_next_deadline integer, new_messages integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  RETURN QUERY
  WITH works AS (
    SELECT m.id AS m_id, m.started_at, m.student_id, m.work_type AS w_type, a.id AS a_id, v.title AS a_title,
           (SELECT x.document_id FROM app.assignment_works(a.id) x WHERE x.student_id = m.student_id
             ORDER BY x.document_id LIMIT 1) AS doc_id
      FROM institution.mentorship m
      JOIN institution.assignment a ON a.mentorship_id = m.id AND a.institution_id = m.institution_id
      JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
     WHERE m.institution_id = actor.institution_id AND m.mentor_id = actor.user_id AND m.ended_at IS NULL
       AND institution.actor_mentorship_role(m.id) = 'teacher'
  ), stages AS (
    SELECT w.m_id, ms.id AS ms_id, ms.title AS ms_title, ms.position AS ms_position,
           coalesce(p.state, 'not_submitted') AS ms_state,
           CASE WHEN p.state = 'revision_requested' AND p.revision_due_at IS NOT NULL THEN p.revision_due_at
                ELSE coalesce(d.due_at, ms.due_at) END AS ms_due
      FROM works w
      JOIN institution.work_milestone ms ON ms.assignment_id = w.a_id AND ms.institution_id = actor.institution_id
      LEFT JOIN institution.work_milestone_deadline d
        ON d.milestone_id = ms.id AND d.institution_id = ms.institution_id AND d.document_id = w.doc_id
      LEFT JOIN institution.work_milestone_progress p
        ON p.milestone_id = ms.id AND p.institution_id = ms.institution_id AND p.document_id = w.doc_id
  )
  SELECT w.m_id, w.a_id, w.doc_id, n.given_name, n.family_name, w.w_type, w.a_title,
         cur.ms_id, cur.ms_title, cur.rank, cnt.total, cur.ms_state,
         CASE
           WHEN cur.ms_state = 'submitted' OR msg.unread > 0 THEN 'mentor'
           WHEN w.doc_id IS NULL OR cur.ms_state IN ('not_submitted', 'revision_requested') THEN 'student'
           ELSE 'none'
         END,
         nxt.due,
         ((nxt.due AT TIME ZONE 'Europe/Zagreb')::date
          - (statement_timestamp() AT TIME ZONE 'Europe/Zagreb')::date)::integer,
         coalesce(msg.unread, 0)
    FROM works w
    LEFT JOIN LATERAL (SELECT x.given_name, x.family_name FROM app.teacher_assignment_student_names(w.a_id) x
                        WHERE x.student_id = w.student_id) n ON true
    LEFT JOIN LATERAL (SELECT count(*)::integer AS total FROM stages s WHERE s.m_id = w.m_id) cnt ON true
    LEFT JOIN LATERAL (SELECT s.ms_id, s.ms_title, s.ms_state,
                              (SELECT count(*)::integer FROM stages o WHERE o.m_id = w.m_id AND o.ms_position <= s.ms_position) AS rank
                         FROM stages s WHERE s.m_id = w.m_id AND s.ms_state <> 'approved'
                        ORDER BY s.ms_position LIMIT 1) cur ON true
    LEFT JOIN LATERAL (SELECT min(s.ms_due) AS due FROM stages s
                        WHERE s.m_id = w.m_id AND s.ms_state <> 'approved') nxt ON true
    LEFT JOIN LATERAL (SELECT count(*)::integer AS unread FROM collaboration.work_message wm
                        WHERE wm.document_id = w.doc_id AND wm.institution_id = actor.institution_id
                          AND wm.sender_role = 'student'
                          AND NOT EXISTS (SELECT 1 FROM collaboration.work_item_seen s
                                           WHERE s.item_kind = 'message' AND s.item_id = wm.id
                                             AND s.viewer_id = actor.user_id)) msg ON true
   ORDER BY w.started_at DESC, w.m_id;
END
$$;

-- For the retention role only, as delete_work_messages: called in the same
-- transaction as deleting a document under its retention rule or on a
-- student's withdrawal (D-12), so the note, the reading place and the seen
-- marks go when the work goes. Takes and returns no text.
CREATE FUNCTION collaboration.delete_work_self_notes(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.work_self_note n WHERE n.document_id = p_document_id AND n.institution_id = p_institution_id
$$;
CREATE FUNCTION collaboration.delete_work_items_seen(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.work_item_seen s WHERE s.document_id = p_document_id AND s.institution_id = p_institution_id
$$;

REVOKE ALL ON FUNCTION
  collaboration.is_work_place(jsonb),
  collaboration.is_self_note_text(text),
  collaboration.self_note_scope(text),
  collaboration.get_work_self_note(text),
  collaboration.set_work_self_note(text, text, jsonb),
  collaboration.set_work_reading_place(text, jsonb),
  collaboration.clear_work_self_note(text, text),
  collaboration.work_item_author(uuid, text, text, uuid),
  collaboration.mark_work_items_seen(text, text[], uuid[]),
  collaboration.list_work_items_seen_by_student(text),
  collaboration.mentor_student_overview(),
  collaboration.delete_work_self_notes(text, uuid),
  collaboration.delete_work_items_seen(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.get_work_self_note(text),
  collaboration.set_work_self_note(text, text, jsonb),
  collaboration.set_work_reading_place(text, jsonb),
  collaboration.clear_work_self_note(text, text),
  collaboration.mark_work_items_seen(text, text[], uuid[]),
  collaboration.list_work_items_seen_by_student(text),
  collaboration.mentor_student_overview()
TO ductus_app;
GRANT EXECUTE ON FUNCTION
  collaboration.delete_work_self_notes(text, uuid),
  collaboration.delete_work_items_seen(text, uuid)
TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_work_items_seen(text, uuid);
DROP FUNCTION collaboration.delete_work_self_notes(text, uuid);
DROP FUNCTION collaboration.mentor_student_overview();
DROP FUNCTION collaboration.list_work_items_seen_by_student(text);
DROP FUNCTION collaboration.mark_work_items_seen(text, text[], uuid[]);
DROP FUNCTION collaboration.work_item_author(uuid, text, text, uuid);
DROP FUNCTION collaboration.clear_work_self_note(text, text);
DROP FUNCTION collaboration.set_work_reading_place(text, jsonb);
DROP FUNCTION collaboration.set_work_self_note(text, text, jsonb);
DROP FUNCTION collaboration.get_work_self_note(text);
DROP FUNCTION collaboration.self_note_scope(text);
DROP TABLE collaboration.work_item_seen;
DROP TABLE collaboration.work_self_note;
DROP FUNCTION collaboration.is_self_note_text(text);
DROP FUNCTION collaboration.is_work_place(jsonb);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
