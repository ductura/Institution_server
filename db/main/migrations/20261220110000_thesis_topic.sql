-- migrate:up
-- SRV-V16-TEMA-PRIJEDLOG (val16-razlika, Ductus#2058): the student owner of a
-- thesis proposes the topic (a title and a short description) and the mentor
-- approves it or returns it with a comment. Nothing here enters a grade and
-- nothing changes the faculty form "prijava-teme" (a separate record, see
-- 20261216120000_thesis_forms_consent.sql); joining the two is the owner's decision.
--
--   institution.work_thesis_topic_version   every proposal of the student, one
--                                           version per proposal, append-only
--   institution.work_thesis_topic_decision  every decision of the mentor on one
--                                           version, append-only; the newest on
--                                           the newest version holds
--
-- State of the topic of one work (derived, never stored):
--   none      no version yet
--   proposed  the newest version has no decision
--   approved  the newest decision on the newest version approves it
--   returned  the newest decision on the newest version returns it
-- Moves: none -> proposed; proposed -> proposed (a new version, student),
-- approved or returned (mentor); returned -> proposed (a new version, student);
-- approved -> returned (the mentor only, with a reason). Everything else is ZD409.
--
-- Who (C-23, from the relation, through institution.thesis_work_context):
--   read      the student owner, the mentor, the administrator of the institution
--   propose   the student owner only (mentor and administrator: ZD403)
--   decide    the mentor only (student and administrator: ZD403)
-- A person with no part in the work, a course teacher included, another
-- institution and a work that is not the work of a mentorship read ZD404.
-- Nothing here reads or copies the content of the work.
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed, ZD404 not there
-- or no part in it, ZD409 wrong state or an old version, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_thesis_topic_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100),
  title text NOT NULL CHECK (institution.is_thesis_text(title, 200) AND title !~ '[\n\t]'),
  summary text NOT NULL CHECK (summary = '' OR institution.is_thesis_text(summary, 1000)),
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (institution_id, document_id, version),
  FOREIGN KEY (proposed_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_thesis_topic_version_author_idx
  ON institution.work_thesis_topic_version (proposed_by, institution_id);

CREATE TABLE institution.work_thesis_topic_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'returned')),
  comment text CHECK (comment IS NULL OR institution.is_thesis_text(comment, 1000)),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (decision <> 'returned' OR comment IS NOT NULL),
  FOREIGN KEY (institution_id, document_id, version)
    REFERENCES institution.work_thesis_topic_version (institution_id, document_id, version),
  FOREIGN KEY (decided_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_thesis_topic_decision_work_idx
  ON institution.work_thesis_topic_decision (institution_id, document_id, version, seq);
CREATE INDEX work_thesis_topic_decision_actor_idx
  ON institution.work_thesis_topic_decision (decided_by, institution_id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
-- institution.reject_thesis_record_change() is the one of the thesis migration.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_thesis_topic_version', 'work_thesis_topic_decision'] LOOP
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

-- The topic in force of one work of the caller's institution: the state, the
-- newest version and the decision on that version. Internal: the callers have
-- already passed thesis_work_context.
CREATE FUNCTION institution.thesis_topic_now(p_institution_id uuid, p_document_id text)
RETURNS TABLE (
  state text, version integer, title text, summary text, proposed_at timestamptz,
  decision text, decision_comment text, decided_at timestamptz
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE WHEN v.id IS NULL THEN 'none' WHEN d.id IS NULL THEN 'proposed' ELSE d.decision END,
         v.version, v.title, v.summary, v.proposed_at, d.decision, d.comment, d.decided_at
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT x.* FROM institution.work_thesis_topic_version x
       WHERE x.institution_id = p_institution_id AND x.document_id = p_document_id
       ORDER BY x.version DESC LIMIT 1) v ON true
    LEFT JOIN LATERAL (
      SELECT y.* FROM institution.work_thesis_topic_decision y
       WHERE y.institution_id = p_institution_id AND y.document_id = p_document_id AND y.version = v.version
       ORDER BY y.seq DESC LIMIT 1) d ON true
$$;

CREATE FUNCTION app.read_work_thesis_topic(p_document_id text)
RETURNS TABLE (
  state text, version integer, title text, summary text, proposed_at timestamptz,
  decision text, decision_comment text, decided_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY SELECT * FROM institution.thesis_topic_now(v_ctx.o_institution_id, p_document_id);
END
$$;

-- Every version, oldest first (at most 100: the number of versions is capped).
CREATE FUNCTION app.read_work_thesis_topic_history(p_document_id text)
RETURNS TABLE (version integer, title text, summary text, proposed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY
    SELECT x.version, x.title, x.summary, x.proposed_at FROM institution.work_thesis_topic_version x
     WHERE x.institution_id = v_ctx.o_institution_id AND x.document_id = p_document_id
     ORDER BY x.version;
END
$$;

-- The student owner proposes the topic: a new version. The content of the
-- newest version writes nothing. After approval: ZD409. The 101st version: ZD409.
CREATE FUNCTION app.set_work_thesis_topic(p_document_id text, p_title text, p_summary text)
RETURNS TABLE (
  state text, version integer, title text, summary text, proposed_at timestamptz,
  decision text, decision_comment text, decided_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_now record;
  v_summary text := coalesce(p_summary, '');
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  IF v_ctx.o_part <> 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT institution.is_thesis_text(p_title, 200) OR p_title ~ '[\n\t]'
     OR (v_summary <> '' AND NOT institution.is_thesis_text(v_summary, 1000)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('work_thesis_topic:' || v_ctx.o_institution_id || ':' || p_document_id, 0));
  SELECT * INTO v_now FROM institution.thesis_topic_now(v_ctx.o_institution_id, p_document_id);
  IF v_now.state = 'approved' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF v_now.title IS DISTINCT FROM p_title OR v_now.summary IS DISTINCT FROM v_summary THEN
    IF coalesce(v_now.version, 0) >= 100 THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    INSERT INTO institution.work_thesis_topic_version
      (institution_id, document_id, version, title, summary, proposed_by)
    VALUES (v_ctx.o_institution_id, p_document_id, coalesce(v_now.version, 0) + 1, p_title, v_summary,
            v_ctx.o_user_id);
  END IF;
  RETURN QUERY SELECT * FROM institution.thesis_topic_now(v_ctx.o_institution_id, p_document_id);
END
$$;

-- The mentor decides on the newest version. A version that is not the newest
-- (or no version at all) is ZD409, as is a move the state does not allow:
-- approved -> approved, returned -> anything. 'returned' needs a comment.
CREATE FUNCTION app.decide_work_thesis_topic(p_document_id text, p_version integer, p_decision text, p_comment text)
RETURNS TABLE (
  state text, version integer, title text, summary text, proposed_at timestamptz,
  decision text, decision_comment text, decided_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_now record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  IF v_ctx.o_part <> 'mentor' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_version IS NULL OR p_version < 1 OR p_decision IS NULL OR p_decision NOT IN ('approved', 'returned')
     OR (p_comment IS NOT NULL AND NOT institution.is_thesis_text(p_comment, 1000))
     OR (p_decision = 'returned' AND p_comment IS NULL) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('work_thesis_topic:' || v_ctx.o_institution_id || ':' || p_document_id, 0));
  SELECT * INTO v_now FROM institution.thesis_topic_now(v_ctx.o_institution_id, p_document_id);
  IF v_now.version IS DISTINCT FROM p_version
     OR v_now.state = 'returned'
     OR (v_now.state = 'approved' AND p_decision <> 'returned') THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_thesis_topic_decision
    (institution_id, document_id, version, decision, comment, decided_by)
  VALUES (v_ctx.o_institution_id, p_document_id, p_version, p_decision, p_comment, v_ctx.o_user_id);
  RETURN QUERY SELECT * FROM institution.thesis_topic_now(v_ctx.o_institution_id, p_document_id);
END
$$;

REVOKE ALL ON FUNCTION institution.thesis_topic_now(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_thesis_topic(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_thesis_topic_history(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_thesis_topic(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.decide_work_thesis_topic(text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_thesis_topic(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.read_work_thesis_topic_history(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_thesis_topic(text, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.decide_work_thesis_topic(text, integer, text, text) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.decide_work_thesis_topic(text, integer, text, text);
DROP FUNCTION app.set_work_thesis_topic(text, text, text);
DROP FUNCTION app.read_work_thesis_topic_history(text);
DROP FUNCTION app.read_work_thesis_topic(text);
DROP FUNCTION institution.thesis_topic_now(uuid, text);
DROP TABLE institution.work_thesis_topic_decision;
DROP TABLE institution.work_thesis_topic_version;
SET LOCAL ROLE ductus_migrator;
