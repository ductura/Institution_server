-- migrate:up
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Keep the existing metadata and grants. Reminder keys identify an assignment
-- and its effective deadline, so an extension can qualify for a new reminder.
-- squawk-ignore ban-drop-constraint
ALTER TABLE institution.notification DROP CONSTRAINT notification_kind_check, DROP CONSTRAINT notification_check;
ALTER TABLE institution.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('comment_posted', 'assignment_version', 'submission_recorded', 'course_handover', 'deadline_reminder')) NOT VALID,
  ADD CONSTRAINT notification_check CHECK (
    left(event_key, length(kind) + 1) = kind || ':'
    AND substring(event_key FROM length(kind) + 2 FOR 36) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND CASE kind
      WHEN 'assignment_version' THEN substring(event_key FROM length(kind) + 38) ~ '^:[1-9][0-9]{0,9}$'
      WHEN 'deadline_reminder' THEN substring(event_key FROM length(kind) + 38) ~ '^:[0-9]{20}$'
      ELSE length(event_key) = length(kind) + 37
    END
  ) NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.notification VALIDATE CONSTRAINT notification_kind_check;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.notification VALIDATE CONSTRAINT notification_check;

CREATE FUNCTION institution.list_notifications(p_before uuid, p_reminder_seconds integer)
RETURNS TABLE (id uuid, kind text, target_id uuid, created_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  cursor_at timestamptz;
  reminder_at timestamptz;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_before IS NOT NULL THEN
    SELECT n.created_at INTO cursor_at FROM institution.notification n
    WHERE n.id = p_before AND n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403'; END IF;
  -- The API runs at READ COMMITTED. Skip generation under contention or when a
  -- different isolation level could hold a snapshot older than the lock.
  ELSIF current_setting('transaction_isolation') = 'read committed'
    AND pg_try_advisory_xact_lock(hashtextextended('institution.deadline_reminder:' || actor.user_id, 0)) THEN
    reminder_at := clock_timestamp();
    IF NOT EXISTS (
      SELECT 1 FROM institution.notification n
      WHERE n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
        AND n.kind = 'deadline_reminder'
        AND n.created_at > reminder_at - make_interval(secs => greatest(300, p_reminder_seconds))
    ) THEN
      WITH eligible AS MATERIALIZED (
        SELECT a.id, r.role, institution.effective_due_at(a.id,
          CASE WHEN r.role = 'student' THEN actor.user_id END) AS due_at
        FROM institution.assignment a
        JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
        CROSS JOIN LATERAL (SELECT institution.work_relation(actor.user_id, a.id) AS role) r
        WHERE a.institution_id = actor.institution_id AND v.opens_at <= reminder_at
          AND r.role IN ('student', 'teacher')
      ), candidates AS (
        SELECT e.id, e.due_at, 'deadline_reminder:' || e.id || ':' ||
          to_char(e.due_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS event_key
        FROM eligible e
        WHERE e.due_at > reminder_at AND e.due_at <= reminder_at + interval '24 hours'
          AND (e.role = 'teacher' OR NOT app.work_submission_requested(e.id, actor.user_id))
      )
      INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id, created_at)
      SELECT actor.institution_id, actor.user_id, 'deadline_reminder', c.event_key, c.id, reminder_at
      FROM candidates c
      WHERE NOT EXISTS (SELECT 1 FROM institution.notification n
        WHERE n.recipient_id = actor.user_id AND n.event_key = c.event_key)
      ORDER BY c.due_at, c.id LIMIT 1
      ON CONFLICT (recipient_id, event_key) DO NOTHING;
    END IF;
  END IF;

  RETURN QUERY
  SELECT n.id, n.kind, n.target_id, n.created_at, n.read_at FROM institution.notification n
  WHERE n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
    AND (p_before IS NULL OR (n.created_at, n.id) < (cursor_at, p_before))
  ORDER BY n.created_at DESC, n.id DESC LIMIT 51;
END
$$;

CREATE FUNCTION institution.read_notification(p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  UPDATE institution.notification n SET read_at = clock_timestamp()
  WHERE n.id = p_id AND n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
    AND n.read_at IS NULL;
  RETURN FOUND OR EXISTS (SELECT 1 FROM institution.notification n
    WHERE n.id = p_id AND n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id);
END
$$;

REVOKE ALL ON FUNCTION institution.list_notifications(uuid, integer), institution.read_notification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.list_notifications(uuid, integer), institution.read_notification(uuid) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.read_notification(uuid);
DROP FUNCTION institution.list_notifications(uuid, integer);
DELETE FROM institution.notification WHERE kind = 'deadline_reminder';
ALTER TABLE institution.notification DROP CONSTRAINT notification_kind_check, DROP CONSTRAINT notification_check;
ALTER TABLE institution.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('comment_posted', 'assignment_version', 'submission_recorded', 'course_handover')),
  ADD CONSTRAINT notification_check CHECK (
    event_key ~ '^(comment_posted|assignment_version|submission_recorded|course_handover):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[1-9][0-9]{0,9})?$'
    AND event_key LIKE kind || ':%'
    AND (kind = 'assignment_version') = (event_key ~ ':[1-9][0-9]{0,9}$')
  );
SET LOCAL ROLE ductus_migrator;
