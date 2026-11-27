-- migrate:up
-- F4 wave 2 #2 (design order 1.3, Ductus#2059; plan valovi-f4-srv.md §5,
-- approved 27 Nov 2026): the time a consultation was held, beside its day.
-- A record had only held_on (a date); the teacher may now also give the
-- minute the meeting started. The time is optional: a record without one
-- reads as before.
--
--   collaboration.consultation_record.held_at     null = no time given
--   collaboration.create_consultation_record_v2   as create_consultation_record, plus p_held_at
--   collaboration.list_consultation_records       as before, plus held_at
--
-- Rules for p_held_at (ZD422 otherwise, before any row is written):
--   - null is allowed;
--   - not in the future: at most 5 minutes after now(), for a client clock
--     that runs a little ahead;
--   - its UTC date is at most one day from held_on, so the day and the time
--     cannot name two different meetings in any time zone (UTC-12 to UTC+14);
--   - it is kept as a whole UTC minute (D-24), as the time of an addition.
--
-- Additive: create_consultation_record keeps its signature and behaviour (a
-- record without a time) for a server that still calls it; the list gets one
-- more column, which a caller naming its columns does not see. Access is as
-- before: the teacher of the work writes (SRV-MENTOR-1), the teacher and the
-- owning student read (collaboration.actor_role, decided on every call).
-- Errors carry no input: ZD401 no session, ZD403 not allowed or not there,
-- ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

ALTER TABLE collaboration.consultation_record ADD COLUMN held_at timestamptz;

-- As create_consultation_record (20261216130000), with the time of the meeting.
CREATE FUNCTION collaboration.create_consultation_record_v2(
  p_document_id text, p_held_on date, p_revision bigint, p_topic text, p_agreement text, p_held_at timestamptz
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
  IF p_held_at IS NOT NULL AND (
       p_held_at > now() + interval '5 minutes'
       OR abs((p_held_at AT TIME ZONE 'UTC')::date - p_held_on) > 1) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.consultation_record
    (institution_id, document_id, assignment_id, owner_id, held_on, held_at, revision, topic, agreement, created_by)
  VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id,
          p_held_on, pg_catalog.date_trunc('minute', p_held_at, 'UTC'), p_revision, p_topic, p_agreement,
          actor.user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- As 20261121103000, plus held_at. A new column changes the result type, so
-- the function is dropped and made again with its grant.
DROP FUNCTION collaboration.list_consultation_records(text);
CREATE FUNCTION collaboration.list_consultation_records(p_document_id text)
RETURNS TABLE (record_id uuid, held_on date, revision bigint, topic text, agreement text,
               addition_id uuid, addition_body text, addition_minute timestamptz, held_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
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
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT r.id, r.held_on, r.revision, r.topic, r.agreement,
           x.id, x.body, pg_catalog.date_trunc('minute', x.created_at, 'UTC'), r.held_at
      FROM collaboration.consultation_record r
      LEFT JOIN collaboration.consultation_addition x
        ON x.record_id = r.id AND x.institution_id = r.institution_id
     WHERE r.document_id = p_document_id AND r.institution_id = scope.institution_id
     ORDER BY r.held_on, r.created_at, r.id, x.created_at, x.id;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_consultation_record_v2(text, date, bigint, text, text, timestamptz),
  collaboration.list_consultation_records(text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_consultation_record_v2(text, date, bigint, text, text, timestamptz),
  collaboration.list_consultation_records(text)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- The times recorded since this migration are lost with the column.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.create_consultation_record_v2(text, date, bigint, text, text, timestamptz);
DROP FUNCTION collaboration.list_consultation_records(text);
CREATE FUNCTION collaboration.list_consultation_records(p_document_id text)
RETURNS TABLE (record_id uuid, held_on date, revision bigint, topic text, agreement text,
               addition_id uuid, addition_body text, addition_minute timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
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
  IF scope.institution_id IS NULL
     OR collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT r.id, r.held_on, r.revision, r.topic, r.agreement,
           x.id, x.body, pg_catalog.date_trunc('minute', x.created_at, 'UTC')
      FROM collaboration.consultation_record r
      LEFT JOIN collaboration.consultation_addition x
        ON x.record_id = r.id AND x.institution_id = r.institution_id
     WHERE r.document_id = p_document_id AND r.institution_id = scope.institution_id
     ORDER BY r.held_on, r.created_at, r.id, x.created_at, x.id;
END
$$;
REVOKE ALL ON FUNCTION collaboration.list_consultation_records(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_consultation_records(text) TO ductus_app;
ALTER TABLE collaboration.consultation_record DROP COLUMN held_at;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
