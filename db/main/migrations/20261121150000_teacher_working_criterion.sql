-- migrate:up
-- SRV-1107 (wave 11, Ductus#2051; plan "Val 11", INVENTAR-editor E§3.5 mentor3
-- "Kriteriji ocjene", B-9 "Kriterij je samo radna bilješka nastavnika"): the six
-- criteria of the mentor's rubric as the teacher's working note on a work. Like a
-- private note (SRV-8B, D-130) it is not a view of the work: the student never
-- gets a criterion, an assessment or a note from the server, it never enters the
-- summary, an export or the submission, it is not part of the access log
-- (Ductus docs/PRODUCT.md §5 rule 17), and no number or grade is computed from
-- it. Nothing here writes the document, a revision, a segment, a receipt or a
-- hash, so it never enters the hash chain of the work.
--
--   collaboration.teacher_working_criterion   one row per author, work and
--                                             criterion, written only once an
--                                             assessment or a note is set; forced
--                                             RLS, owner policy only
--   collaboration.list_working_criteria       the caller's own rows on a work
--   collaboration.save_working_criterion      sets or clears the assessment and
--                                             the note of one criterion
--   collaboration.delete_working_criteria     retention only: the rows of a
--                                             document go with the document
--
-- The six criteria are a fixed list (the prototype's S.rubric); the assessment
-- is 0 "treba doraditi", 1 "dobro" or 2 "vrlo dobro", null for none, and the note
-- is a short text. A row with neither is deleted, so "cleared" and "never set"
-- read the same. Access comes from the relation (C-23): a teacher of that work
-- (collaboration.actor_role, decided on every call), and only the author reads
-- the rows; another teacher of the same work does not. The institution and the
-- author come from the session. Errors carry no input: ZD401 no session, ZD403
-- no relation (one answer also for a document that does not exist), ZD422 invalid
-- input (unknown criterion, assessment outside 0..2, note not a short text).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE collaboration.teacher_working_criterion (
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  author_id uuid NOT NULL,
  criterion_id text NOT NULL CHECK (criterion_id IN ('topic', 'structure', 'sources', 'method', 'language', 'formatting')),
  -- 0 treba doraditi, 1 dobro, 2 vrlo dobro. A label, never a number of points.
  assessment smallint CHECK (assessment BETWEEN 0 AND 2),
  note text CHECK (note IS NULL OR collaboration.is_comment_body(note)),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (document_id, institution_id, author_id, criterion_id),
  CHECK (assessment IS NOT NULL OR note IS NOT NULL),
  CHECK (author_id <> owner_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE collaboration.teacher_working_criterion ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.teacher_working_criterion FORCE ROW LEVEL SECURITY;
CREATE POLICY teacher_working_criterion_owner ON collaboration.teacher_working_criterion
  TO ductus_identity USING (true) WITH CHECK (true);

-- The caller's own criteria on one work: all six, in the fixed order, with a
-- null assessment and note where nothing is set. Only while the caller is a
-- teacher of the work; another teacher's rows never come.
CREATE FUNCTION collaboration.list_working_criteria(p_document_id text)
RETURNS TABLE (criterion_id text, assessment smallint, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT c.id, w.assessment, w.note
      FROM unnest(ARRAY['topic', 'structure', 'sources', 'method', 'language', 'formatting']) WITH ORDINALITY AS c (id, ord)
      LEFT JOIN collaboration.teacher_working_criterion w
        ON w.criterion_id = c.id AND w.document_id = p_document_id
       AND w.institution_id = scope.institution_id AND w.author_id = actor.user_id
     ORDER BY c.ord;
END
$$;

-- Sets the assessment and the note of one criterion, replacing both: a null
-- clears it, and a criterion with neither is removed. Returns the saved values.
CREATE FUNCTION collaboration.save_working_criterion(p_document_id text, p_criterion_id text, p_assessment smallint, p_note text)
RETURNS TABLE (criterion_id text, assessment smallint, note text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF NOT coalesce(p_criterion_id IN ('topic', 'structure', 'sources', 'method', 'language', 'formatting'), false)
     OR (p_assessment IS NOT NULL AND p_assessment NOT BETWEEN 0 AND 2)
     OR (p_note IS NOT NULL AND NOT coalesce(collaboration.is_comment_body(p_note), false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_assessment IS NULL AND p_note IS NULL THEN
    DELETE FROM collaboration.teacher_working_criterion w
     WHERE w.document_id = p_document_id AND w.institution_id = scope.institution_id
       AND w.author_id = actor.user_id AND w.criterion_id = p_criterion_id;
    RETURN QUERY SELECT p_criterion_id, NULL::smallint, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.teacher_working_criterion AS w
      (institution_id, document_id, assignment_id, owner_id, author_id, criterion_id, assessment, note)
    VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, actor.user_id,
            p_criterion_id, p_assessment, p_note)
    ON CONFLICT (document_id, institution_id, author_id, criterion_id)
    DO UPDATE SET assessment = EXCLUDED.assessment, note = EXCLUDED.note, updated_at = statement_timestamp()
    RETURNING w.criterion_id, w.assessment, w.note;
END
$$;

-- For the retention role only: called in the same transaction as deleting a
-- document under its retention rule or on a student's withdrawal (D-12), as
-- delete_teacher_notes, so the criteria go when the work goes. No rows: nothing
-- happens. Takes and returns no text.
CREATE FUNCTION collaboration.delete_working_criteria(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.teacher_working_criterion w
   WHERE w.document_id = p_document_id AND w.institution_id = p_institution_id
$$;

REVOKE ALL ON FUNCTION
  collaboration.list_working_criteria(text),
  collaboration.save_working_criterion(text, text, smallint, text),
  collaboration.delete_working_criteria(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.list_working_criteria(text),
  collaboration.save_working_criterion(text, text, smallint, text)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_working_criteria(text, uuid) TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_working_criteria(text, uuid);
DROP FUNCTION collaboration.save_working_criterion(text, text, smallint, text);
DROP FUNCTION collaboration.list_working_criteria(text);
DROP TABLE collaboration.teacher_working_criterion;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
