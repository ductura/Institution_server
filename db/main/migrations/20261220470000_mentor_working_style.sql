-- migrate:up
-- SRV-F4-MEN-R09-SRV (F4-MEN-R09, Ductus#2058, orchestrator decision of
-- 26. 11. 2026): "Kako mentor radi", a free text of at most 1000 characters
-- that the mentor writes about the own way of working.
--
--   institution.mentor_working_style   one row per mentor (1:1 with the
--                       mentor's account); no direct grant to the app role.
--   institution.set_mentor_working_style(text)   the mentor writes or replaces
--                       the own text; only a teacher whose role is confirmed.
--   institution.read_mentor_working_style(uuid)   a student reads the text of
--                       a mentor she has a mentorship in force with.
--
-- Only the owner writes; only the students of that mentor read. Anyone else,
-- also for a mentor who does not exist, gets ZD403 (the adapter answers 404,
-- C-23); ZD401 without a session. The text is never validated beyond its
-- bounds and never read back into an error. No access log row is written.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.mentor_working_style (
  institution_id uuid NOT NULL,
  mentor_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000 AND body ~ E'[^ \t\r\n]'),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (institution_id, mentor_id),
  FOREIGN KEY (mentor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
ALTER TABLE institution.mentor_working_style ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.mentor_working_style FORCE ROW LEVEL SECURITY;
CREATE POLICY mentor_working_style_owner ON institution.mentor_working_style TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE FUNCTION institution.set_mentor_working_style(p_body text)
RETURNS TABLE (body text, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 1000 OR p_body !~ E'[^ \t\r\n]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.mentor_working_style AS s (institution_id, mentor_id, body)
    VALUES (actor.institution_id, actor.user_id, p_body)
    ON CONFLICT (institution_id, mentor_id)
    DO UPDATE SET body = EXCLUDED.body, updated_at = statement_timestamp()
    RETURNING s.body, s.updated_at;
END
$$;

CREATE FUNCTION institution.read_mentor_working_style(p_mentor_id uuid)
RETURNS TABLE (body text, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_mentor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM institution.mentorship m
    WHERE m.institution_id = actor.institution_id AND m.mentor_id = p_mentor_id
      AND m.student_id = actor.user_id AND m.ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT s.body, s.updated_at FROM institution.mentor_working_style s
    WHERE s.institution_id = actor.institution_id AND s.mentor_id = p_mentor_id;
END
$$;

REVOKE ALL ON FUNCTION institution.set_mentor_working_style(text), institution.read_mentor_working_style(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.set_mentor_working_style(text), institution.read_mentor_working_style(uuid) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.read_mentor_working_style(uuid);
DROP FUNCTION institution.set_mentor_working_style(text);
DROP TABLE institution.mentor_working_style;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
