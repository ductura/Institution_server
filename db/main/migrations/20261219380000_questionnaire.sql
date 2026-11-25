-- migrate:up
-- SRV-V18-UPITNIK-BAZA (Ductus#2055; val 18, WEB docs/nalazi/val18-razlika.md
-- §5 task 1): the questionnaire of a course. A teacher of the course makes a
-- questionnaire (questions of five kinds), opens it and closes it; the students
-- enrolled in the course answer it once. Answers carry no person (V18-1).
--
--   institution.questionnaire               course, author, title, state
--                                           draft -> open -> closed (one way)
--   institution.questionnaire_question      the questions, only while draft
--   institution.questionnaire_response      one answer sheet: NO person, the
--                                           date only (no time, no sequence)
--   institution.questionnaire_answer        one value per question of a sheet
--   institution.questionnaire_participation who has answered (for the once
--                                           rule only): the person and the date,
--                                           no reference to any sheet
--
-- The sheet and the participation are two tables that cannot be joined: no
-- column of a sheet or an answer names a person, no column of the participation
-- names a sheet, both carry the date and not the time, and the sheet id is a
-- random uuid. The export orders sheets by a hash of the id, not by time.
-- Every table has forced RLS and no privilege for ductus_app: only the RPCs
-- below read and write. Who (C-23, from the relation, never from a role alone):
--   teacher  an open teacher of the course makes, edits (draft only), opens,
--            closes and reads questionnaires and the sheets, and enters sheets
--            by hand (no person)
--   student  an open student member of the course lists the open
--            questionnaires, reads the form and answers once
-- Another course, another institution, an unknown or malformed id, a closed or
-- not yet open questionnaire for a student: the same refusal. Errors carry no
-- input: ZD401 no session, ZD404 not there or no part in it, ZD409 wrong state
-- (the message says which: not_draft, conflict, already_answered), ZD422
-- invalid input. No grade, rank or sum of a person exists; the participation
-- is never returned to the teacher.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- Options: 2 to 20 objects with exactly the keys code and label; code a short
-- word of lowercase letters, digits and hyphens (distinct); label one line of 1
-- to 120 characters, trimmed, no control characters.
CREATE FUNCTION institution.questionnaire_options_valid(p_options jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_options IS NULL OR jsonb_typeof(p_options) <> 'array'
                OR jsonb_array_length(p_options) NOT BETWEEN 2 AND 20 THEN false
         ELSE (SELECT coalesce(bool_and(coalesce(
                  jsonb_typeof(e) = 'object'
                  AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) = ARRAY['code', 'label']
                  AND jsonb_typeof(e -> 'code') = 'string' AND jsonb_typeof(e -> 'label') = 'string'
                  AND (e ->> 'code') ~ '^[a-z0-9][a-z0-9-]{0,39}$'
                  AND char_length(e ->> 'label') BETWEEN 1 AND 120
                  AND (e ->> 'label') = btrim(e ->> 'label')
                  AND (e ->> 'label') !~ '[[:cntrl:]]', false)), false)
                 FROM jsonb_array_elements(p_options) e)
              AND (SELECT count(DISTINCT e ->> 'code') FROM jsonb_array_elements(p_options) e)
                  = jsonb_array_length(p_options)
         END
$$;

-- Scale: an object with exactly min and max, integers, 0 <= min < max <= 10.
CREATE FUNCTION institution.questionnaire_scale_valid(p_scale jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(p_scale IS NOT NULL AND jsonb_typeof(p_scale) = 'object'
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_scale) k) = ARRAY['max', 'min']
     AND jsonb_typeof(p_scale -> 'min') = 'number' AND jsonb_typeof(p_scale -> 'max') = 'number'
     AND (p_scale ->> 'min') ~ '^[0-9]+$' AND (p_scale ->> 'max') ~ '^[0-9]+$'
     AND (p_scale ->> 'min')::integer >= 0 AND (p_scale ->> 'max')::integer <= 10
     AND (p_scale ->> 'min')::integer < (p_scale ->> 'max')::integer, false)
