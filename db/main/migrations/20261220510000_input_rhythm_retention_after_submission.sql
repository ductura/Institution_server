-- migrate:up
-- RITAM-ROK-30D (Ductus#2059; Constitution v1.11 C-14, owner decision O1 of
-- 22. 11. 2026.): "The rhythm of typing is kept for 30 days after the
-- submission."
--
-- 20261213100300 gave every burst a date of deletion of 12 months after the
-- record (app.input_rhythm_retention_months()). The rule is now 30 days after
-- the submission of the work:
--
--   * A burst recorded while the work has no live submission carries no date
--     of deletion (delete_after is null): it is kept until the work is
--     submitted. The retention job keeps deleting only what is due
--     (delete_after <= now()), so it never deletes such a burst.
--   * Every recorded submission (evidence.submission, one per attempt) sets
--     the date of every burst of that work (the same institution, assignment
--     and student) to the submission's time (requested_at, the time the
--     lateness is decided by) + 30 days, unless the burst already has an
--     earlier date. A date is only ever shortened, never moved later: a
--     withdrawal or a return for revision does not bring a burst back.
--   * A burst recorded while the work has a live submission (not withdrawn
--     and not returned) gets that submission's date; if that date has already
--     passed, nothing is recorded and the call answers false, as while the
--     recording is switched off (a burst would be due the moment it is
--     written).
--   * Every burst recorded before this migration keeps the earlier of its
--     date and the date the rule gives it: the first submission of the work
--     recorded at or after the burst, or else the live submission, + 30 days.
--     A burst of a work that was never submitted keeps its date.
--
-- The constant moves from months to days: app.input_rhythm_retention_days()
-- (30) replaces app.input_rhythm_retention_months(), whose only callers
-- (app.input_rhythm_add, last replaced by 20261213110100) are replaced here.
-- The check delete_after > recorded_at goes: the date now follows the
-- submission, not the record, so a burst written after a submission may be
-- due from a time before its record.
--
-- Unchanged: who switches the recording (only the teacher), the matching with
-- the assistant, the RPCs and their answers, and the retention job
-- (app.input_rhythm_purge for the retention role only). No table is added.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app, evidence TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

-- 1. The constant of the configuration, in days after the submission.
CREATE FUNCTION app.input_rhythm_retention_days() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 30 $$;
REVOKE ALL ON FUNCTION app.input_rhythm_retention_days() FROM PUBLIC;

-- 2. The date: null until the work is submitted.
ALTER TABLE evidence.input_rhythm ALTER COLUMN delete_after DROP NOT NULL;
ALTER TABLE evidence.input_rhythm DROP CONSTRAINT input_rhythm_check;

-- The date of deletion of a burst written now: the live submission of the
-- work (the latest one not withdrawn and not returned) + 30 days, or null.
CREATE FUNCTION evidence.input_rhythm_due(p_institution_id uuid, p_assignment_id uuid, p_student_id uuid)
RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT s.requested_at + make_interval(days => app.input_rhythm_retention_days())
    FROM evidence.submission s
   WHERE s.institution_id = p_institution_id AND s.assignment_id = p_assignment_id
     AND s.principal_id = p_student_id AND NOT evidence.submission_withdrawn(s.id)
   ORDER BY s.requested_at DESC, s.recorded_at DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION evidence.input_rhythm_due(uuid, uuid, uuid) FROM PUBLIC;

-- The transaction lock of the rhythm of one work. A burst and a submission of
-- the same work take it before they read or set the date, so they never pass
-- each other unseen: the server's transactions are READ COMMITTED
-- (server/database/with-actor.ts), and the statement after the lock reads what
-- the other one committed. Without it a burst could read "no submission" while
-- the submission's trigger could not yet see the burst, and the burst would
-- keep no date for good.
CREATE FUNCTION evidence.input_rhythm_lock(p_institution_id uuid, p_assignment_id uuid, p_student_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(
    'evidence.input_rhythm:' || p_institution_id::text || ':' || p_assignment_id::text || ':' || p_student_id::text, 0))
$$;
REVOKE ALL ON FUNCTION evidence.input_rhythm_lock(uuid, uuid, uuid) FROM PUBLIC;

-- 3. A submission sets the date of the bursts of its work; only shorter.
-- Runs as the inserting role (app.record_submission belongs to the evidence
-- role), as evidence.close_submitted_packages does.
CREATE FUNCTION evidence.input_rhythm_due_on_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_due timestamptz := NEW.requested_at + make_interval(days => app.input_rhythm_retention_days());
BEGIN
  PERFORM evidence.input_rhythm_lock(NEW.institution_id, NEW.assignment_id, NEW.principal_id);
  UPDATE evidence.input_rhythm r SET delete_after = v_due
   WHERE r.institution_id = NEW.institution_id AND r.assignment_id = NEW.assignment_id
     AND r.student_id = NEW.principal_id AND (r.delete_after IS NULL OR r.delete_after > v_due);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION evidence.input_rhythm_due_on_submission() FROM PUBLIC;
