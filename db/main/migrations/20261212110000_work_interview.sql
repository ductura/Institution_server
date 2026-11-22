-- migrate:up
-- SRV-1530 (Ductus#2052; N-14 "Priprema za razgovor", M7): the interview
-- preparation of a work. The teacher or mentor of the work prepares questions
-- (about a paragraph of the work or general ones), invites the student, and
-- notes the appointment and that the interview was held. The student answers
-- with explanations. Everything the teacher side sees after the invitation the
-- student sees too (PRODUCT §5, D-249).
--
-- There is no column for an outcome, a grade, a sanction or a suspicion, and
-- none can be added through these functions: the interview is a preparation,
-- not a proceeding.
--
-- Visibility of the questions:
--   before the invitation   only the author of a question reads it; a question
--                           of a draft older than work_interview_draft_days()
--                           is no longer read and is deleted by the next write
--                           to that interview (O1: 30 days without an
--                           invitation, one constant)
--   from the invitation     the teacher side and the student who owns the work
--
-- Access comes from the caller's relation to the work (collaboration.actor_role:
-- the teacher or mentor of its assignment, or the student who owns it), never
-- from a role alone (C-23). Errors carry no input: ZD401 no session, ZD403 no
-- relation, wrong role, a student before the invitation, or an unknown work,
-- question or slot (one answer for all), ZD409 a state that does not allow the
-- action, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.work_interview_draft_days() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 30 $$;

CREATE TABLE institution.work_interview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (char_length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  created_by uuid NOT NULL,
  consultation_slot_id uuid,
  place text CHECK (place IS NULL OR char_length(place) BETWEEN 1 AND 200),
  at timestamptz,
  invited_at timestamptz,
  held_on date,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, institution_id),
  UNIQUE (institution_id, document_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (consultation_slot_id, institution_id) REFERENCES institution.consultation_slot (id, institution_id),
  -- a slot or a free place and time, never both
  CHECK (consultation_slot_id IS NULL OR (place IS NULL AND at IS NULL)),
  CHECK ((place IS NULL) = (at IS NULL)),
  CHECK (held_on IS NULL OR invited_at IS NOT NULL)
);
CREATE INDEX work_interview_student_idx ON institution.work_interview (student_id);
CREATE INDEX work_interview_assignment_idx ON institution.work_interview (assignment_id, institution_id);