$$;

-- The kind decides which of options and scale there is: single and multiple
-- have options and no scale, scale has a scale and no options, number and text
-- have neither (an SQL null, never a json null).
CREATE FUNCTION institution.questionnaire_shape_valid(p_kind text, p_options jsonb, p_scale jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(CASE p_kind
    WHEN 'single' THEN institution.questionnaire_options_valid(p_options) AND p_scale IS NULL
    WHEN 'multiple' THEN institution.questionnaire_options_valid(p_options) AND p_scale IS NULL
    WHEN 'scale' THEN institution.questionnaire_scale_valid(p_scale) AND p_options IS NULL
    WHEN 'number' THEN p_options IS NULL AND p_scale IS NULL
    WHEN 'text' THEN p_options IS NULL AND p_scale IS NULL
    ELSE false END, false)
$$;

-- One-line text of 1 to p_max characters, trimmed, no control characters.
CREATE FUNCTION institution.questionnaire_line_valid(p_value text, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(p_value IS NOT NULL AND char_length(p_value) BETWEEN 1 AND p_max
     AND p_value = btrim(p_value) AND p_value !~ '[[:cntrl:]]', false)
$$;

-- The questions as sent: 1 to 40 objects with kind, text and, by kind, options
-- or scale and nothing else. The order is the order of the array.
CREATE FUNCTION institution.questionnaire_questions_valid(p_questions jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_questions IS NOT NULL AND jsonb_typeof(p_questions) = 'array'
     AND jsonb_array_length(p_questions) BETWEEN 1 AND 40
     AND (SELECT coalesce(bool_and(coalesce(
            jsonb_typeof(e) = 'object'
            AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'text', 'options', 'scale'))
            AND jsonb_typeof(e -> 'kind') = 'string' AND jsonb_typeof(e -> 'text') = 'string'
            AND institution.questionnaire_line_valid(e ->> 'text', 500)
            AND institution.questionnaire_shape_valid(e ->> 'kind', e -> 'options', e -> 'scale'), false)), false)
            FROM jsonb_array_elements(p_questions) e)
$$;

-- Is a value an answer to a question of this shape? single: one option code;
-- multiple: 1 or more distinct codes; scale: an integer in min..max; number: a
-- number up to 1e9 in size; text: 1 to 2000 characters without control
-- characters other than a line break or a tab.
CREATE FUNCTION institution.questionnaire_value_valid(p_kind text, p_options jsonb, p_scale jsonb, p_value jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_value IS NOT NULL AND coalesce(CASE p_kind
    WHEN 'single' THEN jsonb_typeof(p_value) = 'string'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_options) o WHERE o ->> 'code' = p_value #>> '{}')
    WHEN 'multiple' THEN jsonb_typeof(p_value) = 'array' AND jsonb_array_length(p_value) >= 1
      AND (SELECT bool_and(jsonb_typeof(v) = 'string'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_options) o WHERE o ->> 'code' = v #>> '{}'))
             FROM jsonb_array_elements(p_value) v)
      AND (SELECT count(DISTINCT v) FROM jsonb_array_elements(p_value) v) = jsonb_array_length(p_value)
    WHEN 'scale' THEN jsonb_typeof(p_value) = 'number' AND (p_value #>> '{}') ~ '^[0-9]+$'
      AND (p_value #>> '{}')::integer BETWEEN (p_scale ->> 'min')::integer AND (p_scale ->> 'max')::integer
    WHEN 'number' THEN jsonb_typeof(p_value) = 'number'
      AND abs((p_value #>> '{}')::numeric) <= 1000000000
    WHEN 'text' THEN jsonb_typeof(p_value) = 'string' AND char_length(p_value #>> '{}') BETWEEN 1 AND 2000
      AND (p_value #>> '{}') !~ '[\x01-\x08\x0b-\x1f\x7f]'
    END, false)
$$;

CREATE TABLE institution.questionnaire (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  course_id uuid NOT NULL,
  author_id uuid NOT NULL,
  title text NOT NULL CHECK (institution.questionnaire_line_valid(title, 200)),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'closed')),
  created_on date NOT NULL DEFAULT current_date,
  UNIQUE (id, institution_id),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX questionnaire_course_idx ON institution.questionnaire (course_id, institution_id);
CREATE INDEX questionnaire_author_idx ON institution.questionnaire (author_id, institution_id);

CREATE TABLE institution.questionnaire_question (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  questionnaire_id uuid NOT NULL,
  ord integer NOT NULL CHECK (ord BETWEEN 1 AND 40),
  kind text NOT NULL CHECK (kind IN ('single', 'multiple', 'scale', 'number', 'text')),
  body text NOT NULL CHECK (institution.questionnaire_line_valid(body, 500)),
  options jsonb,
  scale jsonb,
  CHECK (institution.questionnaire_shape_valid(kind, options, scale)),
  UNIQUE (questionnaire_id, ord),
  UNIQUE (id, questionnaire_id, institution_id),
  FOREIGN KEY (questionnaire_id, institution_id) REFERENCES institution.questionnaire (id, institution_id)
);

-- No person, no time, no sequence: the date only.
CREATE TABLE institution.questionnaire_response (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  questionnaire_id uuid NOT NULL,
  answered_on date NOT NULL DEFAULT current_date,
  UNIQUE (id, questionnaire_id, institution_id),
  FOREIGN KEY (questionnaire_id, institution_id) REFERENCES institution.questionnaire (id, institution_id)
);
CREATE INDEX questionnaire_response_questionnaire_idx
  ON institution.questionnaire_response (questionnaire_id, institution_id);

CREATE TABLE institution.questionnaire_answer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  questionnaire_id uuid NOT NULL,
  response_id uuid NOT NULL,
  question_id uuid NOT NULL,
  value jsonb NOT NULL,
  UNIQUE (response_id, question_id),
  FOREIGN KEY (response_id, questionnaire_id, institution_id)
    REFERENCES institution.questionnaire_response (id, questionnaire_id, institution_id),
  FOREIGN KEY (question_id, questionnaire_id, institution_id)
    REFERENCES institution.questionnaire_question (id, questionnaire_id, institution_id)
);
CREATE INDEX questionnaire_answer_question_idx
  ON institution.questionnaire_answer (question_id, questionnaire_id, institution_id);

-- Who has answered, and nothing about the answer.
CREATE TABLE institution.questionnaire_participation (
  questionnaire_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  participated_on date NOT NULL DEFAULT current_date,
  PRIMARY KEY (questionnaire_id, user_id),
  FOREIGN KEY (questionnaire_id, institution_id) REFERENCES institution.questionnaire (id, institution_id),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX questionnaire_participation_user_idx
  ON institution.questionnaire_participation (user_id, institution_id);

-- A questionnaire is never deleted; its state moves one way (draft -> open ->
-- closed) and its title changes only while it is a draft.
CREATE FUNCTION institution.reject_questionnaire_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id, NEW.institution_id, NEW.course_id, NEW.author_id, NEW.created_on)
         IS NOT DISTINCT FROM (OLD.id, OLD.institution_id, OLD.course_id, OLD.author_id, OLD.created_on)
     AND ((OLD.state = 'draft' AND NEW.state IN ('draft', 'open')
           AND (NEW.title = OLD.title OR NEW.state = 'draft'))
          OR (OLD.state = 'open' AND NEW.state IN ('open', 'closed') AND NEW.title = OLD.title)
          OR (OLD.state = 'closed' AND NEW.state = 'closed' AND NEW.title = OLD.title)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;

-- The questions change only while the questionnaire is a draft.
CREATE FUNCTION institution.guard_questionnaire_question() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_questionnaire uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.questionnaire_id ELSE NEW.questionnaire_id END;
BEGIN
  IF TG_OP <> 'INSERT' AND TG_OP <> 'DELETE'
     AND (NEW.questionnaire_id, NEW.institution_id) IS DISTINCT FROM (OLD.questionnaire_id, OLD.institution_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  -- A question of a questionnaire that is not there is left to the foreign key.
  IF EXISTS (SELECT 1 FROM institution.questionnaire q WHERE q.id = v_questionnaire AND q.state <> 'draft') THEN
    RAISE EXCEPTION 'not_draft' USING ERRCODE = 'ZD409';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- A record of an answer is only ever added.
CREATE FUNCTION institution.reject_questionnaire_record_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['questionnaire', 'questionnaire_question', 'questionnaire_response',
                           'questionnaire_answer', 'questionnaire_participation'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_questionnaire_record_change()',
                   t || '_no_truncate', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['questionnaire_response', 'questionnaire_answer', 'questionnaire_participation'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_questionnaire_record_change()',
                   t || '_append_only', t);
  END LOOP;
END
$$;
CREATE TRIGGER questionnaire_guard BEFORE UPDATE OR DELETE ON institution.questionnaire
  FOR EACH ROW EXECUTE FUNCTION institution.reject_questionnaire_change();
CREATE TRIGGER questionnaire_question_guard BEFORE INSERT OR UPDATE OR DELETE ON institution.questionnaire_question
  FOR EACH ROW EXECUTE FUNCTION institution.guard_questionnaire_question();

-- The caller's part in the course of a questionnaire; p_part 'teacher' or
-- 'student'. ZD401 without a session; ZD404 for anything else.
CREATE FUNCTION institution.questionnaire_context(p_id uuid, p_part text,
  OUT o_user_id uuid, OUT o_institution_id uuid, OUT o_course_id uuid, OUT o_state text)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  SELECT q.course_id, q.state INTO o_course_id, o_state FROM institution.questionnaire q
   WHERE q.id = p_id AND q.institution_id = o_institution_id;
  IF p_id IS NULL OR o_course_id IS NULL
     OR institution.actor_course_role(o_course_id) IS DISTINCT FROM p_part THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- The same for a course (making and listing).
CREATE FUNCTION institution.questionnaire_course_context(p_course_id uuid,
  OUT o_user_id uuid, OUT o_institution_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  IF p_course_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM institution.course c WHERE c.id = p_course_id AND c.institution_id = o_institution_id)
     OR institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- Insert the questions of a questionnaire from the json sent (already valid).
CREATE FUNCTION institution.questionnaire_add_questions(p_id uuid, p_questions jsonb)
RETURNS void
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  INSERT INTO institution.questionnaire_question (institution_id, questionnaire_id, ord, kind, body, options, scale)
  SELECT q.institution_id, q.id, e.i::integer, e.v ->> 'kind', e.v ->> 'text', e.v -> 'options', e.v -> 'scale'
    FROM institution.questionnaire q, jsonb_array_elements(p_questions) WITH ORDINALITY e (v, i)
   WHERE q.id = p_id
$$;

-- The answers as sent: a non-empty array of {questionId, value}, one per
-- question at most, each a question of this questionnaire with a valid value.
CREATE FUNCTION institution.questionnaire_answers_valid(p_id uuid, p_answers jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT p_answers IS NOT NULL AND jsonb_typeof(p_answers) = 'array' AND jsonb_array_length(p_answers) >= 1
     AND (SELECT coalesce(bool_and(coalesce(
            jsonb_typeof(a) = 'object'
            AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) = ARRAY['questionId', 'value']
            AND jsonb_typeof(a -> 'questionId') = 'string'
            AND (a ->> 'questionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND EXISTS (SELECT 1 FROM institution.questionnaire_question q
                         WHERE q.questionnaire_id = p_id AND q.id = (a ->> 'questionId')::uuid
                           AND institution.questionnaire_value_valid(q.kind, q.options, q.scale, a -> 'value')), false)), false)
            FROM jsonb_array_elements(p_answers) a)
     AND (SELECT count(DISTINCT a ->> 'questionId') FROM jsonb_array_elements(p_answers) a)
         = jsonb_array_length(p_answers)
$$;

-- One sheet without a person, with its answers.
CREATE FUNCTION institution.questionnaire_add_response(p_id uuid, p_answers jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_response uuid;
  v_institution uuid;
BEGIN
  SELECT q.institution_id INTO STRICT v_institution FROM institution.questionnaire q WHERE q.id = p_id;
  INSERT INTO institution.questionnaire_response (institution_id, questionnaire_id)
  VALUES (v_institution, p_id) RETURNING id INTO v_response;
  INSERT INTO institution.questionnaire_answer (institution_id, questionnaire_id, response_id, question_id, value)
  SELECT v_institution, p_id, v_response, (a ->> 'questionId')::uuid, a -> 'value'
    FROM jsonb_array_elements(p_answers) a;
END
$$;

-- Makes a draft questionnaire in a course of the teacher; returns its id.
CREATE FUNCTION app.create_questionnaire(p_course_id uuid, p_title text, p_questions jsonb)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_course_context(p_course_id);
  IF NOT institution.questionnaire_line_valid(p_title, 200)
     OR NOT institution.questionnaire_questions_valid(p_questions) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.questionnaire (institution_id, course_id, author_id, title)
  VALUES (v_ctx.o_institution_id, p_course_id, v_ctx.o_user_id, p_title) RETURNING id INTO v_id;
  PERFORM institution.questionnaire_add_questions(v_id, p_questions);
  RETURN v_id;
END
$$;

-- Replaces the title and the questions of a draft; ZD409 not_draft otherwise.
CREATE FUNCTION app.update_questionnaire(p_id uuid, p_title text, p_questions jsonb)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_context(p_id, 'teacher');
  IF NOT institution.questionnaire_line_valid(p_title, 200)
     OR NOT institution.questionnaire_questions_valid(p_questions) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.questionnaire q WHERE q.id = p_id FOR UPDATE;
  IF (SELECT q.state FROM institution.questionnaire q WHERE q.id = p_id) <> 'draft' THEN
    RAISE EXCEPTION 'not_draft' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.questionnaire SET title = p_title WHERE id = p_id;
  DELETE FROM institution.questionnaire_question WHERE questionnaire_id = p_id;
  PERFORM institution.questionnaire_add_questions(p_id, p_questions);
  RETURN p_id;
END
$$;

-- Opens a draft or closes an open questionnaire; returns the new state. ZD422
-- for any other target; ZD409 conflict for a step that is not the next one.
CREATE FUNCTION app.set_questionnaire_state(p_id uuid, p_state text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  PERFORM institution.questionnaire_context(p_id, 'teacher');
  IF p_state IS NULL OR p_state NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT q.state INTO v_state FROM institution.questionnaire q WHERE q.id = p_id FOR UPDATE;
  IF NOT ((v_state = 'draft' AND p_state = 'open') OR (v_state = 'open' AND p_state = 'closed')) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE institution.questionnaire SET state = p_state WHERE id = p_id;
  RETURN p_state;
END
$$;

-- The questionnaires of a course, for its teachers.
CREATE FUNCTION app.teacher_questionnaires(p_course_id uuid)
RETURNS TABLE (id uuid, title text, state text, created_on date, question_count integer, response_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_course_context(p_course_id);
  RETURN QUERY
  SELECT q.id, q.title, q.state, q.created_on,
         (SELECT count(*)::integer FROM institution.questionnaire_question x WHERE x.questionnaire_id = q.id),
         (SELECT count(*)::integer FROM institution.questionnaire_response r WHERE r.questionnaire_id = q.id)
    FROM institution.questionnaire q
   WHERE q.course_id = p_course_id AND q.institution_id = v_ctx.o_institution_id
   ORDER BY q.created_on DESC, q.id;
END
$$;

-- One questionnaire with its questions in order, for its teachers (one row per
-- question).
CREATE FUNCTION app.teacher_questionnaire(p_id uuid)
RETURNS TABLE (questionnaire_id uuid, course_id uuid, title text, state text,
               question_id uuid, ord integer, kind text, body text, options jsonb, scale jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_context(p_id, 'teacher');
  RETURN QUERY
  SELECT q.id, q.course_id, q.title, q.state, x.id, x.ord, x.kind, x.body, x.options, x.scale
    FROM institution.questionnaire q
    JOIN institution.questionnaire_question x ON x.questionnaire_id = q.id
   WHERE q.id = p_id ORDER BY x.ord;
END
$$;

-- The open questionnaires of the courses the caller is an open student member
-- of, and whether the caller has answered each.
CREATE FUNCTION app.student_questionnaires()
RETURNS TABLE (id uuid, course_id uuid, title text, participated boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  RETURN QUERY
  SELECT q.id, q.course_id, q.title,
         EXISTS (SELECT 1 FROM institution.questionnaire_participation p
                  WHERE p.questionnaire_id = q.id AND p.user_id = v_user)
    FROM institution.questionnaire q
    JOIN institution.course_member m
      ON m.course_id = q.course_id AND m.institution_id = q.institution_id AND m.user_id = v_user
     AND m.role = 'student' AND m.member_to IS NULL
   WHERE q.institution_id = v_institution AND q.state = 'open'
   ORDER BY q.created_on DESC, q.id;
END
$$;

-- The form of an open questionnaire of a course the caller studies in.
CREATE FUNCTION app.student_questionnaire(p_id uuid)
RETURNS TABLE (questionnaire_id uuid, course_id uuid, title text, participated boolean,
               question_id uuid, ord integer, kind text, body text, options jsonb, scale jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_context(p_id, 'student');
  IF v_ctx.o_state <> 'open' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN QUERY
  SELECT q.id, q.course_id, q.title,
         EXISTS (SELECT 1 FROM institution.questionnaire_participation p
                  WHERE p.questionnaire_id = q.id AND p.user_id = v_ctx.o_user_id),
         x.id, x.ord, x.kind, x.body, x.options, x.scale
    FROM institution.questionnaire q
    JOIN institution.questionnaire_question x ON x.questionnaire_id = q.id
   WHERE q.id = p_id ORDER BY x.ord;
END
$$;

-- A student answers an open questionnaire once. The sheet gets no person; the
-- participation gets no sheet. ZD409 already_answered the second time.
CREATE FUNCTION app.submit_questionnaire_response(p_id uuid, p_answers jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_context(p_id, 'student');
  IF v_ctx.o_state <> 'open' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF NOT institution.questionnaire_answers_valid(p_id, p_answers) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- The questionnaire row is locked and its state read again, so a teacher who
  -- closes it at the same time cannot be overtaken (set_questionnaire_state
  -- takes FOR UPDATE).
  PERFORM 1 FROM institution.questionnaire q WHERE q.id = p_id FOR SHARE;
  IF (SELECT q.state FROM institution.questionnaire q WHERE q.id = p_id) <> 'open' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('questionnaire:' || p_id || ':' || v_ctx.o_user_id, 0));
  IF EXISTS (SELECT 1 FROM institution.questionnaire_participation p
              WHERE p.questionnaire_id = p_id AND p.user_id = v_ctx.o_user_id) THEN
    RAISE EXCEPTION 'already_answered' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.questionnaire_participation (questionnaire_id, institution_id, user_id)
  VALUES (p_id, v_ctx.o_institution_id, v_ctx.o_user_id);
  PERFORM institution.questionnaire_add_response(p_id, p_answers);
END
$$;

-- A teacher enters a sheet by hand (invented or on paper): no person, no
-- participation. Only while the questionnaire is open.
CREATE FUNCTION app.manual_questionnaire_response(p_id uuid, p_answers jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.questionnaire_context(p_id, 'teacher');
  IF NOT institution.questionnaire_answers_valid(p_id, p_answers) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.questionnaire q WHERE q.id = p_id FOR SHARE;
  IF (SELECT q.state FROM institution.questionnaire q WHERE q.id = p_id) <> 'open' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  PERFORM institution.questionnaire_add_response(p_id, p_answers);
END
$$;

-- The answers of a questionnaire, for its teachers: the sheet id (random, only
-- to group the rows), the question and the value. Nothing else about a sheet.
CREATE FUNCTION app.questionnaire_answer_rows(p_id uuid)
RETURNS TABLE (response_id uuid, question_id uuid, value jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.questionnaire_context(p_id, 'teacher');
  RETURN QUERY
  SELECT a.response_id, a.question_id, a.value
    FROM institution.questionnaire_answer a
   WHERE a.questionnaire_id = p_id
   ORDER BY a.response_id, a.question_id;
END
$$;

-- The number of sheets of a questionnaire, for its teachers (a sheet may have
-- no answer to a question, so the rows above do not count them).
CREATE FUNCTION app.questionnaire_response_ids(p_id uuid)
RETURNS TABLE (response_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.questionnaire_context(p_id, 'teacher');
  RETURN QUERY
  SELECT r.id FROM institution.questionnaire_response r WHERE r.questionnaire_id = p_id ORDER BY r.id;
END
$$;

REVOKE ALL ON FUNCTION institution.questionnaire_options_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_scale_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_shape_valid(text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_line_valid(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_questions_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_value_valid(text, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.reject_questionnaire_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.guard_questionnaire_question() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.reject_questionnaire_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_context(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_course_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_add_questions(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_answers_valid(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.questionnaire_add_response(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_questionnaire(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_questionnaire(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_questionnaire_state(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_questionnaires(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_questionnaire(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_questionnaires() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_questionnaire(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.submit_questionnaire_response(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.manual_questionnaire_response(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.questionnaire_answer_rows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.questionnaire_response_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_questionnaire(uuid, text, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.update_questionnaire(uuid, text, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_questionnaire_state(uuid, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.teacher_questionnaires(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.teacher_questionnaire(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.student_questionnaires() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.student_questionnaire(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.submit_questionnaire_response(uuid, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.manual_questionnaire_response(uuid, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.questionnaire_answer_rows(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.questionnaire_response_ids(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.questionnaire_response_ids(uuid);
DROP FUNCTION app.questionnaire_answer_rows(uuid);
DROP FUNCTION app.manual_questionnaire_response(uuid, jsonb);
DROP FUNCTION app.submit_questionnaire_response(uuid, jsonb);
DROP FUNCTION app.student_questionnaire(uuid);
DROP FUNCTION app.student_questionnaires();
DROP FUNCTION app.teacher_questionnaire(uuid);
DROP FUNCTION app.teacher_questionnaires(uuid);
DROP FUNCTION app.set_questionnaire_state(uuid, text);
DROP FUNCTION app.update_questionnaire(uuid, text, jsonb);
DROP FUNCTION app.create_questionnaire(uuid, text, jsonb);
DROP TABLE institution.questionnaire_participation;
DROP TABLE institution.questionnaire_answer;
DROP TABLE institution.questionnaire_response;
DROP TABLE institution.questionnaire_question;
DROP TABLE institution.questionnaire;
DROP FUNCTION institution.questionnaire_add_response(uuid, jsonb);
DROP FUNCTION institution.questionnaire_answers_valid(uuid, jsonb);
DROP FUNCTION institution.questionnaire_add_questions(uuid, jsonb);
DROP FUNCTION institution.questionnaire_course_context(uuid);
DROP FUNCTION institution.questionnaire_context(uuid, text);
DROP FUNCTION institution.reject_questionnaire_record_change();
DROP FUNCTION institution.guard_questionnaire_question();
DROP FUNCTION institution.reject_questionnaire_change();
DROP FUNCTION institution.questionnaire_value_valid(text, jsonb, jsonb, jsonb);
DROP FUNCTION institution.questionnaire_questions_valid(jsonb);
DROP FUNCTION institution.questionnaire_line_valid(text, integer);
DROP FUNCTION institution.questionnaire_shape_valid(text, jsonb, jsonb);
DROP FUNCTION institution.questionnaire_scale_valid(jsonb);
DROP FUNCTION institution.questionnaire_options_valid(jsonb);
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
