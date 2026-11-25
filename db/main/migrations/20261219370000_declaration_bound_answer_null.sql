-- SRV-IZJAVA-ODGOVOR-NULL (INT-32, Ductus #2055 issuecomment-7165166930): the
-- answer bound with a declaration is null when the bound version has none.
-- bound_answer_of (20261214150000) joins declaration.question_answer with a
-- LEFT JOIN and built the answer with answer_ref() on the missing row, so a
-- declaration bound without an answer read as
-- {"questionId":null,"questionText":null,"text":null}. That is not the shape of
-- the contract (an answer object or null), and the HTTP edge answered the
-- course teacher's and the mentor's read of every such declaration with 503.
-- The answer is now built only when the row exists. Nothing else changes: the
-- same signature, owner, grants and callers.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION declaration.bound_answer_of(p_institution_id uuid, p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(document_id text, answer jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.document_id, CASE WHEN a.statement_id IS NOT NULL THEN declaration.answer_ref(a) END
    FROM evidence.submission x
    JOIN evidence.submission_request r
      ON r.id = x.submission_request_id AND r.institution_id = x.institution_id
    JOIN declaration.statement s
      ON s.id = r.declaration_version_id AND s.institution_id = r.institution_id
    LEFT JOIN declaration.question_answer a
      ON a.statement_id = s.id AND a.institution_id = s.institution_id
   WHERE x.institution_id = p_institution_id AND x.assignment_id = p_assignment_id
     AND x.principal_id = p_student_id AND NOT evidence.submission_withdrawn(x.id)
     AND s.content_sha256 = r.declaration_sha256
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION declaration.bound_answer_of(p_institution_id uuid, p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(document_id text, answer jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.document_id, declaration.answer_ref(a)
    FROM evidence.submission x
    JOIN evidence.submission_request r
      ON r.id = x.submission_request_id AND r.institution_id = x.institution_id
    JOIN declaration.statement s
      ON s.id = r.declaration_version_id AND s.institution_id = r.institution_id
    LEFT JOIN declaration.question_answer a
      ON a.statement_id = s.id AND a.institution_id = s.institution_id
   WHERE x.institution_id = p_institution_id AND x.assignment_id = p_assignment_id
     AND x.principal_id = p_student_id AND NOT evidence.submission_withdrawn(x.id)
     AND s.content_sha256 = r.declaration_sha256
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