CREATE TABLE institution.work_interview_question (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  interview_id uuid NOT NULL,
  author_id uuid NOT NULL,
  paragraph_ref text CHECK (paragraph_ref IS NULL OR char_length(paragraph_ref) BETWEEN 1 AND 256),
  question_text text NOT NULL CHECK (collaboration.is_comment_body(question_text)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, institution_id),
  FOREIGN KEY (interview_id, institution_id) REFERENCES institution.work_interview (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_interview_question_interview_idx ON institution.work_interview_question (interview_id, created_at, id);

CREATE TABLE institution.work_interview_explanation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  interview_id uuid NOT NULL,
  question_id uuid,
  explanation_text text NOT NULL CHECK (collaboration.is_comment_body(explanation_text)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (interview_id, institution_id) REFERENCES institution.work_interview (id, institution_id),
  FOREIGN KEY (question_id, institution_id) REFERENCES institution.work_interview_question (id, institution_id)
);
CREATE INDEX work_interview_explanation_interview_idx ON institution.work_interview_explanation (interview_id, created_at, id);

-- The trail: invitation sent, appointment set, interview held.
CREATE TABLE audit.work_interview_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  interview_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invited', 'scheduled', 'held')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (interview_id, institution_id) REFERENCES institution.work_interview (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_interview_event_interview_idx ON audit.work_interview_event (interview_id, occurred_at);
CREATE TRIGGER work_interview_event_append_only BEFORE UPDATE OR DELETE ON audit.work_interview_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER work_interview_event_no_truncate BEFORE TRUNCATE ON audit.work_interview_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

ALTER TABLE institution.work_interview ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_interview FORCE ROW LEVEL SECURITY;
CREATE POLICY work_interview_owner ON institution.work_interview TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE institution.work_interview_question ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_interview_question FORCE ROW LEVEL SECURITY;
CREATE POLICY work_interview_question_owner ON institution.work_interview_question TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE institution.work_interview_explanation ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_interview_explanation FORCE ROW LEVEL SECURITY;
CREATE POLICY work_interview_explanation_owner ON institution.work_interview_explanation TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE audit.work_interview_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.work_interview_event FORCE ROW LEVEL SECURITY;
CREATE POLICY work_interview_event_owner ON audit.work_interview_event TO ductus_identity USING (true) WITH CHECK (true);

-- The one place that says what the caller may do with the interview of a work:
-- the role through the relation, the work's scope and the interview row (or
-- none). A person with no relation reads as forbidden.
CREATE FUNCTION institution.work_interview_context(
  p_document_id text, OUT actor_id uuid, OUT role text, OUT institution_id uuid, OUT assignment_id uuid,
  OUT student_id uuid, OUT interview_id uuid, OUT invited boolean
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_scope record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  actor_id := v_actor.user_id;
  institution_id := v_scope.institution_id;
  assignment_id := v_scope.assignment_id;
  student_id := v_scope.principal_id;
  SELECT i.id, i.invited_at IS NOT NULL INTO interview_id, invited
    FROM institution.work_interview i
   WHERE i.institution_id = v_scope.institution_id AND i.document_id = p_document_id;
  invited := coalesce(invited, false);
  IF role = 'student' AND NOT invited THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

-- The preparation as the caller may read it.
CREATE FUNCTION institution.work_interview_read(p_document_id text, p_actor_id uuid, p_role text, p_interview_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'invitedAt', i.invited_at,
    'questions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q.id, 'paragraphRef', q.paragraph_ref, 'questionText', q.question_text,
               'createdAt', q.created_at, 'mine', q.author_id = p_actor_id)
             ORDER BY q.created_at, q.id)
        FROM institution.work_interview_question q
       WHERE q.interview_id = i.id
         AND (i.invited_at IS NOT NULL
              OR (q.author_id = p_actor_id
                  AND q.created_at > statement_timestamp() - make_interval(days => institution.work_interview_draft_days())))
    ), '[]'::jsonb),
    'explanations', CASE WHEN i.invited_at IS NULL THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', e.id, 'questionId', e.question_id, 'text', e.explanation_text, 'createdAt', e.created_at)
             ORDER BY e.created_at, e.id)
        FROM institution.work_interview_explanation e WHERE e.interview_id = i.id
    ), '[]'::jsonb) END,
    'appointment', CASE
      WHEN i.consultation_slot_id IS NOT NULL THEN (
        SELECT jsonb_build_object('consultationSlotId', s.id, 'startsAt', s.starts_at)
          FROM institution.consultation_slot s WHERE s.id = i.consultation_slot_id AND s.institution_id = i.institution_id)
      WHEN i.at IS NOT NULL THEN jsonb_build_object('place', i.place, 'at', i.at)
    END,
    'heldOn', i.held_on)
  FROM institution.work_interview i
  WHERE i.id = p_interview_id
$$;

CREATE FUNCTION institution.work_interview_get(p_document_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.interview_id IS NULL THEN
    RETURN jsonb_build_object('invitedAt', NULL, 'questions', '[]'::jsonb, 'explanations', '[]'::jsonb,
                              'appointment', NULL, 'heldOn', NULL);
  END IF;
  RETURN institution.work_interview_read(p_document_id, c.actor_id, c.role, c.interview_id);
END
$$;

-- The interview row of a work, made by the first question or appointment.
CREATE FUNCTION institution.work_interview_ensure(p_document_id text, c record)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('work_interview:' || c.institution_id || ':' || p_document_id, 0));
  SELECT i.id INTO v_id FROM institution.work_interview i
   WHERE i.institution_id = c.institution_id AND i.document_id = p_document_id;
  IF v_id IS NULL THEN
    INSERT INTO institution.work_interview (institution_id, document_id, assignment_id, student_id, created_by)
    VALUES (c.institution_id, p_document_id, c.assignment_id, c.student_id, c.actor_id)
    RETURNING id INTO v_id;
  END IF;
  -- Drafts older than the limit go with the next write (O1).
  DELETE FROM institution.work_interview_question q
   USING institution.work_interview i
   WHERE q.interview_id = v_id AND i.id = v_id AND i.invited_at IS NULL
     AND q.created_at <= statement_timestamp() - make_interval(days => institution.work_interview_draft_days());
  RETURN v_id;
