-- migrate:up
-- Notice acknowledgments already bind the SHA-256 fingerprint to the exact
-- version shown (20261104120000); private notes have their own storage.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.mentor_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentorship_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  mentor_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000 AND body ~ E'[^ \t\r\n]'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (mentorship_id, institution_id) REFERENCES institution.mentorship (id, institution_id),
  FOREIGN KEY (mentor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX mentor_note_mentorship_idx ON institution.mentor_note (mentorship_id, mentor_id, created_at, id);
ALTER TABLE institution.mentor_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.mentor_note FORCE ROW LEVEL SECURITY;
CREATE POLICY mentor_note_owner ON institution.mentor_note TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY mentor_note_read ON institution.mentor_note FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id())
         AND mentor_id = (SELECT app.current_user_id())
         AND institution.actor_mentorship_role(mentorship_id) = 'teacher');
GRANT SELECT ON institution.mentor_note TO ductus_app;

CREATE FUNCTION institution.create_mentor_note(p_mentorship_id uuid, p_body text)
RETURNS TABLE (id uuid, body text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_mentorship_role(p_mentorship_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 4000 OR p_body !~ E'[^ \t\r\n]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.mentor_note AS n (mentorship_id, institution_id, mentor_id, body)
    VALUES (p_mentorship_id, actor.institution_id, actor.user_id, p_body)
    RETURNING n.id, n.body, n.created_at;
END
$$;

REVOKE ALL ON FUNCTION institution.create_mentor_note(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.create_mentor_note(uuid, text) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.create_mentor_note(uuid, text);
DROP TABLE institution.mentor_note;
RESET ROLE;
