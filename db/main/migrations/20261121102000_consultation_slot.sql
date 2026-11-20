-- migrate:up
-- SRV-1104 (Ductus#2051; plan "Val 11", E§3.5 mentor2 "Konzultacije", N-12,
-- PO-22): the consultation slots of a work. The student asks for a time, the
-- teacher of the work confirms it or answers with another time, and the
-- student accepts that other time. A slot belongs to the work, as a comment
-- does (D-266): nothing here touches the document or its hash chain.
--
-- States and who moves them:
--   requested   the student proposed startsAt
--   countered   the teacher proposed another startsAt instead
--   confirmed   the teacher confirmed a requested time (action confirm), or
--               the student accepted the teacher's time (action accept)
--
--   action    by       from        to          startsAt
--   confirm   teacher  requested   confirmed    none
--   counter   teacher  requested   countered    the new time
--   accept    student  countered   confirmed    none
--
-- A person of the wrong role is refused as a person with no relation to the
-- work (ZD403); an action the state does not allow is ZD409. Access comes from
-- the caller's relation to the work (collaboration.actor_role: the teacher of
-- its assignment, or the student who owns it), never from a role alone (C-23).
-- A work is named by its document id, as in the comments; the institution and
-- the caller come from the session. Errors carry no input: ZD401 no session,
-- ZD403 no relation (one answer for every refusal, also for an unknown work
-- or slot), ZD409 a state that does not allow the action, ZD422 invalid
-- input (a time in the past or too far ahead, an unknown action, more than 20
-- slots not yet confirmed).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.consultation_slot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (char_length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('requested', 'countered', 'confirmed')),
  proposed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX consultation_slot_document_idx ON institution.consultation_slot (institution_id, document_id, starts_at, id);
CREATE INDEX consultation_slot_student_idx ON institution.consultation_slot (student_id);
CREATE INDEX consultation_slot_assignment_idx ON institution.consultation_slot (assignment_id, institution_id);

ALTER TABLE institution.consultation_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.consultation_slot FORCE ROW LEVEL SECURITY;
CREATE POLICY consultation_slot_owner ON institution.consultation_slot TO ductus_identity USING (true) WITH CHECK (true);

-- The slots of one work, by time, then by id: for the student who owns it and
-- the teacher of its assignment. One STABLE read; writes nothing.
CREATE FUNCTION institution.consultation_slots(p_document_id text)
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
     ORDER BY s.starts_at, s.id;
END
$$;

-- The student of the work asks for a time. The time must lie ahead, at most
-- a year; a work holds at most 20 slots not yet confirmed.
CREATE FUNCTION institution.request_consultation_slot(p_document_id text, p_starts_at timestamptz)
RETURNS TABLE (id uuid, starts_at timestamptz, proposed_at timestamptz, state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_scope record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id)
       IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at <= statement_timestamp()
     OR p_starts_at > statement_timestamp() + interval '1 year' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One writer per work at a time, so the bound below holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('consultation_slot:' || v_scope.institution_id || ':' || p_document_id, 0));
  IF (SELECT count(*) FROM institution.consultation_slot s
       WHERE s.institution_id = v_scope.institution_id AND s.document_id = p_document_id
         AND s.state <> 'confirmed') >= 20 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.consultation_slot AS s
      (institution_id, document_id, assignment_id, student_id, starts_at, state)
    VALUES (v_scope.institution_id, p_document_id, v_scope.assignment_id, v_scope.principal_id,
            p_starts_at, 'requested')
    RETURNING s.id, s.starts_at, s.proposed_at, s.state;
END
$$;

-- confirm, counter and accept, as in the table above.
CREATE FUNCTION institution.act_on_consultation_slot(p_document_id text, p_slot_id uuid, p_action text,
                                                     p_starts_at timestamptz DEFAULT NULL)
RETURNS TABLE (id uuid, starts_at timestamptz, proposed_at timestamptz, state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_scope record;
  v_role text;
  v_need_role text;
  v_need_state text;
  v_slot institution.consultation_slot;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('confirm', 'counter', 'accept')
     OR (p_action = 'counter') <> (p_starts_at IS NOT NULL)
     OR (p_action = 'counter' AND (p_starts_at <= statement_timestamp()
                                   OR p_starts_at > statement_timestamp() + interval '1 year')) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- The slot must be one of this work; another's reads as none.
  SELECT * INTO v_slot FROM institution.consultation_slot s
   WHERE s.id = p_slot_id AND s.institution_id = v_scope.institution_id AND s.document_id = p_document_id
   FOR UPDATE;
  v_need_role := CASE WHEN p_action = 'accept' THEN 'student' ELSE 'teacher' END;
  v_need_state := CASE WHEN p_action = 'accept' THEN 'countered' ELSE 'requested' END;
  IF v_slot.id IS NULL OR v_role IS DISTINCT FROM v_need_role THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_slot.state IS DISTINCT FROM v_need_state THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  RETURN QUERY
    UPDATE institution.consultation_slot AS s
       SET state = CASE WHEN p_action = 'counter' THEN 'countered' ELSE 'confirmed' END,
           starts_at = coalesce(p_starts_at, s.starts_at),
           updated_at = statement_timestamp()
     WHERE s.id = v_slot.id
    RETURNING s.id, s.starts_at, s.proposed_at, s.state;
END
$$;

REVOKE ALL ON FUNCTION institution.consultation_slots(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.request_consultation_slot(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.act_on_consultation_slot(text, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.consultation_slots(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.request_consultation_slot(text, timestamptz) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.act_on_consultation_slot(text, uuid, text, timestamptz) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.act_on_consultation_slot(text, uuid, text, timestamptz);
DROP FUNCTION institution.request_consultation_slot(text, timestamptz);
DROP FUNCTION institution.consultation_slots(text);
DROP TABLE institution.consultation_slot;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
