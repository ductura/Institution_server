-- migrate:up
-- PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
-- OD-15; PRODUCT §5 rule 11). An assignment may require a confirmed
-- declaration before a submission. Expand only: a new column with a constant
-- default, so every assignment that exists, and every one made by a path that
-- does not name the switch, keeps today's behaviour (OD-6: off unless the
-- assignment asks for it). The pilot turns it on per assignment through
-- institution.set_declaration_required (the teacher of the assignment, C-23;
-- teacher.declaration-required.put over HTTP).
--
-- While the switch is on, a submission request is written only together with
-- a declaration version that is fresh for the submitted revision
-- (declaration.is_fresh, section 6.2): the trigger that pins the version
-- (declaration.pin_request) refuses the row with ZD428 otherwise, so nothing
-- of the request is written. A technical failure while reading the
-- declaration then refuses too (rule 11 as the owner decided on 23. 11.: a
-- confirmation that failed technically never lets a submission through).
-- While the switch is off, the trigger behaves as 20261204100000. A request
-- written while the switch was off carries no declaration: while the switch
-- is on, app.record_submission does not record it either (ZD428, trigger
-- declaration.require_pinned_submission), unless that request is recorded
-- already. The web process maps ZD428 to 409 declaration_required
-- (submission.submit-second.post, POST /api/v1/submission/v2).
--
-- declaration.submission_gate is the same rule, read before the request; the
-- triggers stay the guarantee. view_statement tells the student whether the
-- assignment requires the declaration (declarationRequired), so the web never
-- guesses. submission-receipt-v2 is unchanged and stays byte-equal.
--
--   institution.assignment.declaration_required  the switch, false by default.
--   audit.declaration_required_event  every change of the switch, with who and
--                   when; append-only.
--   institution.declaration_required_setting(), set_declaration_required()
--                   the teacher of the assignment reads and sets it; the
--                   setter takes the assignment row FOR UPDATE, so a request
--                   in progress (FOR SHARE) finishes under the old value.
--                   Setting the value in force writes nothing.
--   app.assignment_declaration_required()  the bridge for the evidence role,
--                   which does not read schema institution; no grant to the
--                   app, only the evidence functions below call it.
--
-- Errors carry no input: ZD401 no session, ZD403 no relation, ZD422 invalid
-- input, ZD428 a required declaration is missing.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;

SET LOCAL ROLE ductus_identity;
-- A constant default keeps existing and legacy-created assignments as today.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN declaration_required boolean NOT NULL DEFAULT false;

-- Every change of the switch, append-only; written by the setter in the same
-- call as the change.
CREATE TABLE audit.declaration_required_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  required boolean NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX declaration_required_event_assignment_idx
  ON audit.declaration_required_event (institution_id, assignment_id, occurred_at);
CREATE INDEX declaration_required_event_actor_idx ON audit.declaration_required_event (actor_id, institution_id);
CREATE TRIGGER declaration_required_event_append_only BEFORE UPDATE OR DELETE
  ON audit.declaration_required_event FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER declaration_required_event_no_truncate BEFORE TRUNCATE
  ON audit.declaration_required_event FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.declaration_required_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.declaration_required_event FORCE ROW LEVEL SECURITY;
CREATE POLICY declaration_required_event_owner ON audit.declaration_required_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The switch in force and when it was last changed (null: never, off). No
-- access check: only the two functions below, which check first, call it.
CREATE FUNCTION institution.declaration_required_of(p_assignment_id uuid)
RETURNS TABLE (required boolean, changed_at timestamptz)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT a.declaration_required,
         (SELECT max(e.occurred_at) FROM audit.declaration_required_event e
           WHERE e.assignment_id = a.id AND e.institution_id = a.institution_id)
    FROM institution.assignment a WHERE a.id = p_assignment_id
$$;

-- The teacher of the assignment reads the switch.
CREATE FUNCTION institution.declaration_required_setting(p_assignment_id uuid)
RETURNS TABLE (required boolean, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = v_institution) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT s.required, s.changed_at FROM institution.declaration_required_of(p_assignment_id) s;
END
$$;

