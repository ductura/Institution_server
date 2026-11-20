-- migrate:up
-- SRV-28 (Ductus#2028, c.7009405737), part 1 of 2: the one decision on a
-- mentorship request that was still missing (SRV-27
-- teacher.mentorship-request-decision.post, decision "decline"; the
-- functions so far were request_, withdraw_ and approve_mentorship_request,
-- 20261104090000).
--
--   institution.decline_mentorship_request  the teacher the request was made
--                       to declines it. The row stays with declined_at; the
--                       reason (1 to 600 characters, optional; the bound PD-4
--                       proposes) is kept only in the audit row (P-6: the
--                       student is not shown it). A declined request is no
--                       longer open: it cannot be approved or withdrawn
--                       (ZD409), the teacher no longer reads it, and it no
--                       longer blocks a new request of the kind.
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed (also for what
-- does not exist or is someone else's), ZD409 the state forbids it, ZD422
-- invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

ALTER TABLE institution.mentorship_request ADD COLUMN declined_at timestamptz;
-- The table is new and small; the wider check is validated at once, in the
-- one transaction dbmate runs the migration in.
-- squawk-ignore ban-drop-constraint
ALTER TABLE institution.mentorship_request DROP CONSTRAINT mentorship_request_check1;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE institution.mentorship_request ADD CONSTRAINT mentorship_request_one_end_check
  CHECK (num_nonnulls(withdrawn_at, approved_at, declined_at) <= 1);
-- Open is now: neither withdrawn, approved nor declined.
DROP INDEX institution.mentorship_request_open_idx;
DROP INDEX institution.mentorship_request_teacher_open_idx;
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX mentorship_request_open_idx ON institution.mentorship_request (institution_id, student_id, work_type)
  WHERE withdrawn_at IS NULL AND approved_at IS NULL AND declined_at IS NULL;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX mentorship_request_teacher_open_idx ON institution.mentorship_request (teacher_id)
  WHERE withdrawn_at IS NULL AND approved_at IS NULL AND declined_at IS NULL;
ALTER POLICY mentorship_request_read ON institution.mentorship_request
  USING (
    institution_id = (SELECT app.current_institution_id())
    AND (student_id = (SELECT app.current_user_id())
         OR (teacher_id = (SELECT app.current_user_id())
             AND withdrawn_at IS NULL AND approved_at IS NULL AND declined_at IS NULL
             AND (SELECT institution.actor_has_role('teacher'))))
  );

ALTER TABLE audit.mentorship_event ADD COLUMN reason text;
-- squawk-ignore ban-drop-constraint
ALTER TABLE audit.mentorship_event DROP CONSTRAINT mentorship_event_kind_check;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE audit.mentorship_event ADD CONSTRAINT mentorship_event_kind_check
  CHECK (kind IN ('requested', 'withdrawn', 'approved', 'declined'));
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE audit.mentorship_event ADD CONSTRAINT mentorship_event_reason_check
  CHECK (reason IS NULL OR (kind = 'declined' AND char_length(reason) BETWEEN 1 AND 600 AND reason ~ '[^[:space:]]'));

-- As 20261104090000; a declined request is no longer open, so ZD409.
CREATE OR REPLACE FUNCTION institution.withdraw_mentorship_request(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req institution.mentorship_request;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.student_id = actor.user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  ELSIF req.approved_at IS NOT NULL OR req.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  ELSIF req.withdrawn_at IS NOT NULL THEN
    RETURN false;
  END IF;
  WITH withdrawn AS (
    UPDATE institution.mentorship_request r SET withdrawn_at = now() WHERE r.id = req.id
    RETURNING r.id, r.institution_id, r.student_id, r.teacher_id
  )
  INSERT INTO audit.mentorship_event (institution_id, request_id, student_id, teacher_id, kind, actor_id, occurred_at)
  SELECT institution_id, id, student_id, teacher_id, 'withdrawn', actor.user_id, now() FROM withdrawn;
  RETURN true;
END
$$;

-- As 20261104090000; a declined request cannot be approved: ZD409.
CREATE OR REPLACE FUNCTION institution.approve_mentorship_request(p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req institution.mentorship_request;
  v_mentorship uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'institution.mentorship_request:' || req.institution_id || ':' || req.student_id || ':' || req.work_type, 0));
  END IF;
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id
  FOR UPDATE;
  IF NOT FOUND OR institution.lock_teacher_role(actor.user_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  ELSIF req.approved_at IS NOT NULL THEN
    RETURN req.mentorship_id;
  ELSIF req.withdrawn_at IS NOT NULL OR req.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  BEGIN
    INSERT INTO institution.mentorship (institution_id, mentor_id, student_id, work_type, confirmed_by)
    VALUES (req.institution_id, actor.user_id, req.student_id, req.work_type, actor.user_id)
    RETURNING id INTO v_mentorship;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END;
  WITH approved AS (
    UPDATE institution.mentorship_request r SET approved_at = now(), mentorship_id = v_mentorship
    WHERE r.id = req.id
    RETURNING r.id, r.institution_id, r.student_id, r.teacher_id, r.mentorship_id
  )
  INSERT INTO audit.mentorship_event (
    institution_id, request_id, student_id, teacher_id, kind, actor_id, mentorship_id, occurred_at
  )
  SELECT institution_id, id, student_id, teacher_id, 'approved', actor.user_id, mentorship_id, now() FROM approved;
  RETURN v_mentorship;
END
$$;

-- The teacher the request was made to, with the teacher role confirmed and
-- not revoked, declines the open request. True when it is declined now,
-- false when it was already declined (nothing is written again); ZD409 once
-- it is approved or withdrawn. Anyone else, the administrator included, gets
-- ZD403 whatever the state. The row lock is taken before the role lock, in
-- the order of approve_mentorship_request, so a decision waits for the other.
CREATE FUNCTION institution.decline_mentorship_request(p_request_id uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req institution.mentorship_request;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_reason IS NOT NULL AND (char_length(p_reason) NOT BETWEEN 1 AND 600 OR p_reason !~ '[^[:space:]]') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id
  FOR UPDATE;
  IF NOT FOUND OR institution.lock_teacher_role(actor.user_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  ELSIF req.declined_at IS NOT NULL THEN
    RETURN false;
  ELSIF req.approved_at IS NOT NULL OR req.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  WITH declined AS (
    UPDATE institution.mentorship_request r SET declined_at = now() WHERE r.id = req.id
    RETURNING r.id, r.institution_id, r.student_id, r.teacher_id
  )
  INSERT INTO audit.mentorship_event (
    institution_id, request_id, student_id, teacher_id, kind, actor_id, reason, occurred_at
  )
  SELECT institution_id, id, student_id, teacher_id, 'declined', actor.user_id, p_reason, now() FROM declined;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION institution.decline_mentorship_request(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.decline_mentorship_request(uuid, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- Fails while a declined request exists, which the append-only trail keeps.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.decline_mentorship_request(uuid, text);
-- The bodies of 20261104090000 without the declined branch.
CREATE OR REPLACE FUNCTION institution.withdraw_mentorship_request(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req institution.mentorship_request;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.student_id = actor.user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  ELSIF req.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  ELSIF req.withdrawn_at IS NOT NULL THEN
    RETURN false;
  END IF;
  WITH withdrawn AS (
    UPDATE institution.mentorship_request r SET withdrawn_at = now() WHERE r.id = req.id
    RETURNING r.id, r.institution_id, r.student_id, r.teacher_id
  )
  INSERT INTO audit.mentorship_event (institution_id, request_id, student_id, teacher_id, kind, actor_id, occurred_at)
  SELECT institution_id, id, student_id, teacher_id, 'withdrawn', actor.user_id, now() FROM withdrawn;
  RETURN true;
END
$$;
CREATE OR REPLACE FUNCTION institution.approve_mentorship_request(p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  req institution.mentorship_request;
  v_mentorship uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'institution.mentorship_request:' || req.institution_id || ':' || req.student_id || ':' || req.work_type, 0));
  END IF;
  SELECT * INTO req FROM institution.mentorship_request r
  WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id
  FOR UPDATE;
  IF NOT FOUND OR institution.lock_teacher_role(actor.user_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  ELSIF req.approved_at IS NOT NULL THEN
    RETURN req.mentorship_id;
  ELSIF req.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  BEGIN
    INSERT INTO institution.mentorship (institution_id, mentor_id, student_id, work_type, confirmed_by)
    VALUES (req.institution_id, actor.user_id, req.student_id, req.work_type, actor.user_id)
    RETURNING id INTO v_mentorship;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END;
  WITH approved AS (
    UPDATE institution.mentorship_request r SET approved_at = now(), mentorship_id = v_mentorship
    WHERE r.id = req.id
    RETURNING r.id, r.institution_id, r.student_id, r.teacher_id, r.mentorship_id
  )
  INSERT INTO audit.mentorship_event (
    institution_id, request_id, student_id, teacher_id, kind, actor_id, mentorship_id, occurred_at
  )
  SELECT institution_id, id, student_id, teacher_id, 'approved', actor.user_id, mentorship_id, now() FROM approved;
  RETURN v_mentorship;
END
$$;
ALTER TABLE audit.mentorship_event DROP CONSTRAINT mentorship_event_reason_check;
ALTER TABLE audit.mentorship_event DROP CONSTRAINT mentorship_event_kind_check;
ALTER TABLE audit.mentorship_event ADD CONSTRAINT mentorship_event_kind_check
  CHECK (kind IN ('requested', 'withdrawn', 'approved'));
ALTER TABLE audit.mentorship_event DROP COLUMN reason;
ALTER POLICY mentorship_request_read ON institution.mentorship_request
  USING (
    institution_id = (SELECT app.current_institution_id())
    AND (student_id = (SELECT app.current_user_id())
         OR (teacher_id = (SELECT app.current_user_id()) AND withdrawn_at IS NULL AND approved_at IS NULL
             AND (SELECT institution.actor_has_role('teacher'))))
  );
DROP INDEX institution.mentorship_request_teacher_open_idx;
DROP INDEX institution.mentorship_request_open_idx;
CREATE INDEX mentorship_request_teacher_open_idx ON institution.mentorship_request (teacher_id)
  WHERE withdrawn_at IS NULL AND approved_at IS NULL;
CREATE UNIQUE INDEX mentorship_request_open_idx ON institution.mentorship_request (institution_id, student_id, work_type)
  WHERE withdrawn_at IS NULL AND approved_at IS NULL;
ALTER TABLE institution.mentorship_request DROP CONSTRAINT mentorship_request_one_end_check;
ALTER TABLE institution.mentorship_request ADD CONSTRAINT mentorship_request_check1
  CHECK (num_nonnulls(withdrawn_at, approved_at) <= 1);
ALTER TABLE institution.mentorship_request DROP COLUMN declined_at;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
