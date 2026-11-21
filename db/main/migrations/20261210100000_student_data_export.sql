-- migrate:up
-- SRV-1307 (M10.5; D-271 MQ02): the export of a student's own data, for a
-- student and for a former student, through the student registry office
-- (referada). The registry office takes the request and confirms that it
-- checked the person's identity; an administrator of the institution starts
-- the job with its reference; the worker prepares the package and gives it a
-- one-time link valid for 24 hours after it is ready. The link is a random
-- token the server hands out once; only its SHA-256 is stored here.
--
-- The registry office is not a role of institution.institution_role (only
-- teacher and admin). Its clerks are a list of their own, written only by the
-- operator on the faculty's written request, as the administrators are
-- (DAN-525): app.registry_clerk. A clerk who is also a confirmed
-- administrator of the institution may not request (the two duties stay
-- apart), and the administrator who approves is never the one who requested.
--
--   app.registry_clerk                     the clerks; forced RLS with only
--                                          the owner's policy, no privilege
--                                          for any other role
--   app.appoint_registry_clerk             the operator's procedures, on a
--   app.revoke_registry_clerk              request reference; SECURITY
--                                          INVOKER and no grant
--   app.student_data_export                the requests; forced RLS with only
--                                          the owner's policy, no privilege
--                                          for any other role
--   app.request_student_data_export        ductus_app: a clerk requests
--   app.approve_student_data_export        ductus_app: an administrator
--                                          approves with the job reference
--   app.student_data_exports               ductus_app: what the actor may see
--   app.consume_student_data_export        ductus_app: the one-time link
--   app.worker_student_data_exports_to_prepare    ductus_worker: approved jobs
--   app.worker_mark_student_data_export_ready     ductus_worker: approved -> ready
--   app.worker_expire_student_data_exports        ductus_worker: ready -> expired
--
-- States: requested -> approved -> ready -> downloaded | expired. The
-- institution and the actor always come from the session, never from a
-- parameter. Expiry is its own step: consume refuses an expired link with
-- ZD410, which rolls back whatever it would have written.
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed, ZD404 no such
-- person or request in the institution, ZD409 wrong state or already open,
-- ZD410 the link is unknown, used or expired, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Refuses a removal of a row of either table; a statement trigger, so a
-- DELETE fails even when RLS or its WHERE leaves no row.
CREATE FUNCTION app.refuse_student_data_export_removal() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'append-only row' USING ERRCODE = 'ZD403';
END
$$;
REVOKE ALL ON FUNCTION app.refuse_student_data_export_removal() FROM PUBLIC;

-- The request references are plain labels of 1 to 200 characters without
-- leading or trailing blanks, as on the administrators' trail.
CREATE TABLE app.registry_clerk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  appoint_request_ref text NOT NULL
    CHECK (char_length(appoint_request_ref) BETWEEN 1 AND 200 AND appoint_request_ref = btrim(appoint_request_ref)
           AND appoint_request_ref !~ '[[:cntrl:]]'),
  revoked_at timestamptz,
  revoke_request_ref text
    CHECK (char_length(revoke_request_ref) BETWEEN 1 AND 200 AND revoke_request_ref = btrim(revoke_request_ref)
           AND revoke_request_ref !~ '[[:cntrl:]]'),
  CHECK ((revoked_at IS NULL) = (revoke_request_ref IS NULL)),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE UNIQUE INDEX registry_clerk_active_idx ON app.registry_clerk (institution_id, user_id) WHERE revoked_at IS NULL;

-- The one change a clerk row allows: its revocation, once.
CREATE FUNCTION app.registry_clerk_revoke_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.institution_id, NEW.user_id, NEW.appointed_at, NEW.appoint_request_ref)
        IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.user_id, OLD.appointed_at, OLD.appoint_request_ref)
  THEN
    RAISE EXCEPTION 'append-only row' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.registry_clerk_revoke_only() FROM PUBLIC;

CREATE TRIGGER registry_clerk_revoke_only BEFORE UPDATE ON app.registry_clerk
  FOR EACH ROW EXECUTE FUNCTION app.registry_clerk_revoke_only();
CREATE TRIGGER registry_clerk_no_delete BEFORE DELETE ON app.registry_clerk
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_student_data_export_removal();
CREATE TRIGGER registry_clerk_no_truncate BEFORE TRUNCATE ON app.registry_clerk
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_student_data_export_removal();

ALTER TABLE app.registry_clerk ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.registry_clerk FORCE ROW LEVEL SECURITY;
CREATE POLICY registry_clerk_owner ON app.registry_clerk TO ductus_identity USING (true) WITH CHECK (true);

