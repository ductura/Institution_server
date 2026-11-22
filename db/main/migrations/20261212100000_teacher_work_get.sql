-- migrate:up
-- SRV-2003 (Ductus#2052; Ductus#2028 c.7024185874, teacher.work.get): what the
-- teacher's page of one work reads by the work's document id (N-07, "predaja").
--
--   app.teacher_work_get   the work (document id, student, name, assignment),
--                          its submission state, and the previous and next work
--                          of the same assignment
--
-- The caller must be a reader of the work: the works of an assignment come only
-- from app.assignment_works, which names the works of the students the caller
-- may read (a teacher or collaborator of the course, a seminar group teacher
-- for the own group, a mentor). A document that is not among them (the student's
-- own, another teacher's, an unknown one) gives no row, and the server answers
-- the same 404 for all. The order of the neighbours is that of
-- app.assignment_works (student, then document), as the overview of the
-- assignment. The state is one of: nije_predano (no submission), nakon_roka
-- (submitted after the deadline), ceka (submitted, the receipt is not bound yet)
-- and predano (submitted with a bound receipt). The read has no text of the work,
-- no hash and no submission id, and it writes nothing, so it makes no
-- audit.access_log row (a list without content, as the overview, P-5). No
-- session: ZD401.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_evidence;
GRANT EXECUTE ON FUNCTION app.assignment_works(uuid) TO ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.teacher_work_get(p_document_id text)
RETURNS TABLE (
  document_id text, student_id uuid, given_name text, family_name text, assignment_id uuid,
  state text, prev_document_id text, next_document_id text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_assignment uuid;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  SELECT s.assignment_id INTO v_assignment FROM collaboration.document_scope(p_document_id) s;
  IF v_assignment IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH works AS (
    SELECT w.document_id AS doc_id, w.student_id AS stu_id,
           lag(w.document_id) OVER (ORDER BY w.student_id, w.document_id) AS prev_id,
           lead(w.document_id) OVER (ORDER BY w.student_id, w.document_id) AS next_id
      FROM app.assignment_works(v_assignment) w
  )
  SELECT w.doc_id, w.stu_id, n.given_name, n.family_name, v_assignment,
         CASE
           WHEN NOT s.submitted THEN 'nije_predano'
           WHEN s.after_deadline THEN 'nakon_roka'
           WHEN r.state = 'ceka' THEN 'ceka'
           ELSE 'predano'
         END,
         w.prev_id, w.next_id
    FROM works w
    JOIN app.assignment_submissions(v_assignment) s ON s.student_id = w.stu_id
    LEFT JOIN identity.person_name n ON n.user_id = w.stu_id AND n.institution_id = v_actor.institution_id
    LEFT JOIN LATERAL app.submission_state_of(v_assignment, w.stu_id) r ON true
   WHERE w.doc_id = p_document_id;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_work_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_work_get(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_work_get(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
SET LOCAL ROLE ductus_evidence;
REVOKE EXECUTE ON FUNCTION app.assignment_works(uuid) FROM ductus_identity;
RESET ROLE;
