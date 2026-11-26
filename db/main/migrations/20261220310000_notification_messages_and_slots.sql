-- migrate:up
-- SRV-F4-MEN-R10 (Ductus#2058, MEN-05): a notification for a new message of a work and for
-- a consultation slot that waits for an answer. Owner decision (Daniel, delegated to the
-- orchestrator 26 Nov 2026, writer proposal c.7196370058):
--
--   message_posted   a message is written; the other side of the work gets one: the student
--                    owner when a teacher wrote, the teachers of the work when the student wrote
--   slot_requested   the student asks for a slot; the teachers of the work get one
--   slot_proposed    the teacher proposes another time (counter); the student gets one
--
-- Written by triggers on collaboration.work_message and institution.consultation_slot, so a
-- notification commits or rolls back with the message or slot move itself: one per message,
-- one per slot and kind (event_key is the kind and the id, UNIQUE (recipient_id, event_key)),
-- none when the write is refused. The author is never told of their own act.
--
-- institution.notification stores identifiers only (D1): kind, the assignment as target, the
-- key of the message or slot. The document and the slot are read from the record itself when
-- listed, and only while the caller still has the relation the notice was made for (a teacher
-- removed from the course, or a student no longer owner, sees nothing). No text of a message
-- is ever copied or returned.
--
-- Contract: the kinds are NOT added to notifications.list.get (a wider response enum breaks
-- clients, contracts:breaking). That list leaves them out in the HTTP adapter; clients read
-- them from notifications.messages-and-slots.list.get, a new route. Reading uses the existing
-- notifications.read.post.
--
-- Teachers of a work: the open teacher members of its course who did not join after the work
-- started (as institution.actor_course_work), or the mentor of its open mentorship, each with
-- a confirmed, unrevoked teacher role (institution.work_relation). A teacher of a seminar group
-- of the student is not notified (open item in the PR).
--
--   institution.work_teachers                    the recipients for a work (not callable by the app)
--   app.notify_work_message / notify_slot_move   the trigger functions
--   institution.list_message_slot_notifications  the caller's own, newest first
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- squawk-ignore ban-drop-constraint
ALTER TABLE institution.notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE institution.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('comment_posted', 'assignment_version', 'submission_recorded', 'course_handover',
                  'deadline_reminder', 'returned_for_revision', 'mentorship_opened',
                  'message_posted', 'slot_requested', 'slot_proposed')) NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.notification VALIDATE CONSTRAINT notification_kind_check;