-- The job reference and the reference of the identity check are plain labels
-- of 1 to 120 characters. The token is never stored: token_hash is its
-- SHA-256, kept only while the link is ready and cleared when it is used or
-- expires. Each state fixes which columns are set.
CREATE TABLE app.student_data_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'ready', 'downloaded', 'expired')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  identity_check_ref text NOT NULL
    CHECK (char_length(identity_check_ref) BETWEEN 1 AND 120 AND identity_check_ref = btrim(identity_check_ref)
           AND identity_check_ref !~ '[[:cntrl:]]'),
  approved_by uuid,
  approved_at timestamptz,
  job_ref text
    CHECK (char_length(job_ref) BETWEEN 1 AND 120 AND job_ref = btrim(job_ref) AND job_ref !~ '[[:cntrl:]]'),
  token_hash bytea CHECK (octet_length(token_hash) = 32),
  ready_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  expired_at timestamptz,
  CHECK (requested_by <> student_id),
  CHECK (approved_by <> requested_by AND approved_by <> student_id),
  CHECK ((status = 'requested') = (approved_by IS NULL)),
  CHECK (num_nonnulls(approved_by, approved_at, job_ref) IN (0, 3)),
  CHECK ((status IN ('requested', 'approved')) = (ready_at IS NULL)),
  CHECK (num_nonnulls(ready_at, expires_at) IN (0, 2) AND expires_at = ready_at + interval '24 hours'),
  CHECK ((status = 'ready') = (token_hash IS NOT NULL)),
  CHECK ((status = 'downloaded') = (downloaded_at IS NOT NULL)),
  CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (requested_by, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (approved_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE UNIQUE INDEX student_data_export_token_idx ON app.student_data_export (token_hash) WHERE token_hash IS NOT NULL;
-- One open request per person at a time.
CREATE UNIQUE INDEX student_data_export_open_idx ON app.student_data_export (institution_id, student_id)
  WHERE status IN ('requested', 'approved', 'ready');
CREATE INDEX student_data_export_institution_idx ON app.student_data_export (institution_id, requested_at, id);
CREATE INDEX student_data_export_approved_idx ON app.student_data_export (approved_at, id) WHERE status = 'approved';
CREATE INDEX student_data_export_ready_idx ON app.student_data_export (expires_at) WHERE status = 'ready';
CREATE INDEX student_data_export_requested_by_idx ON app.student_data_export (requested_by, institution_id);
CREATE INDEX student_data_export_approved_by_idx ON app.student_data_export (approved_by, institution_id);

-- Only forward: requested -> approved -> ready -> downloaded | expired. What
-- a state set stays as it was; the token hash may only be cleared.
CREATE FUNCTION app.student_data_export_forward_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF (OLD.status, NEW.status) NOT IN (('requested', 'approved'), ('approved', 'ready'), ('ready', 'downloaded'),
                                      ('ready', 'expired'))
     OR (NEW.id, NEW.institution_id, NEW.student_id, NEW.requested_by, NEW.requested_at, NEW.identity_check_ref)
        IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.student_id, OLD.requested_by, OLD.requested_at,
                          OLD.identity_check_ref)
     OR (OLD.status <> 'requested'
         AND (NEW.approved_by, NEW.approved_at, NEW.job_ref) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.job_ref))
     OR (OLD.status = 'ready' AND (NEW.ready_at, NEW.expires_at) IS DISTINCT FROM (OLD.ready_at, OLD.expires_at))
  THEN
    RAISE EXCEPTION 'append-only row' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.student_data_export_forward_only() FROM PUBLIC;

CREATE TRIGGER student_data_export_forward_only BEFORE UPDATE ON app.student_data_export
  FOR EACH ROW EXECUTE FUNCTION app.student_data_export_forward_only();
CREATE TRIGGER student_data_export_no_delete BEFORE DELETE ON app.student_data_export
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_student_data_export_removal();
CREATE TRIGGER student_data_export_no_truncate BEFORE TRUNCATE ON app.student_data_export
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_student_data_export_removal();

ALTER TABLE app.student_data_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_data_export FORCE ROW LEVEL SECURITY;
CREATE POLICY student_data_export_owner ON app.student_data_export TO ductus_identity USING (true) WITH CHECK (true);

