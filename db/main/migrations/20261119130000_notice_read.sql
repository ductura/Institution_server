-- migrate:up
-- SRV-06 (Ductus#2028, c.7008147932; PO-7 of the student prototype): the
-- student marks the notice of an assignment as read before acknowledging it.
-- One row per student and assignment, written once and never changed or
-- removed; a repeat returns the first read_at.
--
-- Only the student of the assignment writes it, for themselves, through
-- mark_notice_read(); the client never writes the table (no INSERT grant).
-- The student reads their own row, a teacher of the assignment's course the
-- rows of the course's assignments (the reach of notice_acknowledgment_read,
-- 20261108140000); anyone else, another institution included, sees nothing.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.notice_read (
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (assignment_id, student_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX notice_read_student_idx ON institution.notice_read (student_id);

ALTER TABLE institution.notice_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.notice_read FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_read_owner ON institution.notice_read TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY notice_read_read ON institution.notice_read FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id())
         AND (assignment_id = ANY ((SELECT institution.actor_assignment_ids('{teacher}'))::uuid[])
              OR (student_id = (SELECT app.current_user_id())
                  AND assignment_id = ANY ((SELECT institution.actor_assignment_ids('{student}'))::uuid[]))));

-- Append-only, for the owner too.
CREATE FUNCTION institution.refuse_notice_read_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'notice read is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER notice_read_immutable BEFORE UPDATE OR DELETE ON institution.notice_read
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_notice_read_change();
CREATE TRIGGER notice_read_no_truncate BEFORE TRUNCATE ON institution.notice_read
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_notice_read_change();

-- The caller marks the notice of the assignment as read and gets back when
-- it was first read. ZD401 without a session, ZD403 for anyone who is not a
-- student of the assignment (another's assignment is nonexistent, C-23).
CREATE FUNCTION institution.mark_notice_read(p_assignment_id uuid) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_read_at timestamptz;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO institution.notice_read (institution_id, assignment_id, student_id)
  VALUES (actor.institution_id, p_assignment_id, actor.user_id)
  ON CONFLICT (assignment_id, student_id) DO NOTHING;
  SELECT n.read_at INTO v_read_at FROM institution.notice_read n
   WHERE n.assignment_id = p_assignment_id AND n.student_id = actor.user_id;
  RETURN v_read_at;
END
$$;

REVOKE ALL ON FUNCTION institution.refuse_notice_read_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.mark_notice_read(uuid) FROM PUBLIC;
GRANT SELECT ON institution.notice_read TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.mark_notice_read(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.mark_notice_read(uuid);
DROP TABLE institution.notice_read;
DROP FUNCTION institution.refuse_notice_read_change();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
