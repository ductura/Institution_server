-- migrate:up
-- SRV-V16-POVJERENSTVO-ZAPIS (val16-razlika, Ductus#2058): the committee of a
-- thesis as a list kept with the work. It is a list and nothing else: it gives
-- no right to read the work (that stays separate and waits for U-1, D-154,
-- D-238), it does not touch institution.work_grant or grant_can(), and nothing
-- here enters a grade or an export.
--
--   institution.work_thesis_committee_change  one row per change of the list
--   institution.work_thesis_committee_member  the members of that change,
--                                             append-only like the change
--
-- Every change replaces the whole list and is only ever added, so the history
-- stays; the newest change holds. A change that equals the list in force
-- writes nothing, and so does an empty list while there is none.
--
-- Who (C-23, from the relation, through institution.thesis_work_context):
--   read   the student owner, the mentor of the work, the administrator
--   write  the administrator of the institution only (student and mentor: ZD403)
-- A person with no part in the work, another institution and a work that is not
-- the work of a mentorship read ZD404.
--
-- The list: at most 5 members, at most one chair, members distinct, each a
-- teacher confirmed in the same institution and not revoked, and never the
-- student who writes the work (ZD422 otherwise).
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed, ZD404 not there
-- or no part in it, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_thesis_committee_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, institution_id),
  FOREIGN KEY (changed_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_thesis_committee_change_work_idx
  ON institution.work_thesis_committee_change (institution_id, document_id, seq);
CREATE INDEX work_thesis_committee_change_actor_idx
  ON institution.work_thesis_committee_change (changed_by, institution_id);

CREATE TABLE institution.work_thesis_committee_member (
  change_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('chair', 'member')),
  PRIMARY KEY (change_id, user_id),
  FOREIGN KEY (change_id, institution_id)
    REFERENCES institution.work_thesis_committee_change (id, institution_id),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE UNIQUE INDEX work_thesis_committee_member_one_chair_idx
  ON institution.work_thesis_committee_member (change_id) WHERE role = 'chair';
CREATE INDEX work_thesis_committee_member_user_idx
  ON institution.work_thesis_committee_member (user_id, institution_id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
-- institution.reject_thesis_record_change() is the one of the thesis migration.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_thesis_committee_change', 'work_thesis_committee_member'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_thesis_record_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_thesis_record_change()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- The committee in force of one work of the caller's institution (the session's,
-- never an argument): the members as a json array (the chair first, then by
-- user id; a name is null when the institution holds none) and the time of the
-- change in force, null while there has been none. Internal: the callers have
-- already passed thesis_work_context.
CREATE FUNCTION institution.thesis_committee_now(p_document_id text)
RETURNS TABLE (members jsonb, changed_at timestamptz)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'userId', m.user_id,
                    'name', CASE WHEN n.user_id IS NULL THEN NULL
                                 ELSE jsonb_build_object('givenName', n.given_name, 'familyName', n.family_name) END,
                    'role', m.role)
                  ORDER BY (m.role = 'chair') DESC, m.user_id)
             FROM institution.work_thesis_committee_member m
             LEFT JOIN identity.person_name n
               ON n.user_id = m.user_id AND n.institution_id = m.institution_id
            WHERE m.change_id = c.id), '[]'::jsonb),
         c.changed_at
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT x.id, x.changed_at FROM institution.work_thesis_committee_change x
       WHERE x.institution_id = (SELECT a.institution_id FROM app.current_actor() a)
         AND x.document_id = p_document_id
       ORDER BY x.seq DESC LIMIT 1) c ON true
$$;

CREATE FUNCTION app.read_work_thesis_committee(p_document_id text)
RETURNS TABLE (members jsonb, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  RETURN QUERY SELECT * FROM institution.thesis_committee_now(p_document_id);
END
$$;

-- The administrator replaces the whole list. The list in force writes nothing.
-- p_members is a json array of {userId, role}; anything else is ZD422.
CREATE FUNCTION app.set_work_thesis_committee(p_document_id text, p_members jsonb)
RETURNS TABLE (members jsonb, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_scope record;
  v_item jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_chairs integer := 0;
  v_change uuid;
  v_new text;
  v_now text;
BEGIN
  SELECT * INTO v_ctx FROM institution.thesis_work_context(p_document_id);
  IF v_ctx.o_part <> 'faculty' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_members IS NULL OR jsonb_typeof(p_members) <> 'array' OR jsonb_array_length(p_members) > 5 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  FOR v_item IN SELECT e FROM jsonb_array_elements(p_members) e LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 2
       OR jsonb_typeof(v_item -> 'userId') IS DISTINCT FROM 'string'
       OR (v_item ->> 'userId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_item -> 'role') IS DISTINCT FROM 'string'
       OR (v_item ->> 'role') NOT IN ('chair', 'member') THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    v_ids := v_ids || (v_item ->> 'userId')::uuid;
    IF v_item ->> 'role' = 'chair' THEN
      v_chairs := v_chairs + 1;
    END IF;
  END LOOP;
  IF v_chairs > 1 OR cardinality(v_ids) <> (SELECT count(DISTINCT u.id) FROM unnest(v_ids) u(id)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  -- Share-lock each confirmed teacher role against a concurrent revocation, in id order.
  FOR v_id IN SELECT u.id FROM unnest(v_ids) u(id) ORDER BY u.id LOOP
    IF institution.lock_teacher_role(v_id) IS NULL OR v_id = v_scope.principal_id THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('work_thesis_committee:' || v_ctx.o_institution_id || ':' || p_document_id, 0));
  SELECT coalesce(string_agg(x.user_id || ':' || x.role, ',' ORDER BY x.user_id), '') INTO v_now
    FROM (SELECT m.user_id, m.role
            FROM institution.work_thesis_committee_member m
           WHERE m.change_id = (
             SELECT c.id FROM institution.work_thesis_committee_change c
              WHERE c.institution_id = v_ctx.o_institution_id AND c.document_id = p_document_id
              ORDER BY c.seq DESC LIMIT 1)) x;
  SELECT coalesce(string_agg((e ->> 'userId') || ':' || (e ->> 'role'), ',' ORDER BY e ->> 'userId'), '') INTO v_new
    FROM jsonb_array_elements(p_members) e;
  IF v_now IS DISTINCT FROM v_new THEN
    INSERT INTO institution.work_thesis_committee_change (institution_id, document_id, changed_by)
    VALUES (v_ctx.o_institution_id, p_document_id, v_ctx.o_user_id)
    RETURNING id INTO v_change;
    INSERT INTO institution.work_thesis_committee_member (change_id, institution_id, user_id, role)
    SELECT v_change, v_ctx.o_institution_id, (e ->> 'userId')::uuid, e ->> 'role'
      FROM jsonb_array_elements(p_members) e;
  END IF;
  RETURN QUERY SELECT * FROM institution.thesis_committee_now(p_document_id);
END
$$;

REVOKE ALL ON FUNCTION institution.thesis_committee_now(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_thesis_committee(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_work_thesis_committee(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_thesis_committee(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.set_work_thesis_committee(text, jsonb) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.set_work_thesis_committee(text, jsonb);
DROP FUNCTION app.read_work_thesis_committee(text);
DROP FUNCTION institution.thesis_committee_now(text);
DROP TABLE institution.work_thesis_committee_member;
DROP TABLE institution.work_thesis_committee_change;
SET LOCAL ROLE ductus_migrator;