-- The teachers of the work of one student on one assignment, but not the person in p_except.
CREATE FUNCTION institution.work_teachers(p_assignment_id uuid, p_student_id uuid, p_except uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT DISTINCT t.user_id
  FROM institution.assignment s
  CROSS JOIN LATERAL (
    SELECT m.user_id FROM institution.course_member m
     WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
       AND m.role = 'teacher' AND m.member_to IS NULL
       AND NOT coalesce(collaboration.work_started_at(s.institution_id, s.id, p_student_id) < m.member_from, false)
    UNION ALL
    SELECT ms.mentor_id FROM institution.mentorship ms
     WHERE ms.id = s.mentorship_id AND ms.institution_id = s.institution_id AND ms.ended_at IS NULL
  ) t
  WHERE s.id = p_assignment_id
    AND t.user_id IS DISTINCT FROM p_except
    AND t.user_id <> p_student_id
    AND institution.work_relation(t.user_id, s.id) = 'teacher'
$$;
REVOKE ALL ON FUNCTION institution.work_teachers(uuid, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION institution.notify_work_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.sender_role = 'teacher' THEN
    INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id)
    SELECT NEW.institution_id, NEW.owner_id, 'message_posted', 'message_posted:' || NEW.id, NEW.assignment_id
    WHERE institution.work_relation(NEW.owner_id, NEW.assignment_id) = 'student'
    ON CONFLICT (recipient_id, event_key) DO NOTHING;
  ELSE
    INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id)
    SELECT NEW.institution_id, w.user_id, 'message_posted', 'message_posted:' || NEW.id, NEW.assignment_id
    FROM institution.work_teachers(NEW.assignment_id, NEW.owner_id, NEW.author_id) w
    ON CONFLICT (recipient_id, event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION institution.notify_work_message() FROM PUBLIC;

-- A new slot is a request of the student; a move to 'countered' is the teacher's other time.
-- Every other move (confirm, accept, withdraw, decline, cancel) tells nobody.
CREATE FUNCTION institution.notify_consultation_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.state = 'requested' THEN
    INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id)
    SELECT NEW.institution_id, w.user_id, 'slot_requested', 'slot_requested:' || NEW.id, NEW.assignment_id
    FROM institution.work_teachers(NEW.assignment_id, NEW.student_id, NULL) w
    ON CONFLICT (recipient_id, event_key) DO NOTHING;
  ELSIF NEW.state = 'countered' THEN
    INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id)
    SELECT NEW.institution_id, NEW.student_id, 'slot_proposed', 'slot_proposed:' || NEW.id, NEW.assignment_id
    WHERE institution.work_relation(NEW.student_id, NEW.assignment_id) = 'student'
    ON CONFLICT (recipient_id, event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION institution.notify_consultation_slot() FROM PUBLIC;

CREATE TRIGGER work_message_notify AFTER INSERT ON collaboration.work_message
  FOR EACH ROW EXECUTE FUNCTION institution.notify_work_message();
CREATE TRIGGER consultation_slot_notify_insert AFTER INSERT ON institution.consultation_slot
  FOR EACH ROW WHEN (NEW.state = 'requested') EXECUTE FUNCTION institution.notify_consultation_slot();
CREATE TRIGGER consultation_slot_notify_update AFTER UPDATE OF state ON institution.consultation_slot
  FOR EACH ROW WHEN (NEW.state = 'countered' AND OLD.state IS DISTINCT FROM 'countered')
  EXECUTE FUNCTION institution.notify_consultation_slot();

-- The caller's own notifications of the three kinds, newest first, at most 51 (a page of 50
-- and one to tell there is more). The document comes from the message or slot; the row is
-- left out when that record is gone (retention) or the caller has lost the relation: the
-- student owner for slot_proposed, a teacher of the work for slot_requested, either side for
-- a message. A cursor that is not the caller's own, or not of these kinds, is ZD403.
CREATE FUNCTION institution.list_message_slot_notifications(p_before uuid)
RETURNS TABLE (id uuid, kind text, target_id uuid, document_id text, slot_id uuid,
               created_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  cursor_at timestamptz;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_before IS NOT NULL THEN
    SELECT n.created_at INTO cursor_at FROM institution.notification n
    WHERE n.id = p_before AND n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
      AND n.kind IN ('message_posted', 'slot_requested', 'slot_proposed');
    IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403'; END IF;
  END IF;
  RETURN QUERY
  SELECT n.id, n.kind, n.target_id, r.document_id, r.slot_id, n.created_at, n.read_at
  FROM institution.notification n
  CROSS JOIN LATERAL (
    SELECT m.document_id, NULL::uuid AS slot_id
      FROM collaboration.work_message m
     WHERE n.kind = 'message_posted'
       AND m.id = substring(n.event_key FROM length('message_posted:') + 1)::uuid
       AND m.institution_id = n.institution_id AND m.assignment_id = n.target_id
       AND institution.work_relation(n.recipient_id, m.assignment_id)
           = CASE WHEN n.recipient_id = m.owner_id THEN 'student' ELSE 'teacher' END
    UNION ALL
    SELECT s.document_id, s.id
      FROM institution.consultation_slot s
     WHERE n.kind IN ('slot_requested', 'slot_proposed')
       AND s.id = substring(n.event_key FROM length(n.kind) + 2)::uuid
       AND s.institution_id = n.institution_id AND s.assignment_id = n.target_id
       AND institution.work_relation(n.recipient_id, s.assignment_id)
           = CASE n.kind WHEN 'slot_proposed' THEN 'student' ELSE 'teacher' END
       AND (n.kind = 'slot_requested') = (n.recipient_id <> s.student_id)
  ) r
  WHERE n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
    AND n.kind IN ('message_posted', 'slot_requested', 'slot_proposed')
    AND (p_before IS NULL OR (n.created_at, n.id) < (cursor_at, p_before))
  ORDER BY n.created_at DESC, n.id DESC LIMIT 51;
END
$$;
REVOKE ALL ON FUNCTION institution.list_message_slot_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.list_message_slot_notifications(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Forward only, as 20261213100700: a database with a notification of the new kinds cannot go
-- back. A local database is made again with db:up instead.
DO $$
BEGIN
  RAISE EXCEPTION 'SRV-F4-MEN-R10 (20261220310000) does not go down; recreate the local database';
END
$$;
