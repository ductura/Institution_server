-- migrate:up
-- SRV-MENTOR-1 mentorstvo-otvaranje-termini (Ductus#2055; owner decisions of
-- 23 Nov 2026 for NF-6: MK-7, MK-3, MK-10, MK-5). Four additions, each
-- additive next to what exists:
--
-- (a) MK-7: the teacher opens a mentorship for a student (kind of work and an
--     optional topic). The mentorship, its assignment and the first version
--     come into being in one transaction, as an approved request makes them
--     (20261121090000), and the student gets one notification of the new kind
--     'mentorship_opened'. institution.mentorship_opening keeps who opened it
--     and the topic; it is never changed. The student's request
--     (20261104090000) stays as it is.
--
--       app.open_mentorship                    the teacher opens one
--       app.student_mentorships                the student's open mentorships,
--                                              with the mentor's name pair
--       institution.list_mentorship_notifications  the caller's own
--                                              'mentorship_opened' rows
--
-- (b) MK-3: a consultation slot gains a topic and three closing moves, each
--     with an optional reason: the student withdraws a request the teacher has
--     not answered (withdrawn), the teacher declines a request (declined), and
--     either side cancels a countered or confirmed slot that lies ahead
--     (cancelled). The older read institution.consultation_slots answers only
--     the three states its contract knows, so its clients never meet a new one.
--
-- (c) MK-10: the student may attach a preparation to a request: a text of up
--     to 4000 characters and two counts (changed paragraphs, resolved
--     comments). It is a record of input, not of authorship. Only the student
--     who owns the work and the teacher of the work read it.
--
--       institution.request_consultation_slot_detail  request with topic and
--                                              preparation
--       institution.close_consultation_slot    withdraw, decline, cancel
--       institution.consultation_slot_details  every slot of the work with
--                                              topic, closing and preparation
--
-- (d) MK-5: the agreed tasks of a consultation record, at most 20 a record,
--     written and marked done or not done only by the teacher of the work
--     (the mentor); the student reads them. A task is never changed or
--     deleted: a mark is a new row and the last mark is the state. The record
--     and its additions follow the same decision (1): from here only the
--     teacher of the work writes them, the student reads.
--
-- Access always comes from the caller's relation to the work or the
-- mentorship (C-23), never from a role alone. Errors carry no input: ZD401
-- no session, ZD403 not allowed (also for what does not exist), ZD409 the
-- state forbids it, ZD422 invalid input, ZD503 the faculty has no rule for
-- the kind of work.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- (a) -----------------------------------------------------------------------

