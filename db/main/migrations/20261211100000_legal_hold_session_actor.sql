-- migrate:up
-- SRV-1305 follow-up: the private legal hold steps take neither the
-- institution nor the actor as a parameter; both come from the session through
-- app.current_actor(), as 033 (U1) requires of every application function.
-- 20261209110000_legal_hold.sql is already in the base, so the steps are
-- replaced here: the old ones are dropped, the new ones created with the same
-- owner and grants, and the three administrator RPCs now call them without the
-- institution and the actor. Their own signatures and behaviour stay as they
-- were. Nothing of evidence.legal_hold changes.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.legal_holds_of(uuid);
DROP FUNCTION app.legal_hold_release(uuid, uuid, uuid, text);
DROP FUNCTION app.legal_hold_append(uuid, text, text, text, uuid);

-- Places one hold; no access check, only the definer RPC of ductus_identity
-- below calls it, after its own. A work is checked here, where its document
-- is; a student and an assignment are checked by the caller. Neither the
-- institution nor the actor is a parameter: both come from the session (033, U1).
CREATE FUNCTION app.legal_hold_append(p_subject_type text, p_subject_id text, p_case_reference text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_id uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.institution_id IS NULL OR v_actor.user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF p_subject_type = 'work' AND NOT EXISTS (
       SELECT 1 FROM evidence.document d
        WHERE d.id = p_subject_id AND d.institution_id = v_actor.institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  INSERT INTO evidence.legal_hold (institution_id, subject_type, subject_id, case_reference, placed_by, placed_at)
  VALUES (v_actor.institution_id, p_subject_type, p_subject_id, p_case_reference, v_actor.user_id, now())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Releases one hold of the institution by an administrator; no access check
-- beyond the rule of the hold itself. Returns the time of the release.
CREATE FUNCTION app.legal_hold_release(p_hold_id uuid, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_hold evidence.legal_hold;
  v_at timestamptz := now();
BEGIN
  SELECT a.user_id, a.institution_id INTO v_actor FROM app.current_actor() a;
  IF v_actor.institution_id IS NULL OR v_actor.user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  SELECT * INTO v_hold FROM evidence.legal_hold h
   WHERE h.id = p_hold_id AND h.institution_id = v_actor.institution_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_hold.placed_by = v_actor.user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_hold.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'already released' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE evidence.legal_hold h SET released_by = v_actor.user_id, release_reason = p_reason, released_at = v_at
   WHERE h.id = p_hold_id;
  RETURN v_at;
END
$$;

-- Every hold of the actor's institution, released ones included, newest first.
CREATE FUNCTION app.legal_holds_of()
RETURNS TABLE (hold_id uuid, subject_type text, subject_id text, case_reference text, placed_by uuid,
               placed_at timestamptz, released_by uuid, released_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT h.id, h.subject_type, h.subject_id, h.case_reference, h.placed_by, h.placed_at, h.released_by, h.released_at
    FROM app.current_actor() a
    JOIN evidence.legal_hold h ON h.institution_id = a.institution_id
   ORDER BY h.placed_at DESC, h.id
$$;

REVOKE ALL ON FUNCTION app.legal_hold_append(text, text, text), app.legal_hold_release(uuid, text),
  app.legal_holds_of() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.legal_hold_append(text, text, text), app.legal_hold_release(uuid, text),
  app.legal_holds_of() TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION app.place_legal_hold(p_subject_type text, p_subject_id text, p_case_reference text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_legal_hold_admin();
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('work', 'student', 'assignment')
     OR p_subject_id IS NULL OR length(p_subject_id) NOT BETWEEN 1 AND 256
     OR p_subject_id <> pg_catalog.btrim(p_subject_id) OR p_subject_id ~ '[[:cntrl:]]'
     OR p_case_reference IS NULL OR pg_catalog.char_length(p_case_reference) > 120
     OR p_case_reference <> pg_catalog.btrim(p_case_reference)
     OR NOT coalesce(institution.is_plain_label(p_case_reference), false)
     OR (p_subject_type IN ('student', 'assignment')
         AND p_subject_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_subject_type = 'student' AND NOT EXISTS (
       SELECT 1 FROM identity.user_account u
        WHERE u.id = p_subject_id::uuid AND u.institution_id = v_actor.institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_subject_type = 'assignment' AND NOT EXISTS (
       SELECT 1 FROM institution.assignment a
        WHERE a.id = p_subject_id::uuid AND a.institution_id = v_actor.institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN app.legal_hold_append(p_subject_type, p_subject_id, p_case_reference);
END
$$;

CREATE OR REPLACE FUNCTION app.release_legal_hold(p_hold_id uuid, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_legal_hold_admin();
  IF p_hold_id IS NULL OR p_reason IS NULL OR pg_catalog.char_length(p_reason) NOT BETWEEN 1 AND 600
     OR p_reason !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN app.legal_hold_release(p_hold_id, p_reason);
END
$$;

CREATE OR REPLACE FUNCTION app.legal_holds()
RETURNS TABLE (hold_id uuid, subject_type text, subject_id text, case_reference text, placed_by uuid,
               placed_at timestamptz, released_by uuid, released_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_legal_hold_admin();
  RETURN QUERY SELECT * FROM app.legal_holds_of();
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.legal_holds_of();
DROP FUNCTION app.legal_hold_release(uuid, text);
DROP FUNCTION app.legal_hold_append(text, text, text);

-- Places one hold; no access check, only the definer RPC of ductus_identity
-- below calls it, after its own. A work is checked here, where its document
-- is; a student and an assignment are checked by the caller.
CREATE FUNCTION app.legal_hold_append(p_institution_id uuid, p_subject_type text, p_subject_id text,
  p_case_reference text, p_placed_by uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_subject_type = 'work' AND NOT EXISTS (
       SELECT 1 FROM evidence.document d WHERE d.id = p_subject_id AND d.institution_id = p_institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  INSERT INTO evidence.legal_hold (institution_id, subject_type, subject_id, case_reference, placed_by, placed_at)
  VALUES (p_institution_id, p_subject_type, p_subject_id, p_case_reference, p_placed_by, now())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Releases one hold of the institution by an administrator; no access check
-- beyond the rule of the hold itself. Returns the time of the release.
CREATE FUNCTION app.legal_hold_release(p_institution_id uuid, p_hold_id uuid, p_released_by uuid, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hold evidence.legal_hold;
  v_at timestamptz := now();
BEGIN
  SELECT * INTO v_hold FROM evidence.legal_hold h
   WHERE h.id = p_hold_id AND h.institution_id = p_institution_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_hold.placed_by = p_released_by THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_hold.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'already released' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE evidence.legal_hold h SET released_by = p_released_by, release_reason = p_reason, released_at = v_at
   WHERE h.id = p_hold_id;
  RETURN v_at;
END
$$;

-- Every hold of one institution, released ones included, newest first.
CREATE FUNCTION app.legal_holds_of(p_institution_id uuid)
RETURNS TABLE (hold_id uuid, subject_type text, subject_id text, case_reference text, placed_by uuid,
               placed_at timestamptz, released_by uuid, released_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT h.id, h.subject_type, h.subject_id, h.case_reference, h.placed_by, h.placed_at, h.released_by, h.released_at
    FROM evidence.legal_hold h
   WHERE h.institution_id = p_institution_id
   ORDER BY h.placed_at DESC, h.id
$$;

REVOKE ALL ON FUNCTION app.legal_hold_append(uuid, text, text, text, uuid),
  app.legal_hold_release(uuid, uuid, uuid, text), app.legal_holds_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.legal_hold_append(uuid, text, text, text, uuid),
  app.legal_hold_release(uuid, uuid, uuid, text), app.legal_holds_of(uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION app.place_legal_hold(p_subject_type text, p_subject_id text, p_case_reference text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_legal_hold_admin();
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('work', 'student', 'assignment')
     OR p_subject_id IS NULL OR length(p_subject_id) NOT BETWEEN 1 AND 256
     OR p_subject_id <> pg_catalog.btrim(p_subject_id) OR p_subject_id ~ '[[:cntrl:]]'
     OR p_case_reference IS NULL OR pg_catalog.char_length(p_case_reference) > 120
     OR p_case_reference <> pg_catalog.btrim(p_case_reference)
     OR NOT coalesce(institution.is_plain_label(p_case_reference), false)
     OR (p_subject_type IN ('student', 'assignment')
         AND p_subject_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_subject_type = 'student' AND NOT EXISTS (
       SELECT 1 FROM identity.user_account u
        WHERE u.id = p_subject_id::uuid AND u.institution_id = v_actor.institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_subject_type = 'assignment' AND NOT EXISTS (
       SELECT 1 FROM institution.assignment a
        WHERE a.id = p_subject_id::uuid AND a.institution_id = v_actor.institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN app.legal_hold_append(v_actor.institution_id, p_subject_type, p_subject_id, p_case_reference,
                               v_actor.user_id);
END
$$;

CREATE OR REPLACE FUNCTION app.release_legal_hold(p_hold_id uuid, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_legal_hold_admin();
  IF p_hold_id IS NULL OR p_reason IS NULL OR pg_catalog.char_length(p_reason) NOT BETWEEN 1 AND 600
     OR p_reason !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN app.legal_hold_release(v_actor.institution_id, p_hold_id, v_actor.user_id, p_reason);
END
$$;

CREATE OR REPLACE FUNCTION app.legal_holds()
RETURNS TABLE (hold_id uuid, subject_type text, subject_id text, case_reference text, placed_by uuid,
               placed_at timestamptz, released_by uuid, released_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_legal_hold_admin();
  RETURN QUERY SELECT * FROM app.legal_holds_of(v_actor.institution_id);
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
