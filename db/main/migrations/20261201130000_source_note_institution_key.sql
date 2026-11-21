-- migrate:up
-- SRV-1601 (D-59): 20261128100000 reached the base without the institution
-- key and with a cascade, so the catalogue guard (033) failed. A migration in
-- the base is not changed, so this one keys the notes by the institution of
-- their source, drops the cascade and removes the notes in the functions that
-- remove a source, as 20261121130000 does for proofs.
SET LOCAL ROLE ductus_identity;

ALTER TABLE institution.source_note ADD COLUMN institution_id uuid;
UPDATE institution.source_note n SET institution_id = w.institution_id
  FROM institution.work_source w
 WHERE (w.assignment_id, w.student_id, w.id) = (n.assignment_id, n.student_id, n.source_id);
ALTER TABLE institution.source_note ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE institution.source_note DROP CONSTRAINT source_note_assignment_id_student_id_source_id_fkey;
-- No cascade (no foreign key of the application cascades): the functions
-- that remove a source remove its notes first, below.
ALTER TABLE institution.source_note ADD CONSTRAINT source_note_assignment_id_student_id_source_id_fkey
  FOREIGN KEY (assignment_id, student_id, source_id, institution_id)
  REFERENCES institution.work_source (assignment_id, student_id, id, institution_id);

