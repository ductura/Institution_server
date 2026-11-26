-- migrate:up
-- SRV-ED35-KRITERIJI-STUDENT (lab editor ED-35; Daniel's decision of 26. 11.
-- 2026, Ductus#2058 c.7192734757): the student sees the working criteria of
-- her own work. This replaces the B-9 rule of 20261121150000 that the student
-- never gets a criterion from the server; the table and the teacher's two
-- functions do not change. No table changes.
--
--   collaboration.student_working_criteria   the criteria of every teacher
--                       who set one on the caller's own work, each teacher
--                       separately (never merged): the teacher's account and
--                       name pair, then the six criteria in the fixed order,
--                       with a null assessment and note where that teacher
--                       set nothing.
--
-- Only the student who owns the work (collaboration.actor_role 'student',
-- decided on every call). A teacher, another student, an administrator and
-- another institution are refused with one answer, also for a document that
-- does not exist (ZD403, C-23). ZD401 without a session. The web role cannot
-- read the names (identity.person_name), so the name pair comes from here, as
-- in app.student_mentorship_requests. A teacher with no row on the work does
-- not appear; a teacher whose rows remain after leaving the course does,
-- because the rows are about this work and go with it (retention). The read
-- writes nothing: no access log row, no evidence row, no hash. Errors carry no
-- input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION collaboration.student_working_criteria(p_document_id text)
RETURNS TABLE (
  teacher_id uuid, given_name text, family_name text,
  criterion_id text, assessment smallint, note text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'student'
     OR scope.principal_id IS DISTINCT FROM actor.user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    WITH authors AS (
      SELECT DISTINCT w.author_id
        FROM collaboration.teacher_working_criterion w
       WHERE w.document_id = p_document_id AND w.institution_id = scope.institution_id
    )
    SELECT t.author_id, n.given_name, n.family_name, c.id, w.assessment, w.note
      FROM authors t
      LEFT JOIN identity.person_name n
        ON n.institution_id = scope.institution_id AND n.user_id = t.author_id
     CROSS JOIN unnest(ARRAY['topic', 'structure', 'sources', 'method', 'language', 'formatting']) WITH ORDINALITY AS c (id, ord)
      LEFT JOIN collaboration.teacher_working_criterion w
        ON w.criterion_id = c.id AND w.document_id = p_document_id
       AND w.institution_id = scope.institution_id AND w.author_id = t.author_id
     ORDER BY n.family_name NULLS LAST, n.given_name NULLS LAST, t.author_id, c.ord;
END
$$;

REVOKE ALL ON FUNCTION collaboration.student_working_criteria(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.student_working_criteria(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.student_working_criteria(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
