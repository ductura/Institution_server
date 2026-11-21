-- migrate:up
-- SRV-1903 (P-D3, owner decision of 21. 11. 2026): a student may withdraw a
-- submission and submit again while the deadline that holds for them lasts
-- (institution.effective_due_at, SRV-1108/1108C). Every submission and every
-- withdrawal is written and gets its own signed receipt; nothing is deleted or
-- changed. The teacher sees the last valid submission and the whole history.
-- After the deadline a withdrawal is refused. Withdrawal is on by default and
-- the teacher of an assignment may switch it off for that assignment.
--
-- Attempts. A submission request now carries its attempt, 1 for every request
-- made before this migration. The key (assignment, institution, student) of
-- the request becomes (assignment, institution, student, attempt), and the
-- same key of the submission is dropped (a submission is still one per
-- request). A new attempt is requested only when the submission of the
-- previous one is withdrawn, under the locks request_submission already takes
-- and the document lock the withdrawal takes too, so at most one request of a
-- student and assignment is live: not withdrawn. Every reader that took "the"
-- submission of a student now takes the live one
-- (evidence.submission_withdrawn); the history reader shows all of them.
--
-- Withdrawal. app.withdraw_submission takes the assignment and membership
-- (FOR SHARE, as a submission request; an extension takes the assignment FOR
-- UPDATE, so a withdrawal and an extension are ordered and the deadline read
-- after the lock is the one in force), then the packages and the document of
-- the request FOR UPDATE in record_submission's order. Only a confirmed
-- submission (its receipt bound) of the latest attempt is withdrawn, only while
-- withdrawal is allowed on the assignment and the click is not after the
-- deadline (P6: exactly at the deadline is in time). The withdrawal freezes its
-- receipt (ductus-submission-withdrawal-receipt-v1) with the key it names, as
-- prepare_submission_receipt does, and reopens the evidence packages of the
-- document the submission closed, so the student can work on and submit
-- again. The web process signs the frozen text outside the transaction and
-- binds the signature once (app.attach_withdrawal_receipt), as for a
-- submission receipt (docs/contracts/submission-receipt-v2.md).
--
--   institution.submission_withdrawal_setting  append-only switch per
--                   assignment, the latest row holds; none means allowed.
--   institution.submission_withdrawal_setting(), set_submission_withdrawal()
--                   the teacher of the assignment reads and sets it (C-23:
--                   from the relation, institution.work_relation).
--   app.student_withdrawal_terms  the caller's own switch and deadline on an
--                   assignment where the caller is a student; the bridge for
--                   the evidence role, which does not read schema institution.
--   evidence.submission_withdrawal, evidence.submission_withdrawal_receipt
--                   the withdrawal with its frozen receipt, and the bound
--                   signature; append-only.
--   app.withdraw_submission, app.attach_withdrawal_receipt
--                   the student's two steps of a withdrawal.
--   app.submission_history_of  every submission and withdrawal of a student,
--                   with their receipts; read through my_submission_history
--                   (the student) and teacher_submission_history (a reader
--                   of the work, as teacher_submission_state).
--
-- Errors carry no input: ZD401 no session, ZD403 no relation, ZD422 invalid
-- input. Identity and institution come from the session, never an argument.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence, declaration TO ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;

-- 1. The switch per assignment (identity role).
SET LOCAL ROLE ductus_identity;
CREATE TABLE institution.submission_withdrawal_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the records; the latest holds.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  allowed boolean NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX submission_withdrawal_setting_assignment_idx
  ON institution.submission_withdrawal_setting (assignment_id, institution_id, seq);
CREATE INDEX submission_withdrawal_setting_author_idx
  ON institution.submission_withdrawal_setting (created_by, institution_id);
ALTER TABLE institution.submission_withdrawal_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.submission_withdrawal_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY submission_withdrawal_setting_owner ON institution.submission_withdrawal_setting
  TO ductus_identity USING (true) WITH CHECK (true);

CREATE FUNCTION institution.refuse_withdrawal_setting_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'withdrawal setting is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER submission_withdrawal_setting_immutable BEFORE UPDATE OR DELETE
  ON institution.submission_withdrawal_setting
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_withdrawal_setting_change();
CREATE TRIGGER submission_withdrawal_setting_no_truncate BEFORE TRUNCATE
  ON institution.submission_withdrawal_setting
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_withdrawal_setting_change();

-- The switch in force and when it was last set (null: never, allowed). No
-- access check: only the functions below, which check first, call it.
CREATE FUNCTION institution.withdrawal_setting_of(p_assignment_id uuid)
RETURNS TABLE (allowed boolean, changed_at timestamptz)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce(s.allowed, true), s.created_at
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT x.allowed, x.created_at FROM institution.submission_withdrawal_setting x
       WHERE x.assignment_id = p_assignment_id ORDER BY x.seq DESC LIMIT 1) s ON true
$$;

-- The teacher of the assignment reads the switch.
CREATE FUNCTION institution.submission_withdrawal_setting(p_assignment_id uuid)
RETURNS TABLE (allowed boolean, changed_at timestamptz)
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
  RETURN QUERY SELECT s.allowed, s.changed_at FROM institution.withdrawal_setting_of(p_assignment_id) s;
END
$$;

