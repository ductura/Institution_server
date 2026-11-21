-- migrate:up
-- SRV-1601 (D-59): the source belongs to one work and one student.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.source_note (
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  source_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fields jsonb NOT NULL CHECK (jsonb_strip_nulls(fields) <> '{}'::jsonb),
  PRIMARY KEY (assignment_id, student_id, source_id, id),
  FOREIGN KEY (assignment_id, student_id, source_id)
    REFERENCES institution.work_source (assignment_id, student_id, id) ON DELETE CASCADE
);

ALTER TABLE institution.source_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.source_note FORCE ROW LEVEL SECURITY;
CREATE POLICY source_note_owner ON institution.source_note TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE FUNCTION institution.source_notes(p_document_id text, p_source_id uuid, p_method text,
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

REVOKE ALL ON FUNCTION institution.source_notes(text, uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.source_notes(text, uuid, text, uuid, jsonb) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.source_notes(text, uuid, text, uuid, jsonb);
DROP TABLE institution.source_note;
