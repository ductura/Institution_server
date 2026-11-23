-- migrate:up
-- PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
-- OD-15; PRODUCT §5 rule 11). An assignment may require a confirmed
-- declaration before a submission. Expand only: a new column with a constant
-- default, so every assignment that exists, and every one made by a path that
-- does not name the switch, keeps today's behaviour (OD-6: off unless the
-- assignment asks for it). The pilot turns it on per assignment: the teacher
-- of the assignment (C-23) through teacher.declaration-requirement.put.
--
-- While the switch is on, a submission request is written only together with
-- a declaration version that is fresh for the submitted revision
-- (declaration.is_fresh, section 6.2): the trigger that pins the version
-- (declaration.pin_request) refuses the row with ZD428 otherwise, so nothing
-- of the request is written. A technical failure while reading the
-- declaration then refuses too (rule 11 as the owner decided on 23. 11.: a
-- confirmation that failed technically never lets a submission through).
-- While the switch is off, the trigger behaves as 20261204100000. The web
-- process reads ZD428 as declaration_required (server/evidence/submission.ts).
--
-- A request is the frozen context of its submission (D-263 Q07): the switch in
-- force at the click decides, and the setter waits for a request in progress
-- (the request holds the assignment FOR SHARE, the setter FOR UPDATE). A
-- request written while the switch was off is recorded as it was requested,
-- even if the teacher turns the switch on before its receipt is bound.
--
-- view_statement tells the student whether the assignment requires the
-- declaration (declarationRequired), so the web never guesses.
-- submission-receipt-v2 is unchanged and stays byte-equal.
--
--   institution.assignment.declaration_required  the switch, false by default.
--   audit.declaration_requirement_event  append-only trail of every change,
--                   with its author and time, written in the same call.
--   institution.declaration_requirement()  the teacher of the assignment reads
--                   the switch and when it was last changed.
--   institution.set_declaration_required()  the teacher of the assignment sets
--                   it; setting the value in force writes nothing.
--   app.assignment_declaration_required()  the bridge for the evidence role,
--                   which does not read schema institution; no grant to the
--                   app, only the evidence functions below call it.
--
-- Errors carry no input: ZD401 no session, ZD403 no relation (also an unknown
-- assignment), ZD422 invalid input, ZD428 a required declaration is missing.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;

SET LOCAL ROLE ductus_identity;
-- A constant default keeps existing and legacy-created assignments as today.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN declaration_required boolean NOT NULL DEFAULT false;

-- Every change of the switch, append-only, in the same call as the change.
CREATE TABLE audit.declaration_requirement_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  required boolean NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX declaration_requirement_event_assignment_idx
  ON audit.declaration_requirement_event (assignment_id, institution_id, seq);
CREATE INDEX declaration_requirement_event_actor_idx
  ON audit.declaration_requirement_event (actor_id, institution_id);
CREATE TRIGGER declaration_requirement_event_append_only BEFORE UPDATE OR DELETE
  ON audit.declaration_requirement_event FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER declaration_requirement_event_no_truncate BEFORE TRUNCATE
  ON audit.declaration_requirement_event FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.declaration_requirement_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.declaration_requirement_event FORCE ROW LEVEL SECURITY;
CREATE POLICY declaration_requirement_event_owner ON audit.declaration_requirement_event
  TO ductus_identity USING (true) WITH CHECK (true);

-- The switch in force and when it was last changed (null: never). No access
-- check: only the two RPCs below, which check first, call it.
CREATE FUNCTION institution.declaration_requirement_of(p_assignment_id uuid)
RETURNS TABLE (required boolean, changed_at timestamptz)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT a.declaration_required,
         (SELECT e.occurred_at FROM audit.declaration_requirement_event e
           WHERE (e.assignment_id, e.institution_id) = (a.id, a.institution_id)
           ORDER BY e.seq DESC LIMIT 1)
    FROM institution.assignment a WHERE a.id = p_assignment_id
$$;
REVOKE ALL ON FUNCTION institution.declaration_requirement_of(uuid) FROM PUBLIC;

