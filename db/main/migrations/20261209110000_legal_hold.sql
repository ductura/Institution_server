-- migrate:up
-- SRV-1305 (M10.3; F-02, D-274 MQ11): legal hold. An administrator of an
-- institution places a hold on a work, a student or an assignment of that
-- institution, with the reference of the case. While any hold on a subject is
-- unreleased, the subject is held: a later deletion job asks
-- app.is_on_legal_hold before it removes anything (wiring it into the
-- scheduler is not part of this step). Several holds on one subject are
-- independent.
--
-- A hold is released by another administrator of the same institution, never
-- by the one who placed it, or by the operator on a request reference. A row
-- is never deleted: the release fills its release columns once and nothing
-- else of the row ever changes.
--
--   evidence.legal_hold                 the holds; forced RLS with only the
--                                       owner's policy, no privilege for any
--                                       other role
--   app.legal_hold_append               private steps, without an access
--   app.legal_hold_release              check, executable only by
--   app.legal_holds_of                  ductus_identity
--   app.is_on_legal_hold                whether a subject is held; executable
--                                       only by ductus_retention
--   evidence.operator_release_legal_hold  the operator's release, on a
--                                       request reference; no grant to any
--                                       application role
--   app.place_legal_hold                the administrator's RPCs, executable
--   app.release_legal_hold              by ductus_app; the institution comes
--   app.legal_holds                     from the session, never from a
--                                       parameter
--
-- The subject id is text: the id of a work is the id of its document, which
-- is text (evidence.document); a student and an assignment are uuids. The
-- subject must exist in the actor's institution when the hold is placed;
-- there is no foreign key, so a hold never blocks nor follows the removal of
-- what it names, as for evidence.erasure.
--
-- Errors carry no input: ZD401 no session, ZD403 not an administrator of the
-- institution or the administrator who placed the hold, ZD404 no such
-- subject or hold in the institution, ZD409 hold already released, ZD422
-- invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- The case reference is a plain label of 1 to 120 characters without leading
-- or trailing blanks; the release reason is 1 to 600 characters with at least
-- one that is not blank. The release is either an administrator's
-- (released_by) or the operator's (release_request_ref), never both.
-- placed_by and released_by carry no foreign key: identity stays closed to
-- ductus_evidence, and only identity's RPCs below append or release, with the
-- actor taken from the session.
CREATE TABLE evidence.legal_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('work', 'student', 'assignment')),
  subject_id text NOT NULL
    CHECK (length(subject_id) BETWEEN 1 AND 256 AND subject_id = btrim(subject_id) AND subject_id !~ '[[:cntrl:]]'),
  case_reference text NOT NULL
    CHECK (char_length(case_reference) BETWEEN 1 AND 120 AND case_reference = btrim(case_reference)
           AND case_reference !~ '[[:cntrl:]]'),
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  release_request_ref text
    CHECK (char_length(release_request_ref) BETWEEN 1 AND 200 AND release_request_ref = btrim(release_request_ref)
           AND release_request_ref !~ '[[:cntrl:]]'),
  release_reason text CHECK (char_length(release_reason) BETWEEN 1 AND 600 AND release_reason ~ '[^[:space:]]'),
  released_at timestamptz,
  CHECK ((released_at IS NULL AND released_by IS NULL AND release_request_ref IS NULL AND release_reason IS NULL)
         OR (released_at IS NOT NULL AND release_reason IS NOT NULL
             AND num_nonnulls(released_by, release_request_ref) = 1)),
  CHECK (released_by IS DISTINCT FROM placed_by)
);
CREATE INDEX legal_hold_subject_idx ON evidence.legal_hold (subject_type, subject_id) WHERE released_at IS NULL;
CREATE INDEX legal_hold_institution_idx ON evidence.legal_hold (institution_id, placed_at, id);

-- The one change a row allows: its release, once. Everything else of the row
-- stays as it was placed.
CREATE FUNCTION evidence.legal_hold_release_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (NEW.id, NEW.institution_id, NEW.subject_type, NEW.subject_id, NEW.case_reference, NEW.placed_by, NEW.placed_at)
        IS DISTINCT FROM
        (OLD.id, OLD.institution_id, OLD.subject_type, OLD.subject_id, OLD.case_reference, OLD.placed_by, OLD.placed_at)
  THEN
    RAISE EXCEPTION 'append-only row' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION evidence.legal_hold_release_only() FROM PUBLIC;