END
$$;

CREATE FUNCTION institution.add_work_interview_question(p_document_id text, p_paragraph_ref text, p_question_text text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
  v_id uuid;
  v_question institution.work_interview_question;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT collaboration.is_comment_body(p_question_text)
     OR (p_paragraph_ref IS NOT NULL AND (char_length(p_paragraph_ref) NOT BETWEEN 1 AND 256
                                          OR p_paragraph_ref ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_id := institution.work_interview_ensure(p_document_id, c);
  IF (SELECT count(*) FROM institution.work_interview_question q WHERE q.interview_id = v_id) >= 50 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.work_interview_question (institution_id, interview_id, author_id, paragraph_ref, question_text)
  VALUES (c.institution_id, v_id, c.actor_id, p_paragraph_ref, p_question_text)
  RETURNING * INTO v_question;
  RETURN jsonb_build_object('id', v_question.id, 'paragraphRef', v_question.paragraph_ref,
    'questionText', v_question.question_text, 'createdAt', v_question.created_at, 'mine', true);
END
$$;

-- Before the invitation only the author removes a question; after it any
-- teacher of the work does.
CREATE FUNCTION institution.remove_work_interview_question(p_document_id text, p_question_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.role IS DISTINCT FROM 'teacher' OR c.interview_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM institution.work_interview_question q
        WHERE q.id = p_question_id AND q.interview_id = c.interview_id
          AND (c.invited OR q.author_id = c.actor_id)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- An explanation about a removed question stays, as a general one.
  UPDATE institution.work_interview_explanation e SET question_id = NULL
   WHERE e.question_id = p_question_id AND e.interview_id = c.interview_id;
  DELETE FROM institution.work_interview_question q WHERE q.id = p_question_id;
END
$$;

-- The questions become visible to the student from this instant. At least one
-- question must exist; a second invitation is refused.
CREATE FUNCTION institution.invite_work_interview(p_document_id text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.role IS DISTINCT FROM 'teacher' OR c.interview_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM institution.work_interview_ensure(p_document_id, c);
  IF c.invited OR NOT EXISTS (
       SELECT 1 FROM institution.work_interview_question q
        WHERE q.interview_id = c.interview_id AND q.author_id = c.actor_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.work_interview SET invited_at = statement_timestamp() WHERE id = c.interview_id;
  INSERT INTO audit.work_interview_event (institution_id, interview_id, kind, actor_id, occurred_at)
  VALUES (c.institution_id, c.interview_id, 'invited', c.actor_id, statement_timestamp());
  RETURN institution.work_interview_read(p_document_id, c.actor_id, c.role, c.interview_id);
END
$$;

-- The appointment: a consultation slot of the work (the student after the
-- invitation, or the teacher), or a free place and time (the teacher).
CREATE FUNCTION institution.set_work_interview_appointment(
  p_document_id text, p_slot_id uuid, p_place text, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
  v_id uuid;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF (p_slot_id IS NULL) = (p_at IS NULL) OR (p_slot_id IS NOT NULL AND p_place IS NOT NULL)
     OR (p_slot_id IS NULL AND (p_place IS NULL OR char_length(p_place) NOT BETWEEN 1 AND 200 OR p_place ~ '[[:cntrl:]]'
                                OR p_at <= statement_timestamp()
                                OR p_at > statement_timestamp() + interval '1 year')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF c.role = 'student' AND p_slot_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_slot_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM institution.consultation_slot s
        WHERE s.id = p_slot_id AND s.institution_id = c.institution_id AND s.document_id = p_document_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  v_id := institution.work_interview_ensure(p_document_id, c);
  IF (SELECT i.held_on IS NOT NULL FROM institution.work_interview i WHERE i.id = v_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.work_interview
     SET consultation_slot_id = p_slot_id, place = p_place, at = p_at
   WHERE id = v_id;
  INSERT INTO audit.work_interview_event (institution_id, interview_id, kind, actor_id, occurred_at)
  VALUES (c.institution_id, v_id, 'scheduled', c.actor_id, statement_timestamp());
  RETURN institution.work_interview_read(p_document_id, c.actor_id, c.role, v_id);
END
$$;

-- "Razgovor održan": only the date, after the invitation, once. The outcome is
-- not recorded here.
CREATE FUNCTION institution.mark_work_interview_held(p_document_id text, p_date date)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.role IS DISTINCT FROM 'teacher' OR c.interview_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_date IS NULL OR p_date > current_date OR p_date < current_date - 366 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.work_interview i WHERE i.id = c.interview_id FOR UPDATE;
  IF NOT c.invited OR (SELECT i.held_on IS NOT NULL FROM institution.work_interview i WHERE i.id = c.interview_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.work_interview SET held_on = p_date WHERE id = c.interview_id;
  INSERT INTO audit.work_interview_event (institution_id, interview_id, kind, actor_id, occurred_at)
  VALUES (c.institution_id, c.interview_id, 'held', c.actor_id, statement_timestamp());
  RETURN institution.work_interview_read(p_document_id, c.actor_id, c.role, c.interview_id);
END
$$;

-- The student's explanation, general or about one question, after the invitation.
CREATE FUNCTION institution.add_work_interview_explanation(p_document_id text, p_question_id uuid, p_text text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
  v_explanation institution.work_interview_explanation;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT collaboration.is_comment_body(p_text) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_question_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM institution.work_interview_question q
        WHERE q.id = p_question_id AND q.interview_id = c.interview_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.work_interview i WHERE i.id = c.interview_id FOR UPDATE;
  IF (SELECT count(*) FROM institution.work_interview_explanation e WHERE e.interview_id = c.interview_id) >= 100 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.work_interview_explanation (institution_id, interview_id, question_id, explanation_text)
  VALUES (c.institution_id, c.interview_id, p_question_id, p_text)
  RETURNING * INTO v_explanation;
  RETURN jsonb_build_object('id', v_explanation.id, 'questionId', v_explanation.question_id,
    'text', v_explanation.explanation_text, 'createdAt', v_explanation.created_at);
END
$$;

REVOKE ALL ON FUNCTION institution.work_interview_draft_days() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_interview_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_interview_read(text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_interview_ensure(text, record) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_interview_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.add_work_interview_question(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.remove_work_interview_question(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.invite_work_interview(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.set_work_interview_appointment(text, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.mark_work_interview_held(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.add_work_interview_explanation(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.work_interview_get(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.add_work_interview_question(text, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.remove_work_interview_question(text, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.invite_work_interview(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.set_work_interview_appointment(text, uuid, text, timestamptz) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.mark_work_interview_held(text, date) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.add_work_interview_explanation(text, uuid, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.add_work_interview_explanation(text, uuid, text);
DROP FUNCTION institution.mark_work_interview_held(text, date);
DROP FUNCTION institution.set_work_interview_appointment(text, uuid, text, timestamptz);
DROP FUNCTION institution.invite_work_interview(text);
DROP FUNCTION institution.remove_work_interview_question(text, uuid);
DROP FUNCTION institution.add_work_interview_question(text, text, text);
DROP FUNCTION institution.work_interview_get(text);
DROP FUNCTION institution.work_interview_ensure(text, record);
DROP FUNCTION institution.work_interview_read(text, uuid, text, uuid);
DROP FUNCTION institution.work_interview_context(text);
DROP TABLE audit.work_interview_event;
DROP TABLE institution.work_interview_explanation;
DROP TABLE institution.work_interview_question;
DROP TABLE institution.work_interview;
DROP FUNCTION institution.work_interview_draft_days();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