-- The caller's user and institution when the caller is the teacher of the
-- assignment of the own institution; ZD403 for everyone else and for an
-- unknown assignment (C-23: a role alone opens nothing).
CREATE FUNCTION institution.require_assignment_teacher(p_assignment_id uuid,
  OUT user_id uuid, OUT institution_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO user_id, institution_id FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR institution.work_relation(user_id, p_assignment_id) IS DISTINCT FROM 'teacher'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = require_assignment_teacher.institution_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION institution.require_assignment_teacher(uuid) FROM PUBLIC;

-- The teacher of the assignment reads the switch.
CREATE FUNCTION institution.declaration_requirement(p_assignment_id uuid)
RETURNS TABLE (required boolean, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_assignment_teacher(p_assignment_id);
  RETURN QUERY SELECT s.required, s.changed_at FROM institution.declaration_requirement_of(p_assignment_id) s;
END
$$;
REVOKE ALL ON FUNCTION institution.declaration_requirement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.declaration_requirement(uuid) TO ductus_app;

-- The teacher of the assignment sets the switch. The assignment row is taken
-- FOR UPDATE, so a submission request in progress (FOR SHARE) finishes under
-- the old value and one that starts later reads the new one. Setting the
-- value in force writes nothing and returns it unchanged; every change writes
-- its event in the same transaction.
CREATE FUNCTION institution.set_declaration_required(p_assignment_id uuid, p_required boolean)
RETURNS TABLE (required boolean, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_current boolean;
BEGIN
  SELECT * INTO v_actor FROM institution.require_assignment_teacher(p_assignment_id);
  IF p_required IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT a.declaration_required INTO v_current FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id
   FOR UPDATE;
  IF v_current IS DISTINCT FROM p_required THEN
    UPDATE institution.assignment a SET declaration_required = p_required
     WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id;
    INSERT INTO audit.declaration_requirement_event (institution_id, assignment_id, required, actor_id)
    VALUES (v_actor.institution_id, p_assignment_id, p_required, v_actor.user_id);
  END IF;
  RETURN QUERY SELECT s.required, s.changed_at FROM institution.declaration_requirement_of(p_assignment_id) s;
END
$$;
REVOKE ALL ON FUNCTION institution.set_declaration_required(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.set_declaration_required(uuid, boolean) TO ductus_app;

-- The switch of one assignment; false when there is none (a request for it
-- is refused by its keys anyway). No access check: only the evidence
-- functions below call it, after their own.
CREATE FUNCTION app.assignment_declaration_required(p_assignment_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT a.declaration_required FROM institution.assignment a
                    WHERE a.id = p_assignment_id), false)
$$;
REVOKE ALL ON FUNCTION app.assignment_declaration_required(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_declaration_required(uuid) TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- As 20261204100000, and while the assignment requires a declaration a row
-- without a fresh version is refused.
CREATE OR REPLACE FUNCTION declaration.pin_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_saved declaration.statement%ROWTYPE;
  v_required boolean;
BEGIN
  -- app.request_submission runs as the evidence owner. Any other caller
  -- reaches its ordinary RLS check without invoking a private helper.
  IF current_user <> 'ductus_evidence' THEN RETURN NEW; END IF;
  PERFORM declaration.lock_scope(NEW.institution_id, NEW.assignment_id, NEW.principal_id);
  -- Only this trigger chooses the pinned version, never the inserting row.
  NEW.declaration_version_id := NULL;
  NEW.declaration_sha256 := NULL;
  v_required := app.assignment_declaration_required(NEW.assignment_id);
  BEGIN
    SELECT * INTO v_saved FROM declaration.statement s
     WHERE (s.institution_id, s.assignment_id, s.principal_id)
         = (NEW.institution_id, NEW.assignment_id, NEW.principal_id)
       AND s.payload_jcs IS NOT NULL
     ORDER BY s.version DESC LIMIT 1;
    IF FOUND AND declaration.is_fresh(v_saved, NEW.document_id, NEW.revision, NEW.assignment_version) THEN
      NEW.declaration_version_id := v_saved.id;
      NEW.declaration_sha256 := v_saved.content_sha256;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NEW.declaration_version_id := NULL;
    NEW.declaration_sha256 := NULL;
  END;
  -- Off: section 6.3, the submission goes ahead without a declaration.
  -- On: nothing is written without the declaration of this revision.
  IF v_required AND NEW.declaration_version_id IS NULL THEN
    RAISE EXCEPTION 'declaration_required' USING ERRCODE = 'ZD428';
  END IF;
  RETURN NEW;
END $$;

-- As 20261204100000, with declarationRequired.
CREATE OR REPLACE FUNCTION declaration.view_statement(p_institution uuid, p_assignment uuid, p_student uuid,
  p_revision bigint, p_assignment_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_saved declaration.statement%ROWTYPE;
  v_uploads jsonb;
  v_state text;
BEGIN
  SELECT * INTO v_request FROM evidence.submission_request q
    WHERE (q.institution_id, q.assignment_id, q.principal_id) = (p_institution, p_assignment, p_student)
      AND evidence.request_live(q.id, q.institution_id);
  SELECT * INTO v_saved FROM declaration.statement s
    WHERE (s.institution_id, s.assignment_id, s.principal_id) = (p_institution, p_assignment, p_student)
      AND (v_request.id IS NULL OR s.id = v_request.declaration_version_id)
    ORDER BY s.version DESC LIMIT 1;
  v_state := CASE WHEN v_saved.id IS NULL THEN 'none'
    WHEN v_request.id IS NOT NULL THEN 'bound'
    WHEN v_saved.draft IS NOT NULL THEN 'draft'
    WHEN declaration.is_fresh(v_saved, v_saved.document_id, p_revision, p_assignment_version) THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads,
    'declarationRequired', app.assignment_declaration_required(p_assignment)));
END $$;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app, audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION declaration.view_statement(p_institution uuid, p_assignment uuid, p_student uuid,
  p_revision bigint, p_assignment_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_saved declaration.statement%ROWTYPE;
  v_uploads jsonb;
  v_state text;
BEGIN
  SELECT * INTO v_request FROM evidence.submission_request q
    WHERE (q.institution_id, q.assignment_id, q.principal_id) = (p_institution, p_assignment, p_student)
      AND evidence.request_live(q.id, q.institution_id);
  SELECT * INTO v_saved FROM declaration.statement s
    WHERE (s.institution_id, s.assignment_id, s.principal_id) = (p_institution, p_assignment, p_student)
      AND (v_request.id IS NULL OR s.id = v_request.declaration_version_id)
    ORDER BY s.version DESC LIMIT 1;
  v_state := CASE WHEN v_saved.id IS NULL THEN 'none'
    WHEN v_request.id IS NOT NULL THEN 'bound'
    WHEN v_saved.draft IS NOT NULL THEN 'draft'
    WHEN declaration.is_fresh(v_saved, v_saved.document_id, p_revision, p_assignment_version) THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads));
END $$;
CREATE OR REPLACE FUNCTION declaration.pin_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_saved declaration.statement%ROWTYPE;
BEGIN
  IF current_user <> 'ductus_evidence' THEN RETURN NEW; END IF;
  PERFORM declaration.lock_scope(NEW.institution_id, NEW.assignment_id, NEW.principal_id);
  NEW.declaration_version_id := NULL;
  NEW.declaration_sha256 := NULL;
  BEGIN
    SELECT * INTO v_saved FROM declaration.statement s
     WHERE (s.institution_id, s.assignment_id, s.principal_id)
         = (NEW.institution_id, NEW.assignment_id, NEW.principal_id)
       AND s.payload_jcs IS NOT NULL
     ORDER BY s.version DESC LIMIT 1;
    IF FOUND AND declaration.is_fresh(v_saved, NEW.document_id, NEW.revision, NEW.assignment_version) THEN
      NEW.declaration_version_id := v_saved.id;
      NEW.declaration_sha256 := v_saved.content_sha256;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NEW.declaration_version_id := NULL;
    NEW.declaration_sha256 := NULL;
  END;
  RETURN NEW;
END $$;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assignment_declaration_required(uuid);
DROP FUNCTION institution.set_declaration_required(uuid, boolean);
DROP FUNCTION institution.declaration_requirement(uuid);
DROP FUNCTION institution.require_assignment_teacher(uuid);
DROP FUNCTION institution.declaration_requirement_of(uuid);
DROP TABLE audit.declaration_requirement_event;
ALTER TABLE institution.assignment DROP COLUMN declaration_required;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