-- The teacher of the assignment sets the switch. The assignment row is taken
-- FOR UPDATE, so a withdrawal in progress (FOR SHARE) finishes under the old
-- value and one that starts later reads the new one. Setting the value in
-- force writes nothing and returns it unchanged.
CREATE FUNCTION institution.set_submission_withdrawal(p_assignment_id uuid, p_allowed boolean)
RETURNS TABLE (allowed boolean, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_current record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_allowed IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.assignment a WHERE a.id = p_assignment_id AND a.institution_id = v_institution
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT * INTO v_current FROM institution.withdrawal_setting_of(p_assignment_id);
  IF v_current.allowed = p_allowed THEN
    RETURN QUERY SELECT v_current.allowed, v_current.changed_at;
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO institution.submission_withdrawal_setting AS s (institution_id, assignment_id, allowed, created_by)
    VALUES (v_institution, p_assignment_id, p_allowed, v_user)
    RETURNING s.allowed, s.created_at;
END
$$;

-- The caller's own switch and deadline in force, on an assignment where the
-- caller is a student (C-23); no row otherwise.
CREATE FUNCTION app.student_withdrawal_terms(p_assignment_id uuid)
RETURNS TABLE (allowed boolean, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.allowed, institution.effective_due_at(a.id, c.user_id)
    FROM institution.assignment a
    JOIN app.current_actor() c ON a.institution_id = c.institution_id
    CROSS JOIN LATERAL institution.withdrawal_setting_of(a.id) s
   WHERE a.id = p_assignment_id
     AND institution.work_relation(c.user_id, a.id) = 'student'
$$;

REVOKE ALL ON FUNCTION institution.refuse_withdrawal_setting_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.withdrawal_setting_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.submission_withdrawal_setting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.set_submission_withdrawal(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_withdrawal_terms(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.submission_withdrawal_setting(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.set_submission_withdrawal(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.student_withdrawal_terms(uuid) TO ductus_evidence, ductus_app;

-- 2. Attempts and the withdrawal (evidence role).
SET LOCAL ROLE ductus_evidence;
-- squawk-ignore adding-required-field
ALTER TABLE evidence.submission_request ADD COLUMN attempt integer NOT NULL DEFAULT 1
  CHECK (attempt BETWEEN 1 AND 1000);
ALTER TABLE evidence.submission_request
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT submission_request_assignment_id_institution_id_principal_i_key,
  -- squawk-ignore disallowed-unique-constraint
  ADD CONSTRAINT evidence_submission_request_attempt_key UNIQUE (assignment_id, institution_id, principal_id, attempt);
-- squawk-ignore ban-drop-constraint
ALTER TABLE evidence.submission DROP CONSTRAINT submission_assignment_id_institution_id_principal_id_key;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX evidence_submission_student_idx ON evidence.submission (assignment_id, institution_id, principal_id);
-- squawk-ignore disallowed-unique-constraint
ALTER TABLE evidence.submission ADD CONSTRAINT evidence_submission_withdrawal_key
  UNIQUE (id, institution_id, principal_id, assignment_id);

-- The withdrawal and its frozen receipt. The id is chosen before the insert,
-- because the receipt names it. The deadline is the one in force at the click.
CREATE TABLE evidence.submission_withdrawal (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE,
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  withdrawn_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  key_id text NOT NULL,
  key_version text NOT NULL,
  signed_at timestamptz NOT NULL,
  receipt_payload text NOT NULL,
  payload_digest_sha256 text NOT NULL
    CHECK (payload_digest_sha256 = encode(sha256(convert_to(receipt_payload, 'UTF8')), 'hex')),
  CHECK (withdrawn_at <= due_at),
  CHECK (signed_at >= withdrawn_at),
  UNIQUE (id, institution_id, principal_id, key_id, key_version, payload_digest_sha256),
  FOREIGN KEY (submission_id, institution_id, principal_id, assignment_id)
    REFERENCES evidence.submission (id, institution_id, principal_id, assignment_id),
  FOREIGN KEY (key_id, institution_id) REFERENCES evidence.signing_key (key_id, institution_id)
);
CREATE INDEX evidence_submission_withdrawal_submission_idx
  ON evidence.submission_withdrawal (submission_id, institution_id, principal_id, assignment_id);
CREATE INDEX evidence_submission_withdrawal_key_idx ON evidence.submission_withdrawal (key_id, institution_id);
CREATE INDEX evidence_submission_withdrawal_principal_idx
  ON evidence.submission_withdrawal (principal_id, institution_id);
ALTER TABLE evidence.submission_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.submission_withdrawal FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_submission_withdrawal_owner ON evidence.submission_withdrawal
  TO ductus_evidence USING (true) WITH CHECK (true);
-- The student reads the own withdrawals, as the own submissions
-- (app.student_workspace reads both with the caller's rights).
CREATE POLICY evidence_submission_withdrawal_read ON evidence.submission_withdrawal FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id()) AND principal_id = (SELECT app.current_user_id()));
GRANT SELECT ON evidence.submission_withdrawal TO ductus_app;
CREATE TRIGGER evidence_submission_withdrawal_immutable BEFORE UPDATE OR DELETE ON evidence.submission_withdrawal
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER evidence_submission_withdrawal_no_truncate BEFORE TRUNCATE ON evidence.submission_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- The signature of a withdrawal receipt, bound once, of the frozen key and
-- digest. No policy and no grant for the web role: only through the RPCs.
CREATE TABLE evidence.submission_withdrawal_receipt (
  withdrawal_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  key_id text NOT NULL,
  key_version text NOT NULL,
  payload_digest_sha256 text NOT NULL,
  signature jsonb NOT NULL
    CHECK (signature->>'keyId' = key_id AND signature->>'keyVersion' = key_version),
  bound_at timestamptz NOT NULL,
  FOREIGN KEY (withdrawal_id, institution_id, principal_id, key_id, key_version, payload_digest_sha256)
    REFERENCES evidence.submission_withdrawal (id, institution_id, principal_id, key_id, key_version,
                                              payload_digest_sha256)
);
CREATE INDEX evidence_submission_withdrawal_receipt_pin_idx ON evidence.submission_withdrawal_receipt
  (withdrawal_id, institution_id, principal_id, key_id, key_version, payload_digest_sha256);
ALTER TABLE evidence.submission_withdrawal_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.submission_withdrawal_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_submission_withdrawal_receipt_owner ON evidence.submission_withdrawal_receipt
  TO ductus_evidence USING (true) WITH CHECK (true);
CREATE TRIGGER evidence_submission_withdrawal_receipt_immutable BEFORE UPDATE OR DELETE
  ON evidence.submission_withdrawal_receipt
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER evidence_submission_withdrawal_receipt_no_truncate BEFORE TRUNCATE
  ON evidence.submission_withdrawal_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- Whether a submission was withdrawn; whether a request is still live (no
-- submission yet, or one that was not withdrawn). The owner's helpers.
CREATE FUNCTION evidence.submission_withdrawn(p_submission_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = p_submission_id)
$$;
CREATE FUNCTION evidence.request_live(p_request_id uuid, p_institution_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM evidence.submission s
      JOIN evidence.submission_withdrawal w ON w.submission_id = s.id
     WHERE s.submission_request_id = p_request_id AND s.institution_id = p_institution_id)
$$;
REVOKE ALL ON FUNCTION evidence.submission_withdrawn(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION evidence.request_live(uuid, uuid) FROM PUBLIC;

-- 3. Readers of "the" submission take the live one. As before otherwise.
CREATE OR REPLACE FUNCTION app.work_submitted(p_assignment_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.current_actor() a
      JOIN evidence.submission s
        ON s.principal_id = a.user_id AND s.institution_id = a.institution_id
     WHERE s.assignment_id = p_assignment_id
       AND NOT evidence.submission_withdrawn(s.id)
  )
$$;

CREATE OR REPLACE FUNCTION app.document_submitted(p_document_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.current_actor() a
      JOIN evidence.submission_request r ON r.institution_id = a.institution_id
      JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
     WHERE r.document_id = p_document_id
       AND NOT evidence.submission_withdrawn(s.id)
  )
$$;

CREATE OR REPLACE FUNCTION app.submitted_document_text(p_document_id text)
RETURNS TABLE(content_hash text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.artifact_hash, c.body
    FROM app.current_actor() a
    JOIN evidence.submission_request r ON r.institution_id = a.institution_id
    JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
    LEFT JOIN evidence.document_checkpoint c
      ON c.document_id = r.document_id AND c.institution_id = r.institution_id AND c.revision = s.revision
     AND c.content_hash = s.artifact_hash
     AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.body, 'UTF8')), 'hex') = s.artifact_hash
   WHERE r.document_id = p_document_id
     AND NOT evidence.submission_withdrawn(s.id)
$$;

CREATE OR REPLACE FUNCTION app.submission_state_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(state text, revision bigint, requested_at timestamptz, receipt_payload text,
              payload_digest_sha256 text, signature jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN x.id IS NULL THEN 'none' WHEN r.submission_id IS NULL THEN 'ceka' ELSE 'potvrdeno' END,
         x.revision, x.requested_at, r.receipt_payload, r.payload_digest_sha256, r.signature
    FROM app.current_actor() a
    LEFT JOIN evidence.submission x
      ON x.assignment_id = p_assignment_id AND x.institution_id = a.institution_id
     AND x.principal_id = p_student_id AND NOT evidence.submission_withdrawn(x.id)
    LEFT JOIN evidence.submission_receipt r
      ON r.submission_id = x.id AND r.institution_id = x.institution_id AND r.principal_id = x.principal_id
   WHERE a.institution_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION app.assignment_submissions(p_assignment_id uuid)
RETURNS TABLE(student_id uuid, submitted boolean, revision bigint, requested_minute timestamptz,
              after_deadline boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  -- At most one live submission per student and assignment (SRV-1903), and
  -- one open membership per student and course, so one row per student.
  RETURN QUERY
  SELECT s.student_id, x.id IS NOT NULL, x.revision,
         pg_catalog.date_trunc('minute', x.requested_at, 'UTC'), x.after_deadline
    FROM app.teacher_assignment_students(p_assignment_id) s
    LEFT JOIN evidence.submission x
      ON x.assignment_id = p_assignment_id AND x.institution_id = v_actor.institution_id
     AND x.principal_id = s.student_id AND NOT evidence.submission_withdrawn(x.id)
   ORDER BY s.student_id;
END
$$;

CREATE OR REPLACE FUNCTION app.replay_document_checkpoints(p_document_id text, p_content_hashes text[])
RETURNS TABLE(content_hash text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT DISTINCT ON (c.content_hash) c.content_hash, c.body
    FROM app.current_actor() a
    JOIN evidence.document_checkpoint c ON c.institution_id = a.institution_id
   WHERE c.document_id = p_document_id
     AND c.content_hash = ANY (p_content_hashes)
     AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.body, 'UTF8')), 'hex') = c.content_hash
     AND NOT EXISTS (
       SELECT 1
         FROM evidence.submission s
         JOIN evidence.submission_request r ON r.id = s.submission_request_id AND r.institution_id = s.institution_id
        WHERE r.document_id = c.document_id AND r.institution_id = c.institution_id
          AND c.revision > s.revision AND NOT evidence.submission_withdrawn(s.id))
   ORDER BY c.content_hash, c.revision
$$;

CREATE OR REPLACE FUNCTION app.work_version_rows(p_document_id text, p_before bigint)
RETURNS TABLE(kind text, revision bigint, saved_minute timestamptz, after_deadline boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH submitted AS (
    SELECT s.revision, s.requested_at, s.after_deadline
      FROM app.current_actor() a
      JOIN evidence.submission_request r ON r.institution_id = a.institution_id
      JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
     WHERE r.document_id = p_document_id
       AND NOT evidence.submission_withdrawn(s.id)
  )
  SELECT v.kind, v.revision, v.saved_minute, v.after_deadline
    FROM (
      SELECT 'submission'::text AS kind, s.revision,
             pg_catalog.date_trunc('minute', s.requested_at, 'UTC') AS saved_minute, s.after_deadline, 0 AS rank
        FROM submitted s
      UNION ALL
      SELECT 'checkpoint', c.revision, pg_catalog.date_trunc('minute', c.created_at, 'UTC'), NULL, 1
        FROM app.current_actor() a
        JOIN evidence.document_checkpoint c ON c.institution_id = a.institution_id
       WHERE c.document_id = p_document_id AND c.revision > 0
         AND NOT EXISTS (SELECT 1 FROM submitted s WHERE c.revision > s.revision)
    ) v
   WHERE p_before IS NULL OR v.revision < p_before
   ORDER BY v.revision DESC, v.rank
   LIMIT 201
$$;

CREATE OR REPLACE FUNCTION app.work_export_rows(p_document_id text, p_revision bigint)
RETURNS TABLE(revision bigint, kind text, body text, saved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.revision,
         CASE WHEN EXISTS (
           SELECT 1 FROM evidence.submission_request r
             JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
            WHERE r.institution_id = c.institution_id AND r.document_id = c.document_id AND s.revision = c.revision
              AND NOT evidence.submission_withdrawn(s.id)
         ) THEN 'submitted' ELSE 'saved' END,
         c.body, c.created_at
    FROM app.current_actor() a
    JOIN evidence.document_checkpoint c ON c.institution_id = a.institution_id
   WHERE c.document_id = p_document_id AND c.revision > 0
     AND (p_revision IS NULL OR c.revision = p_revision)
     AND NOT EXISTS (
       SELECT 1 FROM evidence.submission_request r
         JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
        WHERE r.institution_id = c.institution_id AND r.document_id = c.document_id AND c.revision > s.revision
          AND NOT evidence.submission_withdrawn(s.id)
     )
   ORDER BY c.revision DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.process_summary_record(p_document_id text)
RETURNS TABLE(evidence_package_id text, head_segment_hash text, segment_hashes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.id,
         CASE WHEN sub.revision IS NULL THEN p.head_segment_hash ELSE coalesce(cut.segment_hash, '') END,
         coalesce((
           SELECT array_agg(s.segment_hash ORDER BY s.sequence_from)
             FROM evidence.segment s
            WHERE s.evidence_package_id = p.id AND s.institution_id = p.institution_id
              AND (sub.revision IS NULL OR cut.sequence_from IS NULL OR s.sequence_from <= cut.sequence_from)),
           ARRAY[]::text[])
    FROM evidence.package p
    -- The live submission of this document, if any (one per student and
    -- assignment; a withdrawn one no longer cuts the record).
    LEFT JOIN LATERAL (
      SELECT s.revision
        FROM evidence.submission s
        JOIN evidence.submission_request r ON r.id = s.submission_request_id AND r.institution_id = s.institution_id
       WHERE r.document_id = p.document_id AND r.institution_id = p.institution_id
         AND NOT evidence.submission_withdrawn(s.id)
    ) sub ON true
    -- The last segment whose receipt names the submitted revision.
    LEFT JOIN LATERAL (
      SELECT s.segment_hash, s.sequence_from
        FROM evidence.segment s
        JOIN evidence.receipt r
          ON r.segment_id = s.id AND r.evidence_package_id = s.evidence_package_id AND r.institution_id = s.institution_id
       WHERE sub.revision IS NOT NULL
         AND s.evidence_package_id = p.id AND s.institution_id = p.institution_id
         AND pg_catalog.jsonb_typeof(r.receipt_payload::jsonb -> 'revision') = 'number'
         AND (r.receipt_payload::jsonb ->> 'revision')::numeric = sub.revision
       ORDER BY s.sequence_from DESC
       LIMIT 1
    ) cut ON true
   WHERE p.document_id = p_document_id
$$;

-- A package stays closed while its document has a live submission.
CREATE OR REPLACE FUNCTION evidence.keep_submitted_package_closed() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.accepts_evidence AND EXISTS (
    SELECT 1
      FROM evidence.submission s
      JOIN evidence.submission_request r ON r.id = s.submission_request_id AND r.institution_id = s.institution_id
     WHERE r.document_id = NEW.document_id AND r.institution_id = NEW.institution_id
       AND NOT evidence.submission_withdrawn(s.id)
  ) THEN
    RAISE EXCEPTION 'a package of a submitted document stays closed' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;

-- Five larger readers change in one predicate each; their bodies are not
-- repeated here. Each replacement must apply exactly as often as stated, or
-- the migration fails. app.student_workspace runs with the caller's rights and
-- reads the withdrawals through the web role's own-rows policy.
DO $$
DECLARE
  v record;
  v_def text;
  v_new text;
BEGIN
  FOR v IN SELECT * FROM (VALUES
    ('app.fast_path_works(uuid)',
     E'AND b.principal_id = v_doc.principal_id) AS submitted',
     E'AND b.principal_id = v_doc.principal_id\n                    AND NOT evidence.submission_withdrawn(b.id)) AS submitted', 1),
    ('app.student_workspace()',
     E'ON s.assignment_id = a.id AND s.institution_id = v_institution AND s.principal_id = v_user',
     E'ON s.assignment_id = a.id AND s.institution_id = v_institution AND s.principal_id = v_user\n'
     '     AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = s.id)', 1),
    ('declaration.save_statement(uuid,jsonb,text)',
     'FROM evidence.submission_request q WHERE (q.institution_id',
     'FROM evidence.submission_request q WHERE evidence.request_live(q.id, q.institution_id) AND (q.institution_id', 1),
    ('declaration.upload_attachment(uuid,text,bytea)',
     'FROM evidence.submission_request q WHERE (q.institution_id',
     'FROM evidence.submission_request q WHERE evidence.request_live(q.id, q.institution_id) AND (q.institution_id', 1),
    ('declaration.view_statement(uuid,uuid,uuid,bigint,integer)',
     'q.principal_id) = (p_institution, p_assignment, p_student);',
     E'q.principal_id) = (p_institution, p_assignment, p_student)\n      AND evidence.request_live(q.id, q.institution_id);', 1)
  ) AS t (fn, old, new, times)
  LOOP
    v_def := pg_catalog.pg_get_functiondef(v.fn::regprocedure);
    IF (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, v.old, '')))
       / pg_catalog.length(v.old) <> v.times THEN
      RAISE EXCEPTION 'SRV-1903: % does not contain the expected text', v.fn;
    END IF;
    v_new := pg_catalog.replace(v_def, v.old, v.new);
    EXECUTE v_new;
  END LOOP;
END
$$;

-- 4. A new attempt after a withdrawal. As 20261121107000 otherwise: the
-- latest request of the caller is "existing" while it is live; once its
-- submission is withdrawn and the withdrawal's receipt bound, the click makes
-- the next attempt (withdrawal_unsigned until then).
CREATE OR REPLACE FUNCTION app.request_submission(p_document_id text, p_revision bigint)
RETURNS TABLE(outcome text, submission_request_id uuid, requested_at timestamptz, revision bigint,
              assignment_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- The click, read before any lock wait (4.6: before reconstruction).
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor record;
  v_document evidence.document%ROWTYPE;
  v_project evidence.project%ROWTYPE;
  v_assignment record;
  v_named evidence.document_revision%ROWTYPE;
  v_existing evidence.submission_request%ROWTYPE;
  v_attempt integer;
  v_due timestamptz;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id)
     OR p_revision IS NULL OR p_revision < 0 OR p_revision > 9007199254740991 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  SELECT pr.* INTO v_project
    FROM evidence.document d
    JOIN evidence.project pr ON pr.id = d.project_id AND pr.institution_id = d.institution_id
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id AND pr.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  -- Lock order as in commit_evidence_segment: assignment and membership
  -- (FOR SHARE), then the document (FOR UPDATE).
  SELECT * INTO v_assignment FROM app.lock_student_assignment(v_project.assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  SELECT d.* INTO v_document
    FROM evidence.document d
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id
     AND d.principal_id = v_actor.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  -- The latest attempt binds while it is live (P5, P8); after its submission
  -- was withdrawn (SRV-1903) the click is the next attempt.
  SELECT s.* INTO v_existing
    FROM evidence.submission_request s
   WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id
   ORDER BY s.attempt DESC
   LIMIT 1;
  IF FOUND AND evidence.request_live(v_existing.id, v_existing.institution_id) THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  -- A withdrawal whose receipt is not bound yet keeps the next attempt closed:
  -- withdraw_submission reaches only the latest attempt, so its retry must
  -- still find that withdrawal and sign it. The web process answers 503.
  IF FOUND AND EXISTS (
       SELECT 1 FROM evidence.submission x
         JOIN evidence.submission_withdrawal w ON w.submission_id = x.id
        WHERE x.submission_request_id = v_existing.id AND x.institution_id = v_existing.institution_id
          AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal_receipt b WHERE b.withdrawal_id = w.id)) THEN
    RETURN QUERY SELECT 'withdrawal_unsigned'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  v_attempt := coalesce(v_existing.attempt, 0) + 1;
  IF NOT v_assignment.acknowledged THEN
    RETURN QUERY SELECT 'not_acknowledged'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF v_assignment.opens_at > v_now THEN
    RETURN QUERY SELECT 'not_open'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF p_revision = 0 OR v_document.current_revision = 0 THEN
    RETURN QUERY SELECT
      CASE WHEN p_revision = v_document.current_revision THEN 'no_evidence' ELSE 'stale_revision' END,
      NULL::uuid, NULL::timestamptz,
      CASE WHEN p_revision = v_document.current_revision THEN NULL::bigint ELSE v_document.current_revision END,
      NULL::integer;
    RETURN;
  END IF;
  -- The named revision must have been the current one at the click: it was
  -- accepted no later than v_now, and it is the current one now or its
  -- successor was accepted after v_now (a commit that held the document while
  -- this request waited for it).
  SELECT r.* INTO v_named
    FROM evidence.document_revision r
   WHERE r.document_id = v_document.id AND r.institution_id = v_document.institution_id
     AND r.revision = p_revision;
  IF NOT FOUND OR v_named.created_at > v_now OR (p_revision <> v_document.current_revision AND NOT EXISTS (
       SELECT 1 FROM evidence.document_revision n
        WHERE n.document_id = v_document.id AND n.institution_id = v_document.institution_id
          AND n.revision = p_revision + 1 AND n.created_at > v_now)) THEN
    RETURN QUERY SELECT 'stale_revision'::text, NULL::uuid, NULL::timestamptz, v_document.current_revision,
      NULL::integer;
    RETURN;
  END IF;

  -- SRV-1108C: the deadline that holds for the caller now, with the
  -- assignment held FOR SHARE, so no extension is recorded in between.
  v_due := app.student_effective_due_at(v_project.assignment_id);
  IF v_due IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::timestamptz, NULL::bigint, NULL::integer;
    RETURN;
  END IF;

  -- A second document of the same student and assignment can race past the
  -- lookup above; the unique key decides and the loser returns the winner.
  INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at, due_at, attempt
  ) VALUES (
    v_actor.institution_id, v_project.assignment_id, v_assignment.current_version, v_project.id,
    v_document.id, v_actor.user_id, v_named.revision, v_named.content_hash, v_now, v_due, v_attempt
  )
  ON CONFLICT (assignment_id, institution_id, principal_id, attempt) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT s.* INTO STRICT v_existing
      FROM evidence.submission_request s
     WHERE s.assignment_id = v_project.assignment_id AND s.institution_id = v_actor.institution_id
       AND s.principal_id = v_actor.user_id AND s.attempt = v_attempt;
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.requested_at, v_existing.revision,
      v_existing.assignment_version;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'requested'::text, v_id, v_now, v_named.revision, v_assignment.current_version;
END
$$;

-- 5. The withdrawal. Outcomes in check order: unauthorized (no session),
-- invalid (an argument of the wrong form), not_found (not an active student
-- of the assignment, or no such assignment: one answer), none (no recorded
-- submission of the latest attempt), existing (it was already withdrawn: the
-- earlier withdrawal, unchanged, with its signature once bound), pending (its
-- receipt is not bound yet, or a newer request is in progress), disabled (the
-- teacher switched withdrawal off), after_deadline (the click is after the
-- deadline in force), key_unavailable, withdrawn. Only "withdrawn" writes.
CREATE FUNCTION app.withdraw_submission(p_assignment_id uuid, p_key_id text, p_key_version text)
RETURNS TABLE(outcome text, withdrawal_id uuid, receipt_payload text, payload_digest_sha256 text, signature jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- The click, read before any lock wait.
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor record;
  v_request evidence.submission_request%ROWTYPE;
  v_latest uuid;
  v_submission evidence.submission%ROWTYPE;
  v_receipt evidence.submission_receipt%ROWTYPE;
  v_terms record;
  v_key evidence.signing_key%ROWTYPE;
  v_domain text;
  v_id uuid := gen_random_uuid();
  v_time timestamptz;
  v_payload text;
  v_written uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF p_assignment_id IS NULL OR p_key_id IS NULL OR p_key_version IS NULL
     OR length(p_key_id) NOT BETWEEN 1 AND 256 OR length(p_key_version) NOT BETWEEN 1 AND 256 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  PERFORM 1 FROM app.lock_student_assignment(p_assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  SELECT s.* INTO v_request
    FROM evidence.submission_request s
   WHERE s.assignment_id = p_assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id
   ORDER BY s.attempt DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  -- record_submission's order: the packages of the document, then the
  -- document. A request, a submission, a commit and another withdrawal of
  -- this document wait for this one, or this one for them.
  PERFORM 1 FROM evidence.package k
    WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
    ORDER BY k.id FOR UPDATE;
  PERFORM 1 FROM evidence.document d
    WHERE d.id = v_request.document_id AND d.institution_id = v_request.institution_id FOR UPDATE;
  -- A request made while this one waited is newer than the one locked.
  SELECT s.id INTO v_latest
    FROM evidence.submission_request s
   WHERE s.assignment_id = p_assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id
   ORDER BY s.attempt DESC
   LIMIT 1;
  IF v_latest IS DISTINCT FROM v_request.id THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  SELECT x.* INTO v_submission
    FROM evidence.submission x
   WHERE x.submission_request_id = v_request.id AND x.institution_id = v_request.institution_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF evidence.submission_withdrawn(v_submission.id) THEN
    RETURN QUERY SELECT 'existing'::text, w.id, w.receipt_payload, w.payload_digest_sha256, b.signature
      FROM evidence.submission_withdrawal w
      LEFT JOIN evidence.submission_withdrawal_receipt b ON b.withdrawal_id = w.id
     WHERE w.submission_id = v_submission.id;
    RETURN;
  END IF;
  SELECT r.* INTO v_receipt
    FROM evidence.submission_receipt r
   WHERE r.submission_id = v_submission.id AND r.institution_id = v_submission.institution_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  SELECT * INTO v_terms FROM app.student_withdrawal_terms(p_assignment_id);
  IF NOT FOUND OR v_terms.due_at IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF NOT v_terms.allowed THEN
    RETURN QUERY SELECT 'disabled'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF v_now > v_terms.due_at THEN
    RETURN QUERY SELECT 'after_deadline'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;

  -- The evidence domain of the withdrawn submission, from its bound receipt.
  v_domain := v_receipt.receipt_payload::jsonb ->> 'evidenceDomainId';
  -- As prepare_submission_receipt: the key is held, then the clock is read.
  SELECT k.* INTO v_key FROM evidence.signing_key k WHERE k.key_id = p_key_id FOR SHARE;
  v_time := pg_catalog.clock_timestamp();
  IF NOT FOUND OR v_key.key_version <> p_key_version OR v_key.purpose <> 'receipt' OR v_key.algorithm <> 'Ed25519'
     OR v_key.institution_id <> v_actor.institution_id OR v_key.evidence_domain_id::text IS DISTINCT FROM v_domain
     OR v_key.revoked_at IS NOT NULL OR v_time < v_key.valid_from
     OR (v_key.valid_to IS NOT NULL AND v_time >= v_key.valid_to) THEN
    RETURN QUERY SELECT 'key_unavailable'::text, NULL::uuid, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  -- Flat, fixed ASCII keys in UTF-16 order, as the submission receipt v2.
  v_payload := pg_catalog.format(
    '{"assignmentId":%s,"dueAt":%s,"evidenceDomainId":%s,"principalId":%s,'
    '"receiptSchema":"ductus-submission-withdrawal-receipt-v1","signedAt":%s,"submissionId":%s,'
    '"submissionReceiptSha256":%s,"withdrawalId":%s,"withdrawnAt":%s}',
    pg_catalog.to_json(v_submission.assignment_id)::text,
    pg_catalog.to_json(pg_catalog.to_char(v_terms.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
    pg_catalog.to_json(v_key.evidence_domain_id)::text,
    pg_catalog.to_json(v_submission.principal_id)::text,
    pg_catalog.to_json(pg_catalog.to_char(v_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
    pg_catalog.to_json(v_submission.id)::text,
    pg_catalog.to_json(v_receipt.payload_digest_sha256)::text,
    pg_catalog.to_json(v_id)::text,
    pg_catalog.to_json(pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text);
  INSERT INTO evidence.submission_withdrawal (
    id, submission_id, institution_id, principal_id, assignment_id, withdrawn_at, due_at,
    key_id, key_version, signed_at, receipt_payload, payload_digest_sha256
  ) VALUES (
    v_id, v_submission.id, v_submission.institution_id, v_submission.principal_id, v_submission.assignment_id,
    v_now, v_terms.due_at, v_key.key_id, v_key.key_version, v_time, v_payload,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex')
  )
  ON CONFLICT (submission_id) DO NOTHING
  RETURNING id INTO v_written;
  IF v_written IS NULL THEN
    RETURN QUERY SELECT 'existing'::text, w.id, w.receipt_payload, w.payload_digest_sha256, b.signature
      FROM evidence.submission_withdrawal w
      LEFT JOIN evidence.submission_withdrawal_receipt b ON b.withdrawal_id = w.id
     WHERE w.submission_id = v_submission.id;
    RETURN;
  END IF;
  -- The packages the submission closed accept again (keep_submitted_package_closed
  -- now sees no live submission of the document).
  UPDATE evidence.package k SET accepts_evidence = true
   WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
     AND NOT k.accepts_evidence;
  RETURN QUERY SELECT 'withdrawn'::text, v_id, v_payload,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex'), NULL::jsonb;
END
$$;

-- As attach_submission_receipt: outcomes in check order unauthorized,
-- invalid, not_found (no such withdrawal of the caller, or no longer an
-- active student of its assignment), existing (the bound signature,
-- unchanged), digest_mismatch, key_mismatch, key_revoked, key_not_valid,
-- attached. Only "attached" writes.
CREATE FUNCTION app.attach_withdrawal_receipt(p_withdrawal_id uuid, p_payload_digest_sha256 text,
                                              p_signature jsonb)
RETURNS TABLE(outcome text, receipt_payload text, payload_digest_sha256 text, signature jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_withdrawal evidence.submission_withdrawal%ROWTYPE;
  v_key evidence.signing_key%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF p_withdrawal_id IS NULL OR p_payload_digest_sha256 IS NULL OR p_payload_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_signature IS NULL OR pg_catalog.jsonb_typeof(p_signature) <> 'object' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF (SELECT pg_catalog.array_agg(k ORDER BY k COLLATE "C") FROM pg_catalog.jsonb_object_keys(p_signature) AS k)
     IS DISTINCT FROM ARRAY['algorithm','keyId','keyVersion','signatureBase64Url','signatureEncoding'] THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF p_signature->'algorithm' <> '"Ed25519"'::jsonb OR p_signature->'signatureEncoding' <> '"raw"'::jsonb
     OR pg_catalog.jsonb_typeof(p_signature->'keyId') <> 'string'
     OR pg_catalog.jsonb_typeof(p_signature->'keyVersion') <> 'string'
     OR pg_catalog.jsonb_typeof(p_signature->'signatureBase64Url') <> 'string'
     OR (p_signature->>'signatureBase64Url') !~ '^[A-Za-z0-9_-]{85}[AQgw]$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;

  SELECT w.* INTO v_withdrawal FROM evidence.submission_withdrawal w
   WHERE w.id = p_withdrawal_id AND w.institution_id = v_actor.institution_id
     AND w.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  -- Membership, then the withdrawal row (it serializes two binds), then the key.
  PERFORM 1 FROM app.lock_student_assignment(v_withdrawal.assignment_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  PERFORM 1 FROM evidence.submission_withdrawal w WHERE w.id = v_withdrawal.id FOR NO KEY UPDATE;
  -- Held until commit, so a revocation waits for this bind.
  SELECT k.* INTO v_key FROM evidence.signing_key k WHERE k.key_id = v_withdrawal.key_id FOR SHARE;

  IF EXISTS (SELECT 1 FROM evidence.submission_withdrawal_receipt b WHERE b.withdrawal_id = v_withdrawal.id) THEN
    RETURN QUERY SELECT 'existing'::text, v_withdrawal.receipt_payload, v_withdrawal.payload_digest_sha256,
      b.signature
      FROM evidence.submission_withdrawal_receipt b WHERE b.withdrawal_id = v_withdrawal.id;
    RETURN;
  END IF;
  IF p_payload_digest_sha256 <> v_withdrawal.payload_digest_sha256 THEN
    RETURN QUERY SELECT 'digest_mismatch'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF p_signature->>'keyId' <> v_withdrawal.key_id OR p_signature->>'keyVersion' <> v_withdrawal.key_version THEN
    RETURN QUERY SELECT 'key_mismatch'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  IF v_key.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'key_revoked'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;
  -- Valid at the frozen signedAt and still valid now, by a fresh DB clock.
  IF v_key.valid_from > v_withdrawal.signed_at
     OR (v_key.valid_to IS NOT NULL AND (v_withdrawal.signed_at >= v_key.valid_to
         OR pg_catalog.clock_timestamp() >= v_key.valid_to)) THEN
    RETURN QUERY SELECT 'key_not_valid'::text, NULL::text, NULL::text, NULL::jsonb; RETURN;
  END IF;

  INSERT INTO evidence.submission_withdrawal_receipt (
    withdrawal_id, institution_id, principal_id, key_id, key_version, payload_digest_sha256, signature, bound_at
  ) VALUES (
    v_withdrawal.id, v_withdrawal.institution_id, v_withdrawal.principal_id, v_withdrawal.key_id,
    v_withdrawal.key_version, v_withdrawal.payload_digest_sha256, p_signature, pg_catalog.clock_timestamp()
  );
  RETURN QUERY SELECT 'attached'::text, v_withdrawal.receipt_payload, v_withdrawal.payload_digest_sha256,
    p_signature;
END
$$;

-- 6. The history: every submission and withdrawal of a student on an
-- assignment of the caller's institution, oldest first, with the receipt of
-- each (null signature: not bound yet). No access check: only the two
-- readers below, which check first, call it.
CREATE FUNCTION app.submission_history_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(kind text, event_id uuid, attempt integer, submission_id uuid, revision bigint, at timestamptz,
              after_deadline boolean, receipt_payload text, payload_digest_sha256 text, signature jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.kind, e.event_id, e.attempt, e.submission_id, e.revision, e.at, e.after_deadline,
         e.receipt_payload, e.payload_digest_sha256, e.signature
    FROM app.current_actor() a
    CROSS JOIN LATERAL (
      SELECT 'submission'::text AS kind, x.id AS event_id, q.attempt, x.id AS submission_id, x.revision,
             x.requested_at AS at, x.after_deadline, r.receipt_payload, r.payload_digest_sha256, r.signature,
             0 AS rank
        FROM evidence.submission x
        JOIN evidence.submission_request q ON q.id = x.submission_request_id AND q.institution_id = x.institution_id
        LEFT JOIN evidence.submission_receipt r ON r.submission_id = x.id AND r.institution_id = x.institution_id
       WHERE x.assignment_id = p_assignment_id AND x.institution_id = a.institution_id
         AND x.principal_id = p_student_id
      UNION ALL
      SELECT 'withdrawal', w.id, q.attempt, w.submission_id, x.revision, w.withdrawn_at, NULL,
             w.receipt_payload, w.payload_digest_sha256, b.signature, 1
        FROM evidence.submission_withdrawal w
        JOIN evidence.submission x ON x.id = w.submission_id AND x.institution_id = w.institution_id
        JOIN evidence.submission_request q ON q.id = x.submission_request_id AND q.institution_id = x.institution_id
        LEFT JOIN evidence.submission_withdrawal_receipt b ON b.withdrawal_id = w.id
       WHERE w.assignment_id = p_assignment_id AND w.institution_id = a.institution_id
         AND w.principal_id = p_student_id
    ) e
   WHERE a.institution_id IS NOT NULL
   ORDER BY e.attempt, e.rank
$$;

REVOKE ALL ON FUNCTION app.withdraw_submission(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.attach_withdrawal_receipt(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.submission_history_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.withdraw_submission(uuid, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.attach_withdrawal_receipt(uuid, text, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.submission_history_of(uuid, uuid) TO ductus_identity;

-- 7. The two readers of the history (identity role, as my_submission_state
-- and teacher_submission_state). The student's terms come with the student's
-- reader: outcome not_found for anyone else, found otherwise.
SET LOCAL ROLE ductus_identity;
CREATE FUNCTION app.my_withdrawal_terms(p_assignment_id uuid)
RETURNS TABLE(outcome text, allowed boolean, due_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'found'::text, s.allowed, institution.effective_due_at(p_assignment_id, v_user)
    FROM institution.withdrawal_setting_of(p_assignment_id) s;
END
$$;

CREATE FUNCTION app.my_submission_history(p_assignment_id uuid)
RETURNS TABLE(kind text, event_id uuid, attempt integer, submission_id uuid, revision bigint, at timestamptz,
              after_deadline boolean, receipt_payload text, payload_digest_sha256 text, signature jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.submission_history_of(p_assignment_id, v_user);
END
$$;

-- A reader of the work (the teacher, mentor or committee, audit.reader_role)
-- and a student of the assignment, exactly as teacher_submission_state.
CREATE FUNCTION app.teacher_submission_history(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(kind text, event_id uuid, attempt integer, submission_id uuid, revision bigint, at timestamptz,
              after_deadline boolean, receipt_payload text, payload_digest_sha256 text, signature jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL
     OR audit.reader_role(v_institution, p_assignment_id, p_student_id) IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = p_student_id AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship t
                           WHERE t.id = s.mentorship_id AND t.institution_id = s.institution_id
                             AND t.student_id = p_student_id))) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.submission_history_of(p_assignment_id, p_student_id);
END
$$;
REVOKE ALL ON FUNCTION app.my_withdrawal_terms(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.my_submission_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_submission_history(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_withdrawal_terms(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.my_submission_history(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.teacher_submission_history(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence, declaration FROM ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;

-- migrate:down
-- Forward only. Staging and production only go forward (docs/BACKEND.md §6),
-- and a database with a second attempt cannot go back to one submission per
-- student and assignment; restoring every reader changed above would only
-- hide that. A local database is made again with db:up instead.
DO $$
BEGIN
  RAISE EXCEPTION 'SRV-1903 (20261201100100) does not go down; recreate the local database';
END
$$;
