-- migrate:up
-- SRV-MENTOR-2 mentorstvo-obrasci-suglasnost (Ductus#2055; the owner's
-- decisions of 23. 11. 2026 for NF-6, MK-12 and MK-14). Three things of a
-- thesis (the work of a mentorship), none of which enters a grade:
--
--   (a) the forms of the faculty for a thesis (for example the topic
--       application, the statement of originality as the official name of the
--       form, the statement of deposit), each with a version, and the state of
--       each form for one work: not_submitted, submitted, accepted;
--   (b) the mentor's consent to the submission: the mentor gives it or
--       withdraws it (who, when, an optional comment) and the student sees it.
--       A submission without consent is not blocked; the faculty's setting
--       mentor_consent_required (off by default) only records the faculty's
--       choice until the submission path reads it (see the PR, "Otvoreno");
--   (c) the stage after the submission: submitted_to_office (predano
--       referadi), defense_scheduled (with its date), defended.
--
--   institution.thesis_form              the catalogue of one institution; a
--                                        version is only ever added, the newest
--                                        version of a code is the form in force
--                                        (active = false retires it)
--   institution.thesis_setting           the faculty's switch, append-only; the
--                                        newest row holds, none = off
--   institution.work_thesis_form_event   every change of the state of a form of
--                                        one work, append-only; the newest holds
--   institution.work_mentor_consent_event every consent and withdrawal, append-only
--   institution.work_thesis_stage_event  every change of the stage, append-only
--
-- Who (C-23: from the relation; the faculty part is the administrator of the
-- institution of the work, marked for legal review in the PR):
--   catalogue         read: anyone signed in at the institution; publish: its administrator
--   setting           read and set: the administrator
--   form of a work    read: the student owner, the mentor, the administrator;
--                     the student moves not_submitted <-> submitted, the mentor
--                     and the administrator set any state
--   consent           read: the same three; give and withdraw: the mentor only
--   stage             read: the same three; set: the mentor and the administrator
-- A person with no part in the work, a course teacher included, reads ZD404,
-- as does a work that is not the work of a mentorship. Nothing here reads or
-- copies the content of the work.
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed, ZD404 not there
-- or no part in it, ZD409 wrong state, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Text a person wrote: NFC, 1 to p_max characters, not only blanks, no control
-- characters but newline and tab, no bidirectional overrides or isolates.
CREATE FUNCTION institution.is_thesis_text(p_text text, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_text IS NOT NULL AND p_text IS NFC NORMALIZED
    AND char_length(p_text) BETWEEN 1 AND p_max
    AND p_text ~ '[^[:space:]]'
    AND translate(p_text, E'\n\t', '') !~ '[[:cntrl:]]'
    AND p_text !~ E'[‪-‮⁦-⁩]'
$$;

CREATE TABLE institution.thesis_form (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{1,47}$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  title text NOT NULL CHECK (institution.is_thesis_text(title, 200) AND title !~ '[\n\t]'),
  work_types text[] NOT NULL CHECK (
    cardinality(work_types) BETWEEN 1 AND 4 AND coalesce(array_ndims(work_types), 1) = 1
    AND work_types <@ ARRAY['bachelor_thesis', 'master_thesis', 'specialist_thesis', 'doctoral_thesis']),
  active boolean NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (institution_id, code, version),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX thesis_form_author_idx ON institution.thesis_form (created_by, institution_id);

CREATE TABLE institution.thesis_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  mentor_consent_required boolean NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX thesis_setting_institution_idx ON institution.thesis_setting (institution_id, seq);
CREATE INDEX thesis_setting_author_idx ON institution.thesis_setting (created_by, institution_id);

CREATE TABLE institution.work_thesis_form_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  form_code text NOT NULL,
  form_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('not_submitted', 'submitted', 'accepted')),
  actor_id uuid NOT NULL,
  actor_part text NOT NULL CHECK (actor_part IN ('student', 'mentor', 'faculty')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (institution_id, form_code, form_version)
    REFERENCES institution.thesis_form (institution_id, code, version),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_thesis_form_event_work_idx
  ON institution.work_thesis_form_event (institution_id, document_id, form_code, seq);
CREATE INDEX work_thesis_form_event_form_idx
  ON institution.work_thesis_form_event (institution_id, form_code, form_version);
CREATE INDEX work_thesis_form_event_actor_idx ON institution.work_thesis_form_event (actor_id, institution_id);

CREATE TABLE institution.work_mentor_consent_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  given boolean NOT NULL,
  comment text CHECK (comment IS NULL OR institution.is_thesis_text(comment, 1000)),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_mentor_consent_event_work_idx
  ON institution.work_mentor_consent_event (institution_id, document_id, seq);
CREATE INDEX work_mentor_consent_event_actor_idx ON institution.work_mentor_consent_event (actor_id, institution_id);

CREATE TABLE institution.work_thesis_stage_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('none', 'submitted_to_office', 'defense_scheduled', 'defended')),
  defense_at timestamptz CHECK (defense_at >= '2000-01-01T00:00:00Z' AND defense_at < '10000-01-01T00:00:00Z'),
  actor_id uuid NOT NULL,
  actor_part text NOT NULL CHECK (actor_part IN ('mentor', 'faculty')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  CHECK (stage <> 'defense_scheduled' OR defense_at IS NOT NULL),
  CHECK (stage NOT IN ('none', 'submitted_to_office') OR defense_at IS NULL)
);
CREATE INDEX work_thesis_stage_event_work_idx
  ON institution.work_thesis_stage_event (institution_id, document_id, seq);
CREATE INDEX work_thesis_stage_event_actor_idx ON institution.work_thesis_stage_event (actor_id, institution_id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
CREATE FUNCTION institution.reject_thesis_record_change() RETURNS trigger
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
  FOREACH t IN ARRAY ARRAY['thesis_form', 'thesis_setting', 'work_thesis_form_event',
                           'work_mentor_consent_event', 'work_thesis_stage_event'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_thesis_record_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_thesis_record_change()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- The caller's part in the thesis of one work: 'student' (its owner), 'mentor'
-- (the teacher of the mentorship's assignment) or 'faculty' (an administrator
-- of the institution of the work). ZD401 without a session; ZD404 for a work
-- that does not exist, is not the work of a mentorship, or that the caller has
-- no part in.
CREATE FUNCTION institution.thesis_work_context(
  p_document_id text,
  OUT o_institution_id uuid, OUT o_user_id uuid, OUT o_part text, OUT o_work_type text
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS DISTINCT FROM o_institution_id THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT m.work_type INTO o_work_type
    FROM institution.assignment a
    JOIN institution.mentorship m ON m.id = a.mentorship_id AND m.institution_id = a.institution_id
   WHERE a.id = v_scope.assignment_id AND a.institution_id = o_institution_id;
  IF o_work_type IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  o_part := CASE v_role WHEN 'student' THEN 'student' WHEN 'teacher' THEN 'mentor' END;
  IF o_part IS NULL AND institution.actor_has_role('admin') THEN
    o_part := 'faculty';
  END IF;
  IF o_part IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- The forms in force of the caller's institution: the newest version of each
-- code. Retired forms (active = false) are listed for the administrator only.
CREATE FUNCTION app.read_thesis_forms()
RETURNS TABLE (code text, version integer, title text, work_types text[], active boolean, published_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_admin boolean := institution.actor_has_role('admin');
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  RETURN QUERY
    SELECT f.code, f.version, f.title, f.work_types, f.active, f.created_at
      FROM (SELECT DISTINCT ON (x.code) x.*
              FROM institution.thesis_form x
             WHERE x.institution_id = v_actor.institution_id
             ORDER BY x.code, x.version DESC) f
     WHERE f.active OR v_admin
     ORDER BY f.code;
END
$$;

-- The administrator adds a version of a form (version 1 for a new code).
CREATE FUNCTION app.publish_thesis_form(p_code text, p_title text, p_work_types text[], p_active boolean)
RETURNS TABLE (code text, version integer, title text, work_types text[], active boolean, published_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_version integer;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9-]{1,47}$'
     OR NOT institution.is_thesis_text(p_title, 200) OR p_title ~ '[\n\t]'
     OR p_active IS NULL OR p_work_types IS NULL OR cardinality(p_work_types) NOT BETWEEN 1 AND 4
     OR coalesce(array_ndims(p_work_types), 1) <> 1 OR array_position(p_work_types, NULL) IS NOT NULL
     OR NOT p_work_types <@ ARRAY['bachelor_thesis', 'master_thesis', 'specialist_thesis', 'doctoral_thesis']
     OR (SELECT count(DISTINCT t) FROM unnest(p_work_types) t) <> cardinality(p_work_types) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One publisher of a code at a time; the primary key is the guarantee.
  PERFORM pg_advisory_xact_lock(hashtextextended('thesis_form:' || v_actor.institution_id || ':' || p_code, 0));
  SELECT coalesce(max(f.version), 0) + 1 INTO v_version FROM institution.thesis_form f
   WHERE f.institution_id = v_actor.institution_id AND f.code = p_code;
  IF v_version > 10000 THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.thesis_form (institution_id, code, version, title, work_types, active, created_by)
  VALUES (v_actor.institution_id, p_code, v_version, p_title,
          ARRAY(SELECT t FROM unnest(p_work_types) t ORDER BY t), p_active, v_actor.user_id);
  RETURN QUERY
    SELECT f.code, f.version, f.title, f.work_types, f.active, f.created_at FROM institution.thesis_form f
     WHERE f.institution_id = v_actor.institution_id AND f.code = p_code AND f.version = v_version;
END
$$;

-- The faculty's switch in force at the caller's institution (no row: off) and
-- when it was last set. The institution is the session's, never an argument.
CREATE FUNCTION institution.thesis_setting_now()
RETURNS TABLE (mentor_consent_required boolean, changed_at timestamptz)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce(s.mentor_consent_required, false), s.created_at
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT x.mentor_consent_required, x.created_at FROM institution.thesis_setting x
       WHERE x.institution_id = (SELECT a.institution_id FROM app.current_actor() a)
       ORDER BY x.seq DESC LIMIT 1) s ON true
$$;

CREATE FUNCTION app.read_thesis_setting()
RETURNS TABLE (mentor_consent_required boolean, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM institution.thesis_setting_now();
END
$$;

-- The administrator sets the switch. Setting the value in force writes nothing.
CREATE FUNCTION app.set_thesis_setting(p_mentor_consent_required boolean)
RETURNS TABLE (mentor_consent_required boolean, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_mentor_consent_required IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('thesis_setting:' || v_actor.institution_id, 0));
  IF (SELECT s.mentor_consent_required FROM institution.thesis_setting_now() s)
     IS DISTINCT FROM p_mentor_consent_required THEN
    INSERT INTO institution.thesis_setting (institution_id, mentor_consent_required, created_by)
    VALUES (v_actor.institution_id, p_mentor_consent_required, v_actor.user_id);
  END IF;
  RETURN QUERY SELECT * FROM institution.thesis_setting_now();
END
$$;

-- The forms in force for the type of this work, with the state of each on the
-- work. A form whose state was set on the work stays listed after it is retired.
CREATE FUNCTION app.read_work_thesis_forms(p_document_id text)
RETURNS TABLE (
  code text, version integer, title text, state text, state_form_version integer,
  changed_at timestamptz, changed_by uuid, changed_by_part text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY
    WITH current_form AS (
      SELECT DISTINCT ON (f.code) f.code, f.version, f.title, f.active, f.work_types
        FROM institution.thesis_form f
       WHERE f.institution_id = v_ctx.o_institution_id
       ORDER BY f.code, f.version DESC
    ), latest AS (
      SELECT DISTINCT ON (e.form_code) e.form_code, e.form_version, e.state, e.occurred_at, e.actor_id, e.actor_part
        FROM institution.work_thesis_form_event e
       WHERE e.institution_id = v_ctx.o_institution_id AND e.document_id = p_document_id
       ORDER BY e.form_code, e.seq DESC
    )
    SELECT c.code, c.version, c.title, coalesce(l.state, 'not_submitted'), l.form_version,
           l.occurred_at, l.actor_id, l.actor_part
      FROM current_form c
      LEFT JOIN latest l ON l.form_code = c.code
     WHERE (c.active AND v_ctx.o_work_type = ANY (c.work_types)) OR l.form_code IS NOT NULL
     ORDER BY c.code;
END
$$;

-- The state of one form of this work. The student moves between not_submitted
-- and submitted and cannot touch an accepted form; the mentor and the
-- administrator set any state. Setting the state in force writes nothing.
CREATE FUNCTION app.set_work_thesis_form_state(p_document_id text, p_code text, p_state text)
RETURNS TABLE (
  code text, version integer, title text, state text, state_form_version integer,
  changed_at timestamptz, changed_by uuid, changed_by_part text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_form record;
  v_state text;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  IF p_state IS NULL OR p_state NOT IN ('not_submitted', 'submitted', 'accepted') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF v_ctx.o_part = 'student' AND p_state = 'accepted' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT f.version, f.active, f.work_types INTO v_form FROM institution.thesis_form f
   WHERE f.institution_id = v_ctx.o_institution_id AND f.code = p_code
   ORDER BY f.version DESC LIMIT 1;
  IF NOT FOUND OR NOT v_form.active OR NOT v_ctx.o_work_type = ANY (v_form.work_types) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('work_thesis_form:' || v_ctx.o_institution_id || ':' || p_document_id || ':' || p_code, 0));
  SELECT e.state INTO v_state FROM institution.work_thesis_form_event e
   WHERE e.institution_id = v_ctx.o_institution_id AND e.document_id = p_document_id AND e.form_code = p_code
   ORDER BY e.seq DESC LIMIT 1;
  v_state := coalesce(v_state, 'not_submitted');
  IF v_ctx.o_part = 'student' AND v_state = 'accepted' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF v_state <> p_state THEN
    INSERT INTO institution.work_thesis_form_event
      (institution_id, document_id, form_code, form_version, state, actor_id, actor_part)
    VALUES (v_ctx.o_institution_id, p_document_id, p_code, v_form.version, p_state, v_ctx.o_user_id, v_ctx.o_part);
  END IF;
  RETURN QUERY SELECT * FROM app.read_work_thesis_forms(p_document_id) r WHERE r.code = p_code;
END
$$;

-- The consent in force on this work: 'none' (never given), 'given' or
-- 'withdrawn', who changed it and when, the comment of that change, and the
-- faculty's switch. Every change in order is in read_work_mentor_consent_events.
CREATE FUNCTION app.read_work_mentor_consent(p_document_id text)
RETURNS TABLE (
  state text, changed_by uuid, changed_at timestamptz, comment text, required_for_submission boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY
    SELECT CASE WHEN e.id IS NULL THEN 'none' WHEN e.given THEN 'given' ELSE 'withdrawn' END,
           e.actor_id, e.occurred_at, e.comment, s.mentor_consent_required
      FROM institution.thesis_setting_now() s
      LEFT JOIN LATERAL (
        SELECT x.* FROM institution.work_mentor_consent_event x
         WHERE x.institution_id = v_ctx.o_institution_id AND x.document_id = p_document_id
         ORDER BY x.seq DESC LIMIT 1) e ON true;
END
$$;

CREATE FUNCTION app.read_work_mentor_consent_events(p_document_id text)
RETURNS TABLE (given boolean, changed_by uuid, changed_at timestamptz, comment text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY
    SELECT e.given, e.actor_id, e.occurred_at, e.comment FROM institution.work_mentor_consent_event e
     WHERE e.institution_id = v_ctx.o_institution_id AND e.document_id = p_document_id
     ORDER BY e.seq;
END
$$;

-- The mentor gives (p_given) or withdraws the consent. Giving it while it is
-- given, and withdrawing it while it is not, is ZD409.
CREATE FUNCTION app.set_work_mentor_consent(p_document_id text, p_given boolean, p_comment text)
RETURNS TABLE (
  state text, changed_by uuid, changed_at timestamptz, comment text, required_for_submission boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_given boolean;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  IF v_ctx.o_part <> 'mentor' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_given IS NULL OR (p_comment IS NOT NULL AND NOT institution.is_thesis_text(p_comment, 1000)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('work_mentor_consent:' || v_ctx.o_institution_id || ':' || p_document_id, 0));
  SELECT e.given INTO v_given FROM institution.work_mentor_consent_event e
   WHERE e.institution_id = v_ctx.o_institution_id AND e.document_id = p_document_id
   ORDER BY e.seq DESC LIMIT 1;
  IF coalesce(v_given, false) = p_given THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_mentor_consent_event (institution_id, document_id, given, comment, actor_id)
  VALUES (v_ctx.o_institution_id, p_document_id, p_given, p_comment, v_ctx.o_user_id);
  RETURN QUERY SELECT * FROM app.read_work_mentor_consent(p_document_id);
END
$$;

-- The stage of the thesis after the submission ('none' until it is set).
CREATE FUNCTION app.read_work_thesis_stage(p_document_id text)
RETURNS TABLE (stage text, defense_at timestamptz, changed_by uuid, changed_at timestamptz, changed_by_part text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY
    SELECT coalesce(e.stage, 'none'), e.defense_at, e.actor_id, e.occurred_at, e.actor_part
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT x.* FROM institution.work_thesis_stage_event x
         WHERE x.institution_id = v_ctx.o_institution_id AND x.document_id = p_document_id
         ORDER BY x.seq DESC LIMIT 1) e ON true;
END
$$;

-- The mentor or the administrator sets the stage; any stage may follow any
-- other (a correction too). defense_scheduled needs the date; none and
-- submitted_to_office take none; defended may keep it. The stage and date in
-- force write nothing.
CREATE FUNCTION app.set_work_thesis_stage(p_document_id text, p_stage text, p_defense_at timestamptz)
RETURNS TABLE (stage text, defense_at timestamptz, changed_by uuid, changed_at timestamptz, changed_by_part text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_now record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  IF v_ctx.o_part NOT IN ('mentor', 'faculty') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('none', 'submitted_to_office', 'defense_scheduled', 'defended')
     OR (p_stage = 'defense_scheduled' AND p_defense_at IS NULL)
     OR (p_stage IN ('none', 'submitted_to_office') AND p_defense_at IS NOT NULL)
     OR p_defense_at < '2000-01-01T00:00:00Z' OR p_defense_at >= '10000-01-01T00:00:00Z' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('work_thesis_stage:' || v_ctx.o_institution_id || ':' || p_document_id, 0));
  SELECT * INTO v_now FROM app.read_work_thesis_stage(p_document_id);
  IF v_now.stage IS DISTINCT FROM p_stage OR v_now.defense_at IS DISTINCT FROM p_defense_at THEN
    INSERT INTO institution.work_thesis_stage_event (institution_id, document_id, stage, defense_at, actor_id, actor_part)
    VALUES (v_ctx.o_institution_id, p_document_id, p_stage, p_defense_at, v_ctx.o_user_id, v_ctx.o_part);
  END IF;
  RETURN QUERY SELECT * FROM app.read_work_thesis_stage(p_document_id);
END
$$;

REVOKE ALL ON FUNCTION institution.is_thesis_text(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.reject_thesis_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.thesis_work_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.thesis_setting_now() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_thesis_forms() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_thesis_form(text, text, text[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_thesis_setting() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_thesis_setting(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_thesis_forms(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_thesis_form_state(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_mentor_consent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_mentor_consent_events(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_mentor_consent(text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_thesis_stage(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_thesis_stage(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_thesis_forms() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.publish_thesis_form(text, text, text[], boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_thesis_setting() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_thesis_setting(boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_work_thesis_forms(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_thesis_form_state(text, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_work_mentor_consent(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_work_mentor_consent_events(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_mentor_consent(text, boolean, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_work_thesis_stage(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_thesis_stage(text, text, timestamptz) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.set_work_thesis_stage(text, text, timestamptz);
DROP FUNCTION app.read_work_thesis_stage(text);
DROP FUNCTION app.set_work_mentor_consent(text, boolean, text);
DROP FUNCTION app.read_work_mentor_consent_events(text);
DROP FUNCTION app.read_work_mentor_consent(text);
DROP FUNCTION app.set_work_thesis_form_state(text, text, text);
DROP FUNCTION app.read_work_thesis_forms(text);
DROP FUNCTION app.set_thesis_setting(boolean);
DROP FUNCTION app.read_thesis_setting();
DROP FUNCTION institution.thesis_setting_now();
DROP FUNCTION app.publish_thesis_form(text, text, text[], boolean);
DROP FUNCTION app.read_thesis_forms();
DROP FUNCTION institution.thesis_work_context(text);
DROP TABLE institution.work_thesis_stage_event;
DROP TABLE institution.work_mentor_consent_event;
DROP TABLE institution.work_thesis_form_event;
DROP TABLE institution.thesis_setting;
DROP TABLE institution.thesis_form;
DROP FUNCTION institution.reject_thesis_record_change();
DROP FUNCTION institution.is_thesis_text(text, integer);
SET LOCAL ROLE ductus_migrator;