CREATE TRIGGER legal_hold_release_only BEFORE UPDATE ON evidence.legal_hold
  FOR EACH ROW EXECUTE FUNCTION evidence.legal_hold_release_only();
-- Statement triggers: a DELETE fails even when RLS or its WHERE leaves no
-- row, so a removal is never a silent no-op.
CREATE TRIGGER legal_hold_no_delete BEFORE DELETE ON evidence.legal_hold
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER legal_hold_no_truncate BEFORE TRUNCATE ON evidence.legal_hold
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.legal_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.legal_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_hold_owner ON evidence.legal_hold TO ductus_evidence USING (true) WITH CHECK (true);

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

-- For the deletion jobs: whether any hold on the subject is unreleased.
CREATE FUNCTION app.is_on_legal_hold(p_subject_type text, p_subject_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM evidence.legal_hold h
                  WHERE h.subject_type = p_subject_type AND h.subject_id = p_subject_id AND h.released_at IS NULL)
$$;

-- Operator only, as institution.appoint_institution_admin: SECURITY INVOKER
-- and no grant, so only the operator's own session runs it. The operator is
-- not a user of the institution, so the row keeps the request reference.
CREATE FUNCTION evidence.operator_release_legal_hold(p_hold_id uuid, p_request_ref text, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_hold evidence.legal_hold;
  v_at timestamptz := now();
BEGIN
  IF p_request_ref IS NULL OR p_request_ref <> pg_catalog.btrim(p_request_ref)
     OR pg_catalog.char_length(p_request_ref) NOT BETWEEN 1 AND 200 OR p_request_ref ~ '[[:cntrl:]]'
     OR p_reason IS NULL OR pg_catalog.char_length(p_reason) NOT BETWEEN 1 AND 600 OR p_reason !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_hold FROM evidence.legal_hold h WHERE h.id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_hold.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'already released' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE evidence.legal_hold h SET release_request_ref = p_request_ref, release_reason = p_reason, released_at = v_at
   WHERE h.id = p_hold_id;
  RETURN v_at;
END
$$;

REVOKE ALL ON FUNCTION app.legal_hold_append(text, text, text),
  app.legal_hold_release(uuid, text), app.legal_holds_of(), app.is_on_legal_hold(text, text),
  evidence.operator_release_legal_hold(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.legal_hold_append(text, text, text),
  app.legal_hold_release(uuid, text), app.legal_holds_of() TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.is_on_legal_hold(text, text) TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The administrator check of admin_create_course, shared by the three RPCs:
-- the actor of the session must hold a confirmed, unrevoked admin role in
-- their institution. Returns the actor.
CREATE FUNCTION institution.require_legal_hold_admin(OUT user_id uuid, OUT institution_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  SELECT a.user_id, a.institution_id INTO user_id, institution_id FROM institution.require_actor() a;
  PERFORM 1 FROM institution.institution_role r
   WHERE r.institution_id = require_legal_hold_admin.institution_id
     AND r.user_id = require_legal_hold_admin.user_id AND r.role = 'admin'
     AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
   FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

CREATE FUNCTION app.place_legal_hold(p_subject_type text, p_subject_id text, p_case_reference text)
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

CREATE FUNCTION app.release_legal_hold(p_hold_id uuid, p_reason text)
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

CREATE FUNCTION app.legal_holds()
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

REVOKE ALL ON FUNCTION institution.require_legal_hold_admin(), app.place_legal_hold(text, text, text),
  app.release_legal_hold(uuid, text), app.legal_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.place_legal_hold(text, text, text), app.release_legal_hold(uuid, text),
  app.legal_holds() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.legal_holds();
DROP FUNCTION app.release_legal_hold(uuid, text);
DROP FUNCTION app.place_legal_hold(text, text, text);
DROP FUNCTION institution.require_legal_hold_admin();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION evidence.operator_release_legal_hold(uuid, text, text);
DROP FUNCTION app.is_on_legal_hold(text, text);
DROP FUNCTION app.legal_holds_of();
DROP FUNCTION app.legal_hold_release(uuid, text);
DROP FUNCTION app.legal_hold_append(text, text, text);
DROP TABLE evidence.legal_hold;
DROP FUNCTION evidence.legal_hold_release_only();