CREATE TRIGGER evidence_submission_sets_rhythm_due AFTER INSERT ON evidence.submission
  FOR EACH ROW EXECUTE FUNCTION evidence.input_rhythm_due_on_submission();

-- 4. As 20261213110100 (the assignment's switch), with the date of 2.
CREATE OR REPLACE FUNCTION app.input_rhythm_add(p_assignment_id uuid, p_student_id uuid, p_gaps integer[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_gaps integer[];
  v_n integer := cardinality(p_gaps);
  v_due timestamptz;
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL THEN RETURN false; END IF;
  IF NOT app.input_rhythm_assignment_on(p_assignment_id) THEN
    RETURN false;
  END IF;
  PERFORM evidence.input_rhythm_lock(v_institution, p_assignment_id, p_student_id);
  v_due := evidence.input_rhythm_due(v_institution, p_assignment_id, p_student_id);
  -- More than 30 days after the live submission: it would be due at once.
  IF v_due IS NOT NULL AND v_due <= now() THEN
    RETURN false;
  END IF;
  IF v_n > 130 THEN
    SELECT array_agg(p_gaps[1 + (i * v_n) / 130] ORDER BY i) INTO v_gaps FROM generate_series(0, 129) i;
  ELSE
    v_gaps := p_gaps;
  END IF;
  INSERT INTO evidence.input_rhythm (institution_id, assignment_id, student_id, gaps_ms, delete_after)
  VALUES (v_institution, p_assignment_id, p_student_id, v_gaps, v_due);
  RETURN true;
END
$$;

-- 5. The bursts recorded before this migration: only shorter. A function of
-- the owner, so that pgTAP can run the same statement on its own rows; it
-- only ever shortens a date, so running it again changes nothing.
CREATE FUNCTION evidence.input_rhythm_shorten_due() RETURNS integer
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  WITH u AS (
    UPDATE evidence.input_rhythm r
       SET delete_after = d.due
      FROM (
        SELECT x.id, least(
                 x.delete_after,
                 (SELECT min(s.requested_at) FROM evidence.submission s
                   WHERE s.institution_id = x.institution_id AND s.assignment_id = x.assignment_id
                     AND s.principal_id = x.student_id AND s.recorded_at >= x.recorded_at)
                   + make_interval(days => app.input_rhythm_retention_days()),
                 evidence.input_rhythm_due(x.institution_id, x.assignment_id, x.student_id)) AS due
          FROM evidence.input_rhythm x) d
     WHERE d.id = r.id AND d.due IS DISTINCT FROM r.delete_after
    RETURNING 1)
  SELECT count(*)::integer FROM u
$$;
REVOKE ALL ON FUNCTION evidence.input_rhythm_shorten_due() FROM PUBLIC;
SELECT evidence.input_rhythm_shorten_due();

-- 6. The months are gone.
DROP FUNCTION app.input_rhythm_retention_months();

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- A shortened date is not lengthened back; a burst without a date gets 12
-- months from its record, as before.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, evidence TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION app.input_rhythm_retention_months() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 12 $$;
REVOKE ALL ON FUNCTION app.input_rhythm_retention_months() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.input_rhythm_retention_months() TO ductus_identity;
CREATE OR REPLACE FUNCTION app.input_rhythm_add(p_assignment_id uuid, p_student_id uuid, p_gaps integer[])
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
  IF NOT app.input_rhythm_assignment_on(p_assignment_id) THEN
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
DROP TRIGGER evidence_submission_sets_rhythm_due ON evidence.submission;
DROP FUNCTION evidence.input_rhythm_due_on_submission();
DROP FUNCTION evidence.input_rhythm_shorten_due();
DROP FUNCTION evidence.input_rhythm_lock(uuid, uuid, uuid);
DROP FUNCTION evidence.input_rhythm_due(uuid, uuid, uuid);
UPDATE evidence.input_rhythm
   SET delete_after = greatest(recorded_at, now()) + make_interval(months => app.input_rhythm_retention_months())
 WHERE delete_after IS NULL;
DELETE FROM evidence.input_rhythm WHERE delete_after <= recorded_at;
ALTER TABLE evidence.input_rhythm ADD CONSTRAINT input_rhythm_check CHECK (delete_after > recorded_at);
ALTER TABLE evidence.input_rhythm ALTER COLUMN delete_after SET NOT NULL;
DROP FUNCTION app.input_rhythm_retention_days();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, evidence FROM ductus_evidence;