CREATE TABLE institution.mentorship_opening (
  mentorship_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  student_id uuid NOT NULL,
  topic text CHECK (topic IS NULL OR collaboration.is_consultation_text(topic, 1, 300)),
  opened_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (mentorship_id, institution_id) REFERENCES institution.mentorship (id, institution_id),
  FOREIGN KEY (teacher_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX mentorship_opening_student_idx ON institution.mentorship_opening (student_id);
CREATE INDEX mentorship_opening_teacher_idx ON institution.mentorship_opening (teacher_id);
ALTER TABLE institution.mentorship_opening ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.mentorship_opening FORCE ROW LEVEL SECURITY;
CREATE POLICY mentorship_opening_owner ON institution.mentorship_opening TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE TRIGGER mentorship_opening_immutable BEFORE UPDATE OR DELETE ON institution.mentorship_opening
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_change();
CREATE TRIGGER mentorship_opening_no_truncate BEFORE TRUNCATE ON institution.mentorship_opening
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_change();

-- squawk-ignore ban-drop-constraint
ALTER TABLE institution.notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE institution.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('comment_posted', 'assignment_version', 'submission_recorded', 'course_handover',
                  'deadline_reminder', 'returned_for_revision', 'mentorship_opened')) NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.notification VALIDATE CONSTRAINT notification_kind_check;

-- The confirmed, unrevoked teacher opens a mentorship of a kind for a student
-- of the own institution: an account that is not the caller and holds no
-- confirmed teacher role. The faculty's rule for the kind must exist. Returns
-- the mentorship. ZD409 when the student already has an open one of the kind.
CREATE FUNCTION app.open_mentorship(p_student_id uuid, p_work_type text, p_topic text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  work_rule institution.faculty_work_rule;
  v_mentorship uuid;
  v_assignment uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.lock_teacher_role(actor.user_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_work_type IS NULL
     OR p_work_type NOT IN ('bachelor_thesis', 'master_thesis', 'specialist_thesis', 'doctoral_thesis')
     OR (p_topic IS NOT NULL AND NOT coalesce(collaboration.is_consultation_text(p_topic, 1, 300), false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_student_id IS NULL OR p_student_id = actor.user_id
     OR NOT EXISTS (SELECT 1 FROM identity.user_account u
                    WHERE u.id = p_student_id AND u.institution_id = actor.institution_id)
     OR EXISTS (SELECT 1 FROM institution.institution_role r
                WHERE r.institution_id = actor.institution_id AND r.user_id = p_student_id
                  AND r.role = 'teacher' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The lock of request_mentorship and of an approval: one decision about a
  -- student's kind of work at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'institution.mentorship_request:' || actor.institution_id || ':' || p_student_id || ':' || p_work_type, 0));
  IF EXISTS (SELECT 1 FROM institution.mentorship m
             WHERE m.institution_id = actor.institution_id AND m.student_id = p_student_id
               AND m.work_type = p_work_type AND m.ended_at IS NULL) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  SELECT * INTO work_rule FROM institution.faculty_work_rule r
  WHERE r.institution_id = actor.institution_id AND r.work_type = p_work_type
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not set up' USING ERRCODE = 'ZD503';
  END IF;

  INSERT INTO institution.mentorship (institution_id, mentor_id, student_id, work_type, confirmed_by)
  VALUES (actor.institution_id, actor.user_id, p_student_id, p_work_type, actor.user_id)
  RETURNING id INTO v_mentorship;
  INSERT INTO institution.mentorship_opening (mentorship_id, institution_id, teacher_id, student_id, topic)
  VALUES (v_mentorship, actor.institution_id, actor.user_id, p_student_id, p_topic);
  INSERT INTO institution.assignment (institution_id, mentorship_id, created_by)
  VALUES (actor.institution_id, v_mentorship, actor.user_id)
  RETURNING id INTO v_assignment;
  INSERT INTO institution.assignment_version (
    assignment_id, version_no, title, instructions, work_type, opens_at, due_at,
    ai_policy, ai_purposes, evidence_profile, import_allowed, created_by
  ) VALUES (
    v_assignment, 1,
    CASE p_work_type
      WHEN 'bachelor_thesis' THEN 'Završni rad'
      WHEN 'master_thesis' THEN 'Diplomski rad'
      WHEN 'specialist_thesis' THEN 'Specijalistički rad'
      WHEN 'doctoral_thesis' THEN 'Doktorski rad'
    END,
    '', p_work_type, now(), now() + interval '365 days',
    work_rule.ai_policy, work_rule.ai_purposes, work_rule.evidence_profile, work_rule.import_allowed, actor.user_id
  );
  INSERT INTO institution.notification (institution_id, recipient_id, kind, event_key, target_id)
  VALUES (actor.institution_id, p_student_id, 'mentorship_opened', 'mentorship_opened:' || v_mentorship, v_mentorship)
  ON CONFLICT (recipient_id, event_key) DO NOTHING;
  RETURN v_mentorship;
END
$$;

-- The caller's open mentorships as their student, newest first, with the
-- mentor's name pair, the assignment, the topic of an opening and who began
-- it ('teacher' for an opening, 'request' for an approved request). A caller
-- with a confirmed teacher role is refused, as the other student reads.
CREATE FUNCTION app.student_mentorships()
RETURNS TABLE (
  mentorship_id uuid, assignment_id uuid, work_type text, topic text, mentor_id uuid,
  given_name text, family_name text, started_at timestamptz, opened_by text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_has_role('teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
  SELECT m.id, a.id, m.work_type, o.topic, m.mentor_id, n.given_name, n.family_name, m.started_at,
         CASE WHEN o.mentorship_id IS NULL THEN 'request' ELSE 'teacher' END
  FROM institution.mentorship m
  LEFT JOIN institution.assignment a ON a.mentorship_id = m.id AND a.institution_id = m.institution_id
  LEFT JOIN institution.mentorship_opening o ON o.mentorship_id = m.id AND o.institution_id = m.institution_id
  LEFT JOIN identity.person_name n ON n.institution_id = m.institution_id AND n.user_id = m.mentor_id
  WHERE m.institution_id = actor.institution_id AND m.student_id = actor.user_id AND m.ended_at IS NULL
  ORDER BY m.started_at DESC, m.id;
END
$$;

-- The caller's own 'mentorship_opened' notifications, newest first, at most
-- 51 (a page of 50 and one to tell there is more), with what the student may
-- read of the mentorship: kind, topic and the mentor's name pair.
CREATE FUNCTION institution.list_mentorship_notifications(p_before uuid)
RETURNS TABLE (
  id uuid, mentorship_id uuid, work_type text, topic text, given_name text, family_name text,
  created_at timestamptz, read_at timestamptz
)
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
      AND n.kind = 'mentorship_opened';
    IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403'; END IF;
  END IF;
  RETURN QUERY
  SELECT n.id, m.id, m.work_type, o.topic, p.given_name, p.family_name, n.created_at, n.read_at
  FROM institution.notification n
  JOIN institution.mentorship m ON m.id = n.target_id AND m.institution_id = n.institution_id
   AND m.student_id = n.recipient_id
  LEFT JOIN institution.mentorship_opening o ON o.mentorship_id = m.id AND o.institution_id = m.institution_id
  LEFT JOIN identity.person_name p ON p.institution_id = m.institution_id AND p.user_id = m.mentor_id
  WHERE n.recipient_id = actor.user_id AND n.institution_id = actor.institution_id
    AND n.kind = 'mentorship_opened'
    AND (p_before IS NULL OR (n.created_at, n.id) < (cursor_at, p_before))
  ORDER BY n.created_at DESC, n.id DESC LIMIT 51;
END
$$;

REVOKE ALL ON FUNCTION app.open_mentorship(uuid, text, text), app.student_mentorships(),
  institution.list_mentorship_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.open_mentorship(uuid, text, text), app.student_mentorships(),
  institution.list_mentorship_notifications(uuid) TO ductus_app;

-- (b) and (c) ---------------------------------------------------------------

-- Nullable columns and a wider check rewrite no row; every existing row
-- keeps its state and has no topic, closing or preparation.
ALTER TABLE institution.consultation_slot
  ADD COLUMN topic text CHECK (topic IS NULL OR collaboration.is_consultation_text(topic, 1, 200)),
  ADD COLUMN closed_by text CHECK (closed_by IN ('student', 'teacher')),
  ADD COLUMN closed_reason text CHECK (closed_reason IS NULL OR collaboration.is_consultation_text(closed_reason, 1, 600)),
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN preparation_text text
    CHECK (preparation_text IS NULL OR collaboration.is_consultation_text(preparation_text, 1, 4000)),
  ADD COLUMN preparation_changed_paragraphs integer CHECK (preparation_changed_paragraphs BETWEEN 0 AND 100000),
  ADD COLUMN preparation_resolved_comments integer CHECK (preparation_resolved_comments BETWEEN 0 AND 100000),
  ADD CONSTRAINT consultation_slot_preparation_whole CHECK (
    num_nonnulls(preparation_text, preparation_changed_paragraphs, preparation_resolved_comments) IN (0, 3)),
  ADD CONSTRAINT consultation_slot_closed_whole CHECK (
    (state IN ('withdrawn', 'declined', 'cancelled')) = (closed_by IS NOT NULL AND closed_at IS NOT NULL)
    AND (closed_reason IS NULL OR closed_by IS NOT NULL)) NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.consultation_slot VALIDATE CONSTRAINT consultation_slot_closed_whole;
-- squawk-ignore ban-drop-constraint
ALTER TABLE institution.consultation_slot DROP CONSTRAINT consultation_slot_state_check;
ALTER TABLE institution.consultation_slot ADD CONSTRAINT consultation_slot_state_check
  CHECK (state IN ('requested', 'countered', 'confirmed', 'withdrawn', 'declined', 'cancelled')) NOT VALID;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.consultation_slot VALIDATE CONSTRAINT consultation_slot_state_check;

-- As 20261121102000, answering only the three states of its contract: a
-- closed slot is left out, so its clients never meet a state they do not know.
CREATE OR REPLACE FUNCTION institution.consultation_slots(p_document_id text)
RETURNS TABLE (id uuid, starts_at timestamptz, proposed_at timestamptz, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_scope record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT s.id, s.starts_at, s.proposed_at, s.state
      FROM institution.consultation_slot s
     WHERE s.institution_id = v_scope.institution_id AND s.document_id = p_document_id
       AND s.state IN ('requested', 'countered', 'confirmed')
     ORDER BY s.starts_at, s.id;
END
$$;

-- The one insert of a request, for both request functions: the caller must
-- be the student who owns the work (ZD403 otherwise). The institution, the
-- assignment and the student come from the work. Not callable by the web role.
CREATE FUNCTION institution.insert_consultation_slot(
  p_document_id text, p_starts_at timestamptz,
  p_topic text, p_preparation_text text, p_changed_paragraphs integer, p_resolved_comments integer
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_scope record;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id)
       IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at <= statement_timestamp()
     OR p_starts_at > statement_timestamp() + interval '1 year'
     OR (p_topic IS NOT NULL AND NOT coalesce(collaboration.is_consultation_text(p_topic, 1, 200), false))
     OR num_nonnulls(p_preparation_text, p_changed_paragraphs, p_resolved_comments) NOT IN (0, 3)
     OR (p_preparation_text IS NOT NULL
         AND (NOT coalesce(collaboration.is_consultation_text(p_preparation_text, 1, 4000), false)
              OR p_changed_paragraphs NOT BETWEEN 0 AND 100000
              OR p_resolved_comments NOT BETWEEN 0 AND 100000)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One writer per work at a time, so the bound below holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('consultation_slot:' || v_scope.institution_id || ':' || p_document_id, 0));
  IF (SELECT count(*) FROM institution.consultation_slot s
       WHERE s.institution_id = v_scope.institution_id AND s.document_id = p_document_id
         AND s.state IN ('requested', 'countered')) >= 20 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.consultation_slot AS s
    (institution_id, document_id, assignment_id, student_id, starts_at, state, topic,
     preparation_text, preparation_changed_paragraphs, preparation_resolved_comments)
  VALUES (v_scope.institution_id, p_document_id, v_scope.assignment_id, v_scope.principal_id, p_starts_at,
          'requested', p_topic,
          p_preparation_text, p_changed_paragraphs, p_resolved_comments)
  RETURNING s.id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION institution.insert_consultation_slot(text, timestamptz, text, text, integer, integer) FROM PUBLIC;

-- As 20261121102000; a closed slot no longer counts towards the 20 open ones.
CREATE OR REPLACE FUNCTION institution.request_consultation_slot(p_document_id text, p_starts_at timestamptz)
RETURNS TABLE (id uuid, starts_at timestamptz, proposed_at timestamptz, state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  v_id := institution.insert_consultation_slot(p_document_id, p_starts_at, NULL, NULL, NULL, NULL);
  RETURN QUERY SELECT s.id, s.starts_at, s.proposed_at, s.state FROM institution.consultation_slot s WHERE s.id = v_id;
END
$$;

-- Every slot of the work, closed ones included, by time and id, with the
-- topic, the closing and the preparation. For the student who owns the work
-- and the teacher of the work only.
CREATE FUNCTION institution.consultation_slot_details(p_document_id text)
RETURNS TABLE (
  id uuid, starts_at timestamptz, proposed_at timestamptz, state text, topic text,
  closed_by text, closed_reason text, closed_at timestamptz,
  preparation_text text, preparation_changed_paragraphs integer, preparation_resolved_comments integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_scope record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT s.id, s.starts_at, s.proposed_at, s.state, s.topic, s.closed_by, s.closed_reason, s.closed_at,
           s.preparation_text, s.preparation_changed_paragraphs, s.preparation_resolved_comments
      FROM institution.consultation_slot s
     WHERE s.institution_id = v_scope.institution_id AND s.document_id = p_document_id
     ORDER BY s.starts_at, s.id;
END
$$;

-- The student of the work asks for a time, with an optional topic and an
-- optional preparation (text and both counts together, or none).
CREATE FUNCTION institution.request_consultation_slot_detail(
  p_document_id text, p_starts_at timestamptz, p_topic text,
  p_preparation_text text, p_changed_paragraphs integer, p_resolved_comments integer
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN institution.insert_consultation_slot(p_document_id, p_starts_at, p_topic,
                                              p_preparation_text, p_changed_paragraphs, p_resolved_comments);
END
$$;

-- The closing moves, each with an optional reason (1 to 600 characters):
--
--   action    by                 from                  to
--   withdraw  student            requested             withdrawn
--   decline   teacher            requested             declined
--   cancel    student, teacher   countered, confirmed  cancelled   (only while startsAt lies ahead)
--
-- A person of the wrong role reads as one without relation (ZD403); a state
-- that does not allow the move is ZD409. Returns the slot id.
CREATE FUNCTION institution.close_consultation_slot(p_document_id text, p_slot_id uuid, p_action text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_scope record;
  v_role text;
  v_slot institution.consultation_slot;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('withdraw', 'decline', 'cancel')
     OR (p_reason IS NOT NULL AND NOT coalesce(collaboration.is_consultation_text(p_reason, 1, 600), false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_slot FROM institution.consultation_slot s
   WHERE s.id = p_slot_id AND s.institution_id = v_scope.institution_id AND s.document_id = p_document_id
   FOR UPDATE;
  IF v_slot.id IS NULL
     OR (p_action = 'withdraw' AND v_role <> 'student')
     OR (p_action = 'decline' AND v_role <> 'teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF (p_action IN ('withdraw', 'decline') AND v_slot.state <> 'requested')
     OR (p_action = 'cancel' AND (v_slot.state NOT IN ('countered', 'confirmed')
                                  OR v_slot.starts_at <= statement_timestamp())) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.consultation_slot AS s
     SET state = CASE p_action WHEN 'withdraw' THEN 'withdrawn' WHEN 'decline' THEN 'declined' ELSE 'cancelled' END,
         closed_by = v_role, closed_reason = p_reason, closed_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE s.id = v_slot.id;
  RETURN v_slot.id;
END
$$;

REVOKE ALL ON FUNCTION institution.consultation_slot_details(text),
  institution.request_consultation_slot_detail(text, timestamptz, text, text, integer, integer),
  institution.close_consultation_slot(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.consultation_slot_details(text),
  institution.request_consultation_slot_detail(text, timestamptz, text, text, integer, integer),
  institution.close_consultation_slot(text, uuid, text, text) TO ductus_app;

-- (d) -----------------------------------------------------------------------

CREATE TABLE collaboration.consultation_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  body text NOT NULL CHECK (collaboration.is_consultation_text(body, 1, 500)),
  author_id uuid NOT NULL,
  -- clock_timestamp: rows made in one transaction still keep the order they were made in.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, institution_id),
  UNIQUE (record_id, position),
  FOREIGN KEY (record_id, institution_id) REFERENCES collaboration.consultation_record (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

-- A mark says the task is done or not done from its moment on; the newest
-- mark is the state. Marks are only added.
CREATE TABLE collaboration.consultation_task_mark (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  done boolean NOT NULL,
  author_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id, institution_id) REFERENCES collaboration.consultation_task (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX consultation_task_mark_task_idx ON collaboration.consultation_task_mark (task_id, created_at DESC, id DESC);

ALTER TABLE collaboration.consultation_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.consultation_task FORCE ROW LEVEL SECURITY;
ALTER TABLE collaboration.consultation_task_mark ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.consultation_task_mark FORCE ROW LEVEL SECURITY;
CREATE POLICY consultation_task_owner ON collaboration.consultation_task TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY consultation_task_mark_owner ON collaboration.consultation_task_mark TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE FUNCTION collaboration.refuse_consultation_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'a consultation record is only added to' USING ERRCODE = 'ZD403';
END
$$;
REVOKE ALL ON FUNCTION collaboration.refuse_consultation_change() FROM PUBLIC;
CREATE TRIGGER consultation_task_append_only BEFORE UPDATE OR DELETE ON collaboration.consultation_task
  FOR EACH ROW EXECUTE FUNCTION collaboration.refuse_consultation_change();
CREATE TRIGGER consultation_task_no_truncate BEFORE TRUNCATE ON collaboration.consultation_task
  FOR EACH STATEMENT EXECUTE FUNCTION collaboration.refuse_consultation_change();
CREATE TRIGGER consultation_task_mark_append_only BEFORE UPDATE OR DELETE ON collaboration.consultation_task_mark
  FOR EACH ROW EXECUTE FUNCTION collaboration.refuse_consultation_change();
CREATE TRIGGER consultation_task_mark_no_truncate BEFORE TRUNCATE ON collaboration.consultation_task_mark
  FOR EACH STATEMENT EXECUTE FUNCTION collaboration.refuse_consultation_change();

-- The caller's relation to a work, as the record functions decide it; ZD403
-- for none, for a malformed and for an unknown work.
CREATE FUNCTION collaboration.consultation_relation(p_document_id text,
  OUT role text, OUT institution_id uuid, OUT user_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  role := collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id);
  IF scope.institution_id IS NULL OR role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  institution_id := scope.institution_id;
  user_id := actor.user_id;
END
$$;
REVOKE ALL ON FUNCTION collaboration.consultation_relation(text) FROM PUBLIC;

-- The agreed tasks of every record of the work, by record and position, each
-- with its newest mark. The same rows for the student and the teacher.
CREATE FUNCTION collaboration.list_consultation_tasks(p_document_id text)
RETURNS TABLE (id uuid, record_id uuid, task_position smallint, body text, done boolean,
               marked_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rel record;
BEGIN
  SELECT * INTO rel FROM collaboration.consultation_relation(p_document_id);
  RETURN QUERY
    SELECT t.id, t.record_id, t.position, t.body, coalesce(m.done, false),
           pg_catalog.date_trunc('minute', m.created_at, 'UTC'),
           pg_catalog.date_trunc('minute', t.created_at, 'UTC')
      FROM collaboration.consultation_task t
      JOIN collaboration.consultation_record r ON r.id = t.record_id AND r.institution_id = t.institution_id
      LEFT JOIN LATERAL (
        SELECT k.done, k.created_at FROM collaboration.consultation_task_mark k
         WHERE k.task_id = t.id AND k.institution_id = t.institution_id
         ORDER BY k.created_at DESC, k.id DESC LIMIT 1
      ) m ON true
     WHERE r.document_id = p_document_id AND r.institution_id = rel.institution_id
     ORDER BY r.held_on, r.created_at, r.id, t.position;
END
$$;

-- The teacher of the work adds a task to a record of the work; at most 20 a
-- record (ZD422). Returns the task id.
CREATE FUNCTION collaboration.add_consultation_task(p_document_id text, p_record_id uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rel record;
  r record;
  v_position integer;
  v_id uuid;
BEGIN
  SELECT * INTO rel FROM collaboration.consultation_relation(p_document_id);
  IF rel.role <> 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT c.id, c.institution_id INTO r FROM collaboration.consultation_record c
   WHERE c.id = p_record_id AND c.document_id = p_document_id AND c.institution_id = rel.institution_id
   FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_consultation_text(p_body, 1, 500), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT count(*) + 1 INTO v_position FROM collaboration.consultation_task t
   WHERE t.record_id = r.id AND t.institution_id = r.institution_id;
  IF v_position > 20 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.consultation_task (record_id, institution_id, position, body, author_id)
  VALUES (r.id, r.institution_id, v_position, p_body, rel.user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The teacher of the work marks a task of the work done or not done. A mark
-- equal to the current state adds nothing. Returns the task id.
CREATE FUNCTION collaboration.mark_consultation_task(p_document_id text, p_task_id uuid, p_done boolean)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rel record;
  t record;
  v_current boolean;
BEGIN
  SELECT * INTO rel FROM collaboration.consultation_relation(p_document_id);
  IF rel.role <> 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT k.id, k.institution_id INTO t FROM collaboration.consultation_task k
   JOIN collaboration.consultation_record c ON c.id = k.record_id AND c.institution_id = k.institution_id
   WHERE k.id = p_task_id AND c.document_id = p_document_id AND k.institution_id = rel.institution_id
   FOR UPDATE OF k;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_done IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT k.done INTO v_current FROM collaboration.consultation_task_mark k
   WHERE k.task_id = t.id AND k.institution_id = t.institution_id
   ORDER BY k.created_at DESC, k.id DESC LIMIT 1;
  IF coalesce(v_current, false) IS DISTINCT FROM p_done THEN
    INSERT INTO collaboration.consultation_task_mark (task_id, institution_id, done, author_id)
    VALUES (t.id, t.institution_id, p_done, rel.user_id);
  END IF;
  RETURN t.id;
END
$$;

REVOKE ALL ON FUNCTION collaboration.list_consultation_tasks(text),
  collaboration.add_consultation_task(text, uuid, text),
  collaboration.mark_consultation_task(text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_consultation_tasks(text),
  collaboration.add_consultation_task(text, uuid, text),
  collaboration.mark_consultation_task(text, uuid, boolean) TO ductus_app;

-- Decision (1): the record and its additions are written by the teacher of
-- the work only; the student reads them. As 20261121103000 otherwise.
CREATE OR REPLACE FUNCTION collaboration.create_consultation_record(
  p_document_id text, p_held_on date, p_revision bigint, p_topic text, p_agreement text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_id uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id)
          IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_held_on IS NULL OR p_revision IS NULL OR p_revision < 1
     OR NOT coalesce(collaboration.is_consultation_text(p_topic, 1, 200), false)
     OR NOT coalesce(collaboration.is_consultation_text(p_agreement, 0, 2000), false)
     OR NOT collaboration.consultation_revision_exists(p_document_id, p_revision) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.consultation_record
    (institution_id, document_id, assignment_id, owner_id, held_on, revision, topic, agreement, created_by)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id,
          p_held_on, p_revision, p_topic, p_agreement, actor.user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION collaboration.add_consultation_addition(p_document_id text, p_record_id uuid, p_body text)
RETURNS TABLE (addition_id uuid, addition_minute timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  r record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id)
          IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- A record of another work reads as a missing one, whoever asks.
  SELECT c.id, c.institution_id INTO r FROM collaboration.consultation_record c
   WHERE c.id = p_record_id AND c.document_id = p_document_id AND c.institution_id = scope.institution_id;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_consultation_text(p_body, 1, 2000), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.consultation_addition (record_id, institution_id, body, author_id)
    VALUES (r.id, r.institution_id, p_body, actor.user_id)
    RETURNING consultation_addition.id, pg_catalog.date_trunc('minute', consultation_addition.created_at, 'UTC');
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Forward only, as 20261213100700: a database with a notification of the new
-- kind or a closed slot cannot go back. A local database is made again with
-- db:up instead.
DO $$
BEGIN
  RAISE EXCEPTION 'SRV-MENTOR-1 (20261215100000) does not go down; recreate the local database';
END
$$;