-- The teacher of the assignment sets the switch. The assignment row is taken
-- FOR UPDATE before the change, so a request in progress (FOR SHARE in
-- app.lock_student_assignment) finishes under the old value and one that
-- starts later reads the new one. A change writes its audit row in the same
-- call; setting the value in force writes nothing and returns it unchanged.
CREATE FUNCTION institution.set_declaration_required(p_assignment_id uuid, p_required boolean)
RETURNS TABLE (required boolean, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_current boolean;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_required IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT a.declaration_required INTO v_current FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_current IS DISTINCT FROM p_required THEN
    UPDATE institution.assignment a SET declaration_required = p_required
     WHERE a.id = p_assignment_id AND a.institution_id = v_institution;
    INSERT INTO audit.declaration_required_event (institution_id, assignment_id, required, actor_id)
    VALUES (v_institution, p_assignment_id, p_required, v_user);
  END IF;
  RETURN QUERY SELECT s.required, s.changed_at FROM institution.declaration_required_of(p_assignment_id) s;
END
$$;
REVOKE ALL ON FUNCTION institution.declaration_required_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.declaration_required_setting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.set_declaration_required(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.declaration_required_setting(uuid) TO ductus_app;
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

-- A request written while the switch was off carries no declaration. While
-- the switch is on, such a request is not recorded as a submission (the
-- owner's decision of 23. 11.: nothing is submitted without the declaration),
-- unless it is recorded already: the retry of a recorded submission (its
-- receipt not bound yet) still finds its row. ON CONFLICT DO NOTHING in
-- app.record_submission runs after this trigger, so the check of the existing
-- row is here.
CREATE FUNCTION declaration.require_pinned_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- app.record_submission runs as the evidence owner. Any other caller
  -- reaches its ordinary RLS check without invoking a private helper.
  IF current_user <> 'ductus_evidence' THEN RETURN NEW; END IF;
  IF app.assignment_declaration_required(NEW.assignment_id)
     AND NOT EXISTS (SELECT 1 FROM evidence.submission_request q
                      WHERE q.id = NEW.submission_request_id AND q.institution_id = NEW.institution_id
                        AND q.declaration_version_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM evidence.submission s
                      WHERE s.submission_request_id = NEW.submission_request_id
                        AND s.institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'declaration_required' USING ERRCODE = 'ZD428';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION declaration.require_pinned_submission() FROM PUBLIC;
CREATE TRIGGER require_pinned_declaration BEFORE INSERT ON evidence.submission
  FOR EACH ROW EXECUTE FUNCTION declaration.require_pinned_submission();

-- The rule of pin_request for the caller's own document and the revision they
-- submit, read before the request: 'declaration_required' when the assignment
-- requires a declaration and none is fresh for that revision, else 'proceed'
-- (also for anything app.request_submission answers itself: no session, not
-- the caller's document, an inaccessible assignment, a live request).
CREATE FUNCTION declaration.submission_gate(p_document_id text, p_revision bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor record;
  v_assignment uuid;
  v_version integer;
  v_saved declaration.statement%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN RETURN 'proceed'; END IF;
  SELECT pr.assignment_id INTO v_assignment
    FROM evidence.document d
    JOIN evidence.project pr ON pr.id = d.project_id AND pr.institution_id = d.institution_id
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id AND pr.principal_id = v_actor.user_id;
  IF NOT FOUND THEN RETURN 'proceed'; END IF;
  IF NOT app.assignment_declaration_required(v_assignment) THEN
    RETURN 'proceed';
  END IF;
  -- A live request binds (P5, P8): request_submission answers it.
  IF EXISTS (SELECT 1 FROM evidence.submission_request q
              WHERE (q.institution_id, q.assignment_id, q.principal_id)
                  = (v_actor.institution_id, v_assignment, v_actor.user_id)
                AND evidence.request_live(q.id, q.institution_id)) THEN
    RETURN 'proceed';
  END IF;
  SELECT a.current_version INTO v_version FROM app.lock_student_assignment(v_assignment) a;
  IF NOT FOUND THEN RETURN 'proceed'; END IF;
  SELECT * INTO v_saved FROM declaration.statement s
   WHERE (s.institution_id, s.assignment_id, s.principal_id)
       = (v_actor.institution_id, v_assignment, v_actor.user_id)
     AND s.payload_jcs IS NOT NULL
   ORDER BY s.version DESC LIMIT 1;
  IF FOUND AND declaration.is_fresh(v_saved, p_document_id, p_revision, v_version) THEN
    RETURN 'proceed';
  END IF;
  RETURN 'declaration_required';
END $$;
REVOKE ALL ON FUNCTION declaration.submission_gate(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.submission_gate(text, bigint) TO ductus_app;

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
DROP FUNCTION declaration.submission_gate(text, bigint);
DROP TRIGGER require_pinned_declaration ON evidence.submission;
DROP FUNCTION declaration.require_pinned_submission();
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
DROP FUNCTION institution.declaration_required_setting(uuid);
DROP FUNCTION institution.declaration_required_of(uuid);
DROP TABLE audit.declaration_required_event;
ALTER TABLE institution.assignment DROP COLUMN declaration_required;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