-- Operator only, as institution.appoint_institution_admin: SECURITY INVOKER
-- and no grant, so only the operator's own session runs it. The institution
-- is the person's own. A confirmed administrator is not appointed (ZD409).
CREATE FUNCTION app.appoint_registry_clerk(p_user_id uuid, p_request_ref text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_request_ref IS NULL OR p_request_ref <> pg_catalog.btrim(p_request_ref)
     OR pg_catalog.char_length(p_request_ref) NOT BETWEEN 1 AND 200 OR p_request_ref ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT u.institution_id INTO v_institution FROM identity.user_account u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF EXISTS (SELECT 1 FROM institution.institution_role r
              WHERE r.institution_id = v_institution AND r.user_id = p_user_id AND r.role = 'admin'
                AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM app.registry_clerk c
                 WHERE c.institution_id = v_institution AND c.user_id = p_user_id AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO app.registry_clerk (institution_id, user_id, appoint_request_ref)
  VALUES (v_institution, p_user_id, p_request_ref)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE FUNCTION app.revoke_registry_clerk(p_user_id uuid, p_request_ref text) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_at timestamptz := now();
BEGIN
  IF p_user_id IS NULL OR p_request_ref IS NULL OR p_request_ref <> pg_catalog.btrim(p_request_ref)
     OR pg_catalog.char_length(p_request_ref) NOT BETWEEN 1 AND 200 OR p_request_ref ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  UPDATE app.registry_clerk c SET revoked_at = v_at, revoke_request_ref = p_request_ref
   WHERE c.user_id = p_user_id AND c.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN v_at;
END
$$;

-- What the actor of the session is in its institution: a clerk, a confirmed
-- administrator, both or neither. No session: ZD401. A private step of the
-- RPCs below; no grant.
CREATE FUNCTION app.student_data_export_actor(OUT user_id uuid, OUT institution_id uuid, OUT is_clerk boolean,
  OUT is_admin boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  SELECT a.user_id, a.institution_id INTO user_id, institution_id FROM institution.require_actor() a;
  is_clerk := EXISTS (SELECT 1 FROM app.registry_clerk c
                       WHERE c.institution_id = student_data_export_actor.institution_id
                         AND c.user_id = student_data_export_actor.user_id AND c.revoked_at IS NULL);
  is_admin := EXISTS (SELECT 1 FROM institution.institution_role r
                       WHERE r.institution_id = student_data_export_actor.institution_id
                         AND r.user_id = student_data_export_actor.user_id AND r.role = 'admin'
                         AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL);
END
$$;

-- A clerk of the session's institution, who is not a confirmed administrator,
-- requests the export of a person of the same institution (a student or a
-- former student; an account stays after the studies end) and confirms that
-- the identity was checked, with the reference of that check.
CREATE FUNCTION app.request_student_data_export(p_student_id uuid, p_identity_verified boolean,
  p_identity_check_ref text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM app.student_data_export_actor();
  IF NOT v_actor.is_clerk OR v_actor.is_admin THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_student_id IS NULL OR p_identity_verified IS NOT TRUE OR p_identity_check_ref IS NULL
     OR pg_catalog.char_length(p_identity_check_ref) > 120
     OR p_identity_check_ref <> pg_catalog.btrim(p_identity_check_ref)
     OR NOT coalesce(institution.is_plain_label(p_identity_check_ref), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_student_id = v_actor.user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM identity.user_account u WHERE u.id = p_student_id AND u.institution_id = v_actor.institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  INSERT INTO app.student_data_export (institution_id, student_id, requested_by, identity_check_ref)
  VALUES (v_actor.institution_id, p_student_id, v_actor.user_id, p_identity_check_ref)
  ON CONFLICT (institution_id, student_id) WHERE status IN ('requested', 'approved', 'ready') DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN v_id;
END
$$;

-- A confirmed administrator of the session's institution, who is neither the
-- clerk who requested nor the person, starts the job with its reference.
CREATE FUNCTION app.approve_student_data_export(p_export_id uuid, p_job_ref text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_row app.student_data_export;
  v_at timestamptz := now();
BEGIN
  SELECT * INTO v_actor FROM app.student_data_export_actor();
  IF NOT v_actor.is_admin THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_export_id IS NULL OR p_job_ref IS NULL OR pg_catalog.char_length(p_job_ref) > 120
     OR p_job_ref <> pg_catalog.btrim(p_job_ref) OR NOT coalesce(institution.is_plain_label(p_job_ref), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_row FROM app.student_data_export e
   WHERE e.id = p_export_id AND e.institution_id = v_actor.institution_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_row.requested_by = v_actor.user_id OR v_row.student_id = v_actor.user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_row.status <> 'requested' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE app.student_data_export e SET status = 'approved', approved_by = v_actor.user_id, approved_at = v_at,
         job_ref = p_job_ref
   WHERE e.id = p_export_id;
  RETURN v_at;
END
$$;

-- The requests the actor may see, newest first: every request of the own
-- institution for a clerk or an administrator, the own requests for anyone
-- else. Nobody sees another institution's requests, and the token hash is
-- never returned.
CREATE FUNCTION app.student_data_exports()
RETURNS TABLE (export_id uuid, student_id uuid, status text, requested_by uuid, requested_at timestamptz,
               identity_check_ref text, approved_by uuid, approved_at timestamptz, job_ref text,
               ready_at timestamptz, expires_at timestamptz, downloaded_at timestamptz, expired_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.student_data_export_actor();
  RETURN QUERY
  SELECT e.id, e.student_id, e.status, e.requested_by, e.requested_at, e.identity_check_ref, e.approved_by,
         e.approved_at, e.job_ref, e.ready_at, e.expires_at, e.downloaded_at, e.expired_at
    FROM app.student_data_export e
   WHERE e.institution_id = v_actor.institution_id
     AND (v_actor.is_clerk OR v_actor.is_admin OR e.student_id = v_actor.user_id)
   ORDER BY e.requested_at DESC, e.id;
END
$$;

-- The one-time link: the SHA-256 of the token lets through a ready request
-- exactly once, until 24 hours after it became ready. An unknown, used or
-- expired link is ZD410; the link alone carries the right, as a download link
-- does, so no session is asked for. Returns what the server needs to hand
-- out the package.
CREATE FUNCTION app.consume_student_data_export(p_token_hash bytea)
RETURNS TABLE (export_id uuid, student_id uuid, job_ref text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row app.student_data_export;
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_row FROM app.student_data_export e
   WHERE e.token_hash = p_token_hash AND e.status = 'ready'
   FOR UPDATE;
  IF NOT FOUND OR v_row.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'gone' USING ERRCODE = 'ZD410';
  END IF;
  UPDATE app.student_data_export e SET status = 'downloaded', downloaded_at = pg_catalog.now(), token_hash = NULL
   WHERE e.id = v_row.id;
  RETURN QUERY SELECT v_row.id, v_row.student_id, v_row.job_ref;
END
$$;

-- The worker: the approved jobs, oldest first.
CREATE FUNCTION app.worker_student_data_exports_to_prepare()
RETURNS TABLE (export_id uuid, institution_id uuid, student_id uuid, job_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.id, e.institution_id, e.student_id, e.job_ref
    FROM app.student_data_export e
   WHERE e.status = 'approved'
   ORDER BY e.approved_at, e.id
$$;

-- The worker: the package of an approved job is ready; the link is the
-- SHA-256 of a token the worker made and hands to the server, never this
-- table. Returns when the link expires.
CREATE FUNCTION app.worker_mark_student_data_export_ready(p_export_id uuid, p_token_hash bytea)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_at timestamptz := pg_catalog.now();
BEGIN
  IF p_export_id IS NULL OR p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT e.status INTO v_status FROM app.student_data_export e WHERE e.id = p_export_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE app.student_data_export e SET status = 'ready', token_hash = p_token_hash, ready_at = v_at,
         expires_at = v_at + interval '24 hours'
   WHERE e.id = p_export_id;
  RETURN v_at + interval '24 hours';
END
$$;

-- The worker: every ready link past its 24 hours expires and loses its hash.
-- Returns how many expired.
CREATE FUNCTION app.worker_expire_student_data_exports() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE app.student_data_export e SET status = 'expired', expired_at = pg_catalog.now(), token_hash = NULL
   WHERE e.status = 'ready' AND e.expires_at <= pg_catalog.now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION app.appoint_registry_clerk(uuid, text), app.revoke_registry_clerk(uuid, text),
  app.student_data_export_actor(), app.request_student_data_export(uuid, boolean, text),
  app.approve_student_data_export(uuid, text), app.student_data_exports(),
  app.consume_student_data_export(bytea), app.worker_student_data_exports_to_prepare(),
  app.worker_mark_student_data_export_ready(uuid, bytea), app.worker_expire_student_data_exports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_student_data_export(uuid, boolean, text),
  app.approve_student_data_export(uuid, text), app.student_data_exports(),
  app.consume_student_data_export(bytea) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.worker_student_data_exports_to_prepare(), app.worker_mark_student_data_export_ready(uuid, bytea),
  app.worker_expire_student_data_exports() TO ductus_worker;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.worker_expire_student_data_exports();
DROP FUNCTION app.worker_mark_student_data_export_ready(uuid, bytea);
DROP FUNCTION app.worker_student_data_exports_to_prepare();
DROP FUNCTION app.consume_student_data_export(bytea);
DROP FUNCTION app.student_data_exports();
DROP FUNCTION app.approve_student_data_export(uuid, text);
DROP FUNCTION app.request_student_data_export(uuid, boolean, text);
DROP FUNCTION app.student_data_export_actor();
DROP FUNCTION app.revoke_registry_clerk(uuid, text);
DROP FUNCTION app.appoint_registry_clerk(uuid, text);
DROP TABLE app.student_data_export;
DROP FUNCTION app.student_data_export_forward_only();
DROP TABLE app.registry_clerk;
DROP FUNCTION app.registry_clerk_revoke_only();
DROP FUNCTION app.refuse_student_data_export_removal();
