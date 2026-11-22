-- migrate:up
-- SRV-0910 (Ductus#2052; P-1, rules 1, 4 and 8): the kind of origin of a
-- change and the rhythm of typing, two classes of evidence of one work.
--
--   evidence.origin_change     one change with its kind from the closed list
--                              (typed, assistant_inserted, assistant_match,
--                              imported_file, pasted_known, pasted_unknown)
--                              and its size in characters. The kind is fixed
--                              when the change is entered. The only later
--                              change is pasted_unknown -> pasted_known when
--                              the student explains the paste; the original
--                              kind is kept in original_kind. Nothing is
--                              deleted.
--   evidence.input_rhythm      the gaps in milliseconds between inputs inside
--                              one burst, at most 130 values per burst, thinned
--                              by the server. No key, no content, no measure
--                              derived from the gaps: no speed, no average, no
--                              profile, no comparison, and nothing here reads
--                              them into a model. Each row has its own date of
--                              deletion (app.input_rhythm_retention_months(),
--                              a constant of the configuration; the proposal is
--                              the end of the academic year, at most 12 months
--                              after the submission, here 12 months after the
--                              record) and a job that deletes what is due.
--   evidence.input_rhythm_setting  the student's switch; on by default; it
--                              holds from the moment of switching off: nothing
--                              is recorded and nothing is read while it is off.
--
-- Only through the RPCs. The tables belong to the evidence role with forced RLS
-- and no privilege for any other role; the web role executes only the RPCs
-- named below. Who may write comes from the relation to the work (the student
-- owner of the document), who may read from the relation too (the owner, or a
-- reader of the work as for the event records): C-23. One answer, ZD403, for
-- every refusal, also for an unknown document. ZD401 no session, ZD422 invalid
-- input. The composition is the same answer for the student and the teacher.
--
--   app.work_origin_record       the student records a change (kind, characters)
--   app.work_origin_explain      the student explains a paste of unknown origin
--   app.work_origin_composition  the share per kind, in the fixed order of the list
--   app.input_rhythm_record      the student records one burst (false when off)
--   app.input_rhythm_set         the student switches the recording on or off
--   app.input_rhythm_delete      the student deletes the recorded rhythm of a work
--   app.input_rhythm_read        the bursts of a work, only while the switch is on
--   app.input_rhythm_purge       the retention job deletes what is due
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT USAGE ON SCHEMA institution, identity TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.assignment, identity.user_account TO ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.origin_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN
    ('typed', 'assistant_inserted', 'assistant_match', 'imported_file', 'pasted_known', 'pasted_unknown')),
  original_kind text CHECK (original_kind = 'pasted_unknown'),
  characters integer NOT NULL CHECK (characters BETWEEN 1 AND 10000000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'pasted_known') = (original_kind IS NOT NULL)),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX origin_change_work_idx ON evidence.origin_change (institution_id, assignment_id, student_id, seq);

CREATE FUNCTION evidence.origin_change_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind = 'pasted_unknown' AND NEW.kind = 'pasted_known'
     AND NEW.original_kind = 'pasted_unknown'
     AND NEW.id = OLD.id AND NEW.seq = OLD.seq AND NEW.institution_id = OLD.institution_id
     AND NEW.assignment_id = OLD.assignment_id AND NEW.student_id = OLD.student_id
     AND NEW.characters = OLD.characters AND NEW.recorded_at = OLD.recorded_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'origin change is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER origin_change_guard BEFORE UPDATE OR DELETE ON evidence.origin_change
  FOR EACH ROW EXECUTE FUNCTION evidence.origin_change_guard();
CREATE TRIGGER origin_change_no_truncate BEFORE TRUNCATE ON evidence.origin_change
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.origin_change_guard();
ALTER TABLE evidence.origin_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.origin_change FORCE ROW LEVEL SECURITY;
CREATE POLICY origin_change_owner ON evidence.origin_change TO ductus_evidence USING (true) WITH CHECK (true);

