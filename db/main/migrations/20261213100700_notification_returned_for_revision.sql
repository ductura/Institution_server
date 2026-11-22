-- migrate:up
-- SRV-1607 (Ductus#2052): the student is told when the teacher returns the work for
-- revision (SRV-1606, evidence.submission_return).
--
-- The notification is written by a trigger on evidence.submission_return, so it commits
-- or rolls back with the return itself: one notification per return (event_key carries
-- the return id, UNIQUE (recipient_id, event_key)), none when the return is refused.
-- The recipient is the student owner of the submission, nobody else.
--
-- institution.notification stores identifiers only (D1): kind, the assignment as
-- target, the key of the return. The work, the teacher's comment and the new due date
-- are read from the return itself, with the caller's own rights (RLS of
-- evidence.submission_return: only the owner reads), never copied into the inbox.
--
-- Contract: the kind is NOT added to notifications.list.get (a wider response enum
-- breaks clients, contracts:breaking). That list leaves these rows out in the HTTP
-- adapter; app clients read them from notifications.returned-for-revision.list.get, a
-- new route (a new minor version). Reading uses the existing notifications.read.post.
--
--   institution.list_revision_notifications   the caller's own, newest first
--   app.notify_work_returned                   the insert, for the evidence role
--   app.notify_submission_return               the trigger function
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
SET LOCAL ROLE ductus_identity;

-- squawk-ignore ban-drop-constraint
ALTER TABLE institution.notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE institution.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('comment_posted', 'assignment_version', 'submission_recorded', 'course_handover',
                  'deadline_reminder', 'returned_for_revision')) NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.notification VALIDATE CONSTRAINT notification_kind_check;

-- The kind's key is the return id; the shape check of every other kind stays as it is
-- (ELSE: kind, colon, one UUID).
CREATE FUNCTION app.notify_work_returned(p_return uuid, p_student uuid, p_assignment uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id)
  SELECT a.institution_id, p_student, 'returned_for_revision', 'returned_for_revision:' || p_return, a.id
  FROM institution.assignment a
  WHERE a.id = p_assignment
    AND institution.work_relation(p_student, a.id) = 'student'
  ON CONFLICT (recipient_id, event_key) DO NOTHING
$$;
REVOKE ALL ON FUNCTION app.notify_work_returned(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notify_work_returned(uuid, uuid, uuid) TO ductus_evidence;

CREATE FUNCTION institution.list_revision_notifications(p_before uuid)
RETURNS TABLE (id uuid, return_id uuid, target_id uuid, created_at timestamptz, read_at timestamptz)
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
      AND n.kind = 'returned_for_revision';
    IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403'; END IF;
  END IF;
  RETURN QUERY
  SELECT n.id, substring(n.event_key FROM length('returned_for_revision:') + 1)::uuid,
         n.target_id, n.created_at, n.read_at
  FROM institution.notification n
  WHERE n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
    AND n.kind = 'returned_for_revision'
    AND (p_before IS NULL OR (n.created_at, n.id) < (cursor_at, p_before))
  ORDER BY n.created_at DESC, n.id DESC LIMIT 51;
END
$$;
REVOKE ALL ON FUNCTION institution.list_revision_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.list_revision_notifications(uuid) TO ductus_app;

SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION app.notify_submission_return() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM app.notify_work_returned(NEW.id, NEW.principal_id, NEW.assignment_id);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.notify_submission_return() FROM PUBLIC;
CREATE TRIGGER submission_return_notify AFTER INSERT ON evidence.submission_return
  FOR EACH ROW EXECUTE FUNCTION app.notify_submission_return();

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
-- Forward only, as SRV-1606 (20261213100600): a database with a returned submission
-- cannot go back. A local database is made again with db:up instead.
DO $$
BEGIN
  RAISE EXCEPTION 'SRV-1607 (20261213100700) does not go down; recreate the local database';
END
$$;