CREATE OR REPLACE FUNCTION institution.source_notes(p_document_id text, p_source_id uuid, p_method text,
                                        p_note_id uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_scope record;
  v_assignment uuid;
  v_id uuid;
  v_fields jsonb;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM institution.require_actor() a;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_assignment := v_scope.assignment_id;
  IF v_scope.institution_id IS DISTINCT FROM v_institution
     OR v_scope.principal_id IS DISTINCT FROM v_user
     OR institution.work_source_access(v_assignment, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD403';
  END IF;

  -- The parent lock serializes the limit check with inserts and holds the
  -- source in place until the operation ends, including when it is deleted.
  PERFORM 1 FROM institution.work_source s
    WHERE (s.assignment_id, s.student_id, s.id, s.institution_id) =
          (v_assignment, v_user, p_source_id, v_institution)
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD403'; END IF;

  IF p_method = 'GET' THEN
    RETURN (SELECT coalesce(jsonb_agg(n.fields || jsonb_build_object('id', n.id) ORDER BY n.id), '[]'::jsonb)
              FROM institution.source_note n
             WHERE (n.assignment_id, n.student_id, n.source_id) = (v_assignment, v_user, p_source_id));
  END IF;

  IF p_method IN ('POST', 'PATCH') THEN
    IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR p_fields = '{}'::jsonb THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_fields) AS f(key, value)
      WHERE key NOT IN ('quote', 'page', 'note') OR (value <> 'null'::jsonb AND (
        jsonb_typeof(value) <> 'string' OR (value #>> '{}') !~ E'[^ \\t\\r\\n]' OR
        char_length(value #>> '{}') > CASE key WHEN 'page' THEN 80 ELSE 4000 END))) THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
  END IF;

  CASE p_method
    WHEN 'POST' THEN
      IF (SELECT count(*) FROM institution.source_note n
           WHERE (n.assignment_id, n.student_id, n.source_id) = (v_assignment, v_user, p_source_id)) >= 100 THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
      INSERT INTO institution.source_note (institution_id, assignment_id, student_id, source_id, fields)
        VALUES (v_institution, v_assignment, v_user, p_source_id, '{"quote":null,"page":null,"note":null}'::jsonb || p_fields)
        RETURNING id, fields INTO v_id, v_fields;
    WHEN 'PATCH' THEN
      UPDATE institution.source_note n SET fields = n.fields || p_fields
        WHERE (n.assignment_id, n.student_id, n.source_id, n.id) = (v_assignment, v_user, p_source_id, p_note_id)
        RETURNING n.id, n.fields INTO v_id, v_fields;
    WHEN 'DELETE' THEN
      DELETE FROM institution.source_note n
        WHERE (n.assignment_id, n.student_id, n.source_id, n.id) = (v_assignment, v_user, p_source_id, p_note_id)
        RETURNING n.id INTO v_id;
    ELSE
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END CASE;

  IF v_id IS NULL THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD403'; END IF;
  RETURN CASE WHEN p_method = 'DELETE' THEN 'null'::jsonb ELSE v_fields || jsonb_build_object('id', v_id) END;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
END;
$$;

-- Removing a source removes its notes (20261121130000 did the same for proofs).
CREATE OR REPLACE FUNCTION institution.delete_work_source(p_assignment_id uuid, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_note s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  DELETE FROM institution.source_proof s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

-- A teacher of the work removes a recommended or required source
-- (20261120190000), now with its proofs and notes first.
CREATE OR REPLACE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_note s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  DELETE FROM institution.source_proof s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

-- migrate:down
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION institution.delete_work_source(p_assignment_id uuid, p_source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_proof s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id
     AND w.requirement IS NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

-- A teacher of the work removes a recommended or required source
-- (20261120190000), now with its proofs first (restored).
CREATE OR REPLACE FUNCTION institution.delete_teacher_work_source(p_assignment_id uuid, p_student_id uuid, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.require_actor();
  IF institution.work_source_access(p_assignment_id, p_student_id) IS DISTINCT FROM 'reader' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The proofs of the source, only when the source itself is removed below.
  DELETE FROM institution.source_proof s
   USING institution.work_source w
   WHERE s.assignment_id = w.assignment_id AND s.student_id = w.student_id AND s.source_id = w.id
     AND w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  DELETE FROM institution.work_source w
   WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id
     AND w.requirement IS NOT NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.work_source w
              WHERE w.assignment_id = p_assignment_id AND w.student_id = p_student_id AND w.id = p_source_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION institution.source_notes(p_document_id text, p_source_id uuid, p_method text,
                                        p_note_id uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_scope record;
  v_assignment uuid;
  v_id uuid;
  v_fields jsonb;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM institution.require_actor() a;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_assignment := v_scope.assignment_id;
  IF v_scope.institution_id IS DISTINCT FROM v_institution
     OR v_scope.principal_id IS DISTINCT FROM v_user
     OR institution.work_source_access(v_assignment, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD403';
  END IF;

  -- The parent lock serializes the limit check with inserts and holds the
  -- source in place until the operation ends, including when it is deleted.
  PERFORM 1 FROM institution.work_source s
    WHERE (s.assignment_id, s.student_id, s.id, s.institution_id) =
          (v_assignment, v_user, p_source_id, v_institution)
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD403'; END IF;

  IF p_method = 'GET' THEN
    RETURN (SELECT coalesce(jsonb_agg(n.fields || jsonb_build_object('id', n.id) ORDER BY n.id), '[]'::jsonb)
              FROM institution.source_note n
             WHERE (n.assignment_id, n.student_id, n.source_id) = (v_assignment, v_user, p_source_id));
  END IF;

  IF p_method IN ('POST', 'PATCH') THEN
    IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR p_fields = '{}'::jsonb THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_fields) AS f(key, value)
      WHERE key NOT IN ('quote', 'page', 'note') OR (value <> 'null'::jsonb AND (
        jsonb_typeof(value) <> 'string' OR (value #>> '{}') !~ E'[^ \\t\\r\\n]' OR
        char_length(value #>> '{}') > CASE key WHEN 'page' THEN 80 ELSE 4000 END))) THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
  END IF;

  CASE p_method
    WHEN 'POST' THEN
      IF (SELECT count(*) FROM institution.source_note n
           WHERE (n.assignment_id, n.student_id, n.source_id) = (v_assignment, v_user, p_source_id)) >= 100 THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
      INSERT INTO institution.source_note (assignment_id, student_id, source_id, fields)
        VALUES (v_assignment, v_user, p_source_id, '{"quote":null,"page":null,"note":null}'::jsonb || p_fields)
        RETURNING id, fields INTO v_id, v_fields;
    WHEN 'PATCH' THEN
      UPDATE institution.source_note n SET fields = n.fields || p_fields
        WHERE (n.assignment_id, n.student_id, n.source_id, n.id) = (v_assignment, v_user, p_source_id, p_note_id)
        RETURNING n.id, n.fields INTO v_id, v_fields;
    WHEN 'DELETE' THEN
      DELETE FROM institution.source_note n
        WHERE (n.assignment_id, n.student_id, n.source_id, n.id) = (v_assignment, v_user, p_source_id, p_note_id)
        RETURNING n.id INTO v_id;
    ELSE
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END CASE;

  IF v_id IS NULL THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD403'; END IF;
  RETURN CASE WHEN p_method = 'DELETE' THEN 'null'::jsonb ELSE v_fields || jsonb_build_object('id', v_id) END;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
END;
$$;

ALTER TABLE institution.source_note DROP CONSTRAINT source_note_assignment_id_student_id_source_id_fkey;
ALTER TABLE institution.source_note ADD CONSTRAINT source_note_assignment_id_student_id_source_id_fkey
  FOREIGN KEY (assignment_id, student_id, source_id)
  REFERENCES institution.work_source (assignment_id, student_id, id) ON DELETE CASCADE;
ALTER TABLE institution.source_note DROP COLUMN institution_id;