CREATE TABLE evidence.input_rhythm (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- Gaps between inputs of one burst, in milliseconds; at most 130 values.
  gaps_ms integer[] NOT NULL CHECK (cardinality(gaps_ms) BETWEEN 1 AND 130 AND array_ndims(gaps_ms) = 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  delete_after timestamptz NOT NULL,
  CHECK (delete_after > recorded_at),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX input_rhythm_work_idx ON evidence.input_rhythm (institution_id, assignment_id, student_id, seq);
CREATE INDEX input_rhythm_due_idx ON evidence.input_rhythm (delete_after);
ALTER TABLE evidence.input_rhythm ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.input_rhythm FORCE ROW LEVEL SECURITY;
CREATE POLICY input_rhythm_owner ON evidence.input_rhythm TO ductus_evidence USING (true) WITH CHECK (true);

CREATE TABLE evidence.input_rhythm_setting (
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  enabled boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, user_id),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
ALTER TABLE evidence.input_rhythm_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.input_rhythm_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY input_rhythm_setting_owner ON evidence.input_rhythm_setting TO ductus_evidence USING (true) WITH CHECK (true);

-- Retention of the rhythm, a constant of the configuration (months).
CREATE FUNCTION app.input_rhythm_retention_months() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 12 $$;

-- Evidence-owned workers, called only by the identity-owned RPCs below.
CREATE FUNCTION app.origin_change_add(p_assignment_id uuid, p_student_id uuid, p_kind text, p_characters integer)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO evidence.origin_change (institution_id, assignment_id, student_id, kind, characters)
  SELECT a.institution_id, p_assignment_id, p_student_id, p_kind, p_characters
    FROM app.current_actor() a WHERE a.institution_id IS NOT NULL
  RETURNING id
$$;

CREATE FUNCTION app.origin_change_explain(p_assignment_id uuid, p_student_id uuid, p_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH u AS (
    UPDATE evidence.origin_change c SET kind = 'pasted_known', original_kind = 'pasted_unknown'
      FROM app.current_actor() a
     WHERE c.id = p_id AND c.institution_id = a.institution_id AND c.assignment_id = p_assignment_id
       AND c.student_id = p_student_id AND c.kind = 'pasted_unknown'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE FUNCTION app.origin_composition_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (kind text, percent numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH k (kind, ord) AS (
    VALUES ('typed', 1), ('assistant_inserted', 2), ('assistant_match', 3),
           ('imported_file', 4), ('pasted_known', 5), ('pasted_unknown', 6)),
  s AS (
    SELECT c.kind, sum(c.characters)::numeric AS chars
      FROM app.current_actor() a
      JOIN evidence.origin_change c
        ON c.institution_id = a.institution_id AND c.assignment_id = p_assignment_id AND c.student_id = p_student_id
     GROUP BY c.kind),
  t AS (SELECT coalesce(sum(chars), 0) AS total FROM s)
  SELECT k.kind, CASE WHEN t.total = 0 THEN 0 ELSE round(100 * coalesce(s.chars, 0) / t.total, 1) END
    FROM k CROSS JOIN t LEFT JOIN s ON s.kind = k.kind
   ORDER BY k.ord
$$;

-- Thins a burst to at most 130 values, evenly, keeping the first.
CREATE FUNCTION app.input_rhythm_add(p_assignment_id uuid, p_student_id uuid, p_gaps integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_gaps integer[];
  v_n integer := cardinality(p_gaps);
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL THEN RETURN false; END IF;
  IF NOT coalesce((SELECT s.enabled FROM evidence.input_rhythm_setting s
                    WHERE s.institution_id = v_institution AND s.user_id = p_student_id), true) THEN
    RETURN false;
  END IF;
  IF v_n > 130 THEN
    SELECT array_agg(p_gaps[1 + (i * v_n) / 130] ORDER BY i) INTO v_gaps FROM generate_series(0, 129) i;
  ELSE
    v_gaps := p_gaps;
  END IF;
  INSERT INTO evidence.input_rhythm (institution_id, assignment_id, student_id, gaps_ms, delete_after)
  VALUES (v_institution, p_assignment_id, p_student_id, v_gaps,
          now() + make_interval(months => app.input_rhythm_retention_months()));
  RETURN true;
END
$$;

CREATE FUNCTION app.input_rhythm_setting_put(p_user_id uuid, p_enabled boolean)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO evidence.input_rhythm_setting AS s (institution_id, user_id, enabled)
  SELECT a.institution_id, p_user_id, p_enabled FROM app.current_actor() a WHERE a.institution_id IS NOT NULL
  ON CONFLICT (institution_id, user_id) DO UPDATE SET enabled = excluded.enabled, changed_at = now()
$$;

CREATE FUNCTION app.input_rhythm_remove(p_assignment_id uuid, p_student_id uuid)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH d AS (
    DELETE FROM evidence.input_rhythm r USING app.current_actor() a
     WHERE r.institution_id = a.institution_id AND r.assignment_id = p_assignment_id AND r.student_id = p_student_id
    RETURNING 1)
  SELECT count(*)::integer FROM d
$$;

CREATE FUNCTION app.input_rhythm_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (id uuid, gaps_ms integer[], recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.id, r.gaps_ms, r.recorded_at
    FROM app.current_actor() a
    JOIN evidence.input_rhythm r
      ON r.institution_id = a.institution_id AND r.assignment_id = p_assignment_id AND r.student_id = p_student_id
   WHERE coalesce((SELECT s.enabled FROM evidence.input_rhythm_setting s
                    WHERE s.institution_id = a.institution_id AND s.user_id = p_student_id), true)
   ORDER BY r.seq
$$;

CREATE FUNCTION app.input_rhythm_purge_due() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH d AS (DELETE FROM evidence.input_rhythm WHERE delete_after <= now() RETURNING 1)
  SELECT count(*)::integer FROM d
$$;

REVOKE ALL ON FUNCTION app.input_rhythm_retention_months() FROM PUBLIC;
REVOKE ALL ON FUNCTION evidence.origin_change_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.origin_change_add(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.origin_change_explain(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.origin_composition_of(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_add(uuid, uuid, integer[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_setting_put(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_remove(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_of(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_purge_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_retention_months() TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.origin_change_add(uuid, uuid, text, integer) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.origin_change_explain(uuid, uuid, uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.origin_composition_of(uuid, uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_add(uuid, uuid, integer[]) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_setting_put(uuid, boolean) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_remove(uuid, uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_of(uuid, uuid) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.input_rhythm_purge_due() TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The relation of the caller to the work behind a document id. The owner is
-- the student of the work; a reader is as for the event records. With
-- p_owner_only, only the owner passes. Every refusal is ZD403.
CREATE FUNCTION app.origin_work_access(p_document_id text, p_owner_only boolean)
RETURNS TABLE (assignment_id uuid, student_id uuid, is_owner boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_scope record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF v_scope.institution_id IS DISTINCT FROM v_institution OR v_scope.assignment_id IS NULL
     OR v_scope.principal_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_scope.principal_id = v_user THEN
    IF collaboration.actor_role(v_institution, v_scope.assignment_id, v_user) IS DISTINCT FROM 'student' THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
    END IF;
    RETURN QUERY SELECT v_scope.assignment_id, v_user, true;
    RETURN;
  END IF;
  IF p_owner_only OR audit.reader_role(v_institution, v_scope.assignment_id, v_scope.principal_id) IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = v_scope.assignment_id AND s.institution_id = v_institution
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = v_scope.principal_id AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship t
                           WHERE t.id = s.mentorship_id AND t.institution_id = s.institution_id
                             AND t.student_id = v_scope.principal_id))) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT v_scope.assignment_id, v_scope.principal_id, false;
END
$$;
REVOKE ALL ON FUNCTION app.origin_work_access(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.origin_work_access(text, boolean) TO ductus_app;

CREATE FUNCTION app.work_origin_record(p_document_id text, p_kind text, p_characters integer)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_kind IS NULL OR p_kind NOT IN ('typed', 'assistant_inserted', 'assistant_match', 'imported_file',
                                      'pasted_known', 'pasted_unknown')
     OR p_characters IS NULL OR p_characters NOT BETWEEN 1 AND 10000000 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- A paste is recorded as unknown; it becomes known only by the explanation.
  IF p_kind = 'pasted_known' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.origin_change_add(v_access.assignment_id, v_access.student_id, p_kind, p_characters);
END
$$;

CREATE FUNCTION app.work_origin_explain(p_document_id text, p_change_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_change_id IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.origin_change_explain(v_access.assignment_id, v_access.student_id, p_change_id);
END
$$;

CREATE FUNCTION app.work_origin_composition(p_document_id text)
RETURNS TABLE (kind text, percent numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.origin_composition_of(v_access.assignment_id, v_access.student_id);
END
$$;

CREATE FUNCTION app.input_rhythm_record(p_document_id text, p_gaps_ms integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_gaps_ms IS NULL OR array_ndims(p_gaps_ms) IS DISTINCT FROM 1 OR cardinality(p_gaps_ms) < 1
     OR cardinality(p_gaps_ms) > 5000 OR EXISTS (
       SELECT 1 FROM unnest(p_gaps_ms) g WHERE g IS NULL OR g < 0 OR g > 3600000) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.input_rhythm_add(v_access.assignment_id, v_access.student_id, p_gaps_ms);
END
$$;

CREATE FUNCTION app.input_rhythm_set(p_enabled boolean)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT r.user_id INTO v_user FROM institution.require_actor() r;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM app.input_rhythm_setting_put(v_user, p_enabled);
END
$$;

CREATE FUNCTION app.input_rhythm_delete(p_document_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.input_rhythm_remove(v_access.assignment_id, v_access.student_id);
END
$$;

CREATE FUNCTION app.input_rhythm_read(p_document_id text)
RETURNS TABLE (id uuid, gaps_ms integer[], recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.input_rhythm_of(v_access.assignment_id, v_access.student_id);
END
$$;

-- The retention job, for the retention role only.
CREATE FUNCTION app.input_rhythm_purge() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT app.input_rhythm_purge_due() $$;

REVOKE ALL ON FUNCTION app.work_origin_record(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_origin_explain(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_origin_composition(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_record(text, integer[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_set(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_delete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_read(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.input_rhythm_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_origin_record(text, text, integer) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.work_origin_explain(text, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.work_origin_composition(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_record(text, integer[]) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_set(boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_delete(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_read(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.input_rhythm_purge() TO ductus_retention;

REVOKE REFERENCES ON institution.assignment, identity.user_account FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE USAGE ON SCHEMA institution, identity FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.input_rhythm_purge();
DROP FUNCTION app.input_rhythm_read(text);
DROP FUNCTION app.input_rhythm_delete(text);
DROP FUNCTION app.input_rhythm_set(boolean);
DROP FUNCTION app.input_rhythm_record(text, integer[]);
DROP FUNCTION app.work_origin_composition(text);
DROP FUNCTION app.work_origin_explain(text, uuid);
DROP FUNCTION app.work_origin_record(text, text, integer);
DROP FUNCTION app.origin_work_access(text, boolean);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.input_rhythm_purge_due();
DROP FUNCTION app.input_rhythm_of(uuid, uuid);
DROP FUNCTION app.input_rhythm_remove(uuid, uuid);
DROP FUNCTION app.input_rhythm_setting_put(uuid, boolean);
DROP FUNCTION app.input_rhythm_add(uuid, uuid, integer[]);
DROP FUNCTION app.origin_composition_of(uuid, uuid);
DROP FUNCTION app.origin_change_explain(uuid, uuid, uuid);
DROP FUNCTION app.origin_change_add(uuid, uuid, text, integer);
DROP FUNCTION app.input_rhythm_retention_months();
DROP TABLE evidence.input_rhythm_setting;
DROP TABLE evidence.input_rhythm;
DROP TABLE evidence.origin_change;
DROP FUNCTION evidence.origin_change_guard();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
