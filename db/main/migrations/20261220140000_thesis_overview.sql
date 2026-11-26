-- migrate:up
-- SRV-V16-POPIS-FAKULTET (val16-razlika, Ductus#2058): the administrator of a
-- faculty reads the list of the theses of the faculty (for the registrar's
-- office): kind of work, mentor, student, stage after the submission, date of
-- the defence, state of the topic and size of the committee. Read only: no
-- table, no write, no grade. The order is the date of the defence (works with
-- no date last), then the id of the mentorship: no ranking of students.
--
-- Who (C-23): the administrator of the institution only; anyone else with a
-- session is ZD403. The institution is the session's, never an argument, so
-- another institution's works are never seen. Errors carry no input:
-- ZD401 no session, ZD403 not allowed, ZD422 invalid input.
--
-- The date is read to the millisecond (the contract's precision), so a key written
-- from it always matches the row it came from.
--
-- Paging is by key: the caller passes the key of the last row it got (date of
-- the defence or none, mentorship id), so no page skips or repeats a work.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;

-- The documents of the session's institution as (assignment, student, document), read for
-- the overview only: owned by the evidence role, which alone reads
-- evidence.project and evidence.document, and callable by the identity owner
-- only (never by the web role or anyone else).
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION app.thesis_work_documents()
RETURNS TABLE (assignment_id uuid, student_id uuid, document_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.assignment_id, d.principal_id, d.id
    FROM evidence.project p
    JOIN evidence.document d ON d.project_id = p.id AND d.institution_id = p.institution_id
                            AND d.principal_id = p.principal_id
   WHERE p.institution_id = (SELECT a.institution_id FROM app.current_actor() a)
$$;
REVOKE ALL ON FUNCTION app.thesis_work_documents() FROM PUBLIC, ductus_app;
GRANT EXECUTE ON FUNCTION app.thesis_work_documents() TO ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.read_thesis_overview(
  p_stage text, p_limit integer, p_after_set boolean, p_after_defense timestamptz, p_after_id uuid
)
RETURNS TABLE (
  mentorship_id uuid, document_id text, work_type text,
  mentor_given_name text, mentor_family_name text,
  student_given_name text, student_family_name text,
  stage text, defense_at timestamptz, topic_state text, committee_size integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF (p_stage IS NOT NULL AND p_stage NOT IN ('none', 'submitted_to_office', 'defense_scheduled', 'defended'))
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
     OR p_after_set IS NULL OR (p_after_set AND p_after_id IS NULL) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
  SELECT w.mentorship_id, w.document_id, w.work_type,
         w.mentor_given_name, w.mentor_family_name, w.student_given_name, w.student_family_name,
         w.stage, w.defense_at, w.topic_state, w.committee_size
    FROM (
      SELECT m.id AS mentorship_id, doc.id AS document_id, m.work_type,
             mn.given_name AS mentor_given_name, mn.family_name AS mentor_family_name,
             sn.given_name AS student_given_name, sn.family_name AS student_family_name,
             coalesce(st.stage, 'none') AS stage,
             date_trunc('milliseconds', st.defense_at) AS defense_at,
             CASE WHEN tv.id IS NULL THEN 'none' WHEN td.id IS NULL THEN 'proposed' ELSE td.decision END AS topic_state,
             coalesce(cm.size, 0) AS committee_size
        FROM institution.mentorship m
        LEFT JOIN identity.person_name mn ON mn.user_id = m.mentor_id AND mn.institution_id = m.institution_id
        LEFT JOIN identity.person_name sn ON sn.user_id = m.student_id AND sn.institution_id = m.institution_id
        LEFT JOIN LATERAL (
          SELECT d.document_id AS id
            FROM institution.assignment a
            JOIN app.thesis_work_documents() d
              ON d.assignment_id = a.id AND d.student_id = m.student_id
           WHERE a.mentorship_id = m.id AND a.institution_id = m.institution_id
           ORDER BY d.document_id LIMIT 1) doc ON true
        LEFT JOIN LATERAL (
          SELECT x.stage, x.defense_at FROM institution.work_thesis_stage_event x
           WHERE doc.id IS NOT NULL AND x.institution_id = m.institution_id AND x.document_id = doc.id
           ORDER BY x.seq DESC LIMIT 1) st ON true
        LEFT JOIN LATERAL (
          SELECT x.id, x.version FROM institution.work_thesis_topic_version x
           WHERE doc.id IS NOT NULL AND x.institution_id = m.institution_id AND x.document_id = doc.id
           ORDER BY x.version DESC LIMIT 1) tv ON true
        LEFT JOIN LATERAL (
          SELECT y.id, y.decision FROM institution.work_thesis_topic_decision y
           WHERE tv.id IS NOT NULL AND y.institution_id = m.institution_id AND y.document_id = doc.id
             AND y.version = tv.version
           ORDER BY y.seq DESC LIMIT 1) td ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS size FROM institution.work_thesis_committee_member c
           WHERE c.change_id = (
             SELECT z.id FROM institution.work_thesis_committee_change z
              WHERE doc.id IS NOT NULL AND z.institution_id = m.institution_id AND z.document_id = doc.id
              ORDER BY z.seq DESC LIMIT 1)) cm ON true
       WHERE m.institution_id = v_institution) w
   WHERE (p_stage IS NULL OR w.stage = p_stage)
     AND (NOT p_after_set
          OR (p_after_defense IS NOT NULL AND (w.defense_at IS NULL OR w.defense_at > p_after_defense
                OR (w.defense_at = p_after_defense AND w.mentorship_id > p_after_id)))
          OR (p_after_defense IS NULL AND w.defense_at IS NULL AND w.mentorship_id > p_after_id))
   ORDER BY w.defense_at NULLS LAST, w.mentorship_id
   LIMIT p_limit + 1;
END
$$;

REVOKE ALL ON FUNCTION app.read_thesis_overview(text, integer, boolean, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_thesis_overview(text, integer, boolean, timestamptz, uuid) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.read_thesis_overview(text, integer, boolean, timestamptz, uuid);
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.thesis_work_documents();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
