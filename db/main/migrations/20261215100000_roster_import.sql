-- migrate:up
-- SRV-ADMIN-2 admin-uvoz-popisa (Ductus#2055, NF-7 OA-10; owner decision of
-- 23 Nov 2026, t. 3): the administrator of an institution imports the list of
-- students of a course from Merlin or ISVU in two steps. The server reads the
-- CSV (server/institution/roster-import.ts); this migration keeps the two
-- database steps.
--
--   preview_roster_import  checks every row against the accounts of the
--                          caller's institution and the course, writes
--                          nothing to the course, and keeps the preview: the
--                          accounts it would enrol, for a short while;
--   confirm_roster_import  enrols exactly those accounts. The same import
--                          confirmed again answers its first result and
--                          enrols nobody twice.
--
-- Enrolment by code stays as it is; this is a second way in, not a change.
--
-- Who: only a confirmed, unrevoked administrator of the institution of the
-- course (admin_create_course, SRV-07). The administrator does not become a
-- member of the course and reads nothing of its content (C-23); the preview
-- answers only, row by row, what the administrator's own file says. The role
-- cannot be given to oneself: administrators are appointed only by the
-- operator procedure or by another administrator (20261116150000).
--
-- Matching: by hrEduPersonUniqueID, the AAI@EduHr identifier of the account
-- (D-09, D-16), only in the caller's institution; an identifier of another
-- institution reads as an unknown account. Accounts exist only after a first
-- sign-in, so a student who never signed in is an unknown account; nothing
-- here keeps an identifier without an account (no pre-enrolment, open for
-- the owner). The given and family names of the row are compared with the
-- account's name where one is known, in lower case with spaces collapsed;
-- a different name is a row not to enrol.
--
-- What is kept: the import (course, source, who and when, counts, expiry and
-- the confirmation) and the account ids it would enrol. No CSV, no identifier
-- and no name of a row. How long an import is kept is not decided (retention
-- periods wait for the owner's decision, NF-7 t. 5): nothing deletes it yet.
-- The administrator's action log (SRV-ADMIN-1, OA-3) does not exist on the
-- base yet; the import row is the record until it does (dependency).
--
-- Errors carry no input: ZD401 no session; ZD403 not an administrator;
-- ZD404 a course or import that is not the caller's institution's (or does
-- not exist); ZD410 a preview past its expiry; ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.roster_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  course_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('merlin', 'isvu')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 1000),
  new_count integer NOT NULL CHECK (new_count BETWEEN 0 AND row_count),
  confirmed_by uuid,
  confirmed_at timestamptz,
  enrolled_count integer CHECK (enrolled_count >= 0),
  already_count integer CHECK (already_count >= 0),
  skipped_count integer CHECK (skipped_count >= 0),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (confirmed_by, institution_id) REFERENCES identity.user_account (id, institution_id),
  UNIQUE (id, institution_id),
  CHECK (expires_at > created_at),
  CHECK (
    (confirmed_at IS NULL AND confirmed_by IS NULL AND enrolled_count IS NULL
       AND already_count IS NULL AND skipped_count IS NULL)
    OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND enrolled_count IS NOT NULL
       AND already_count IS NOT NULL AND skipped_count IS NOT NULL
       AND enrolled_count + already_count + skipped_count = new_count)
  )
);
CREATE INDEX roster_import_course_idx ON institution.roster_import (course_id, institution_id);
CREATE INDEX roster_import_created_by_idx ON institution.roster_import (created_by, institution_id);
CREATE INDEX roster_import_confirmed_by_idx ON institution.roster_import (confirmed_by, institution_id);

-- The accounts a preview found to enrol; written once with the preview.
CREATE TABLE institution.roster_import_entry (
  import_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (import_id, user_id),
  FOREIGN KEY (import_id, institution_id) REFERENCES institution.roster_import (id, institution_id),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX roster_import_entry_user_idx ON institution.roster_import_entry (user_id, institution_id);

-- As every institution table: forced RLS and only the owner's policy, so no
-- other role reads or writes a row; the application only through the two
-- functions below.
ALTER TABLE institution.roster_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.roster_import FORCE ROW LEVEL SECURITY;
CREATE POLICY roster_import_owner ON institution.roster_import TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE institution.roster_import_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.roster_import_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY roster_import_entry_owner ON institution.roster_import_entry TO ductus_identity USING (true) WITH CHECK (true);

-- An entry never changes and the import changes only by its confirmation.
CREATE FUNCTION institution.refuse_roster_import_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND TG_TABLE_NAME = 'roster_import' AND TG_OP = 'UPDATE' THEN
    IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
       AND (NEW.id, NEW.institution_id, NEW.course_id, NEW.source, NEW.created_by, NEW.created_at,
            NEW.expires_at, NEW.row_count, NEW.new_count)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.institution_id, OLD.course_id, OLD.source, OLD.created_by, OLD.created_at,
            OLD.expires_at, OLD.row_count, OLD.new_count) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'roster import is fixed' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER roster_import_fixed BEFORE UPDATE OR DELETE ON institution.roster_import
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_roster_import_change();
CREATE TRIGGER roster_import_no_truncate BEFORE TRUNCATE ON institution.roster_import
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_roster_import_change();
CREATE TRIGGER roster_import_entry_fixed BEFORE UPDATE OR DELETE ON institution.roster_import_entry
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_roster_import_change();
CREATE TRIGGER roster_import_entry_no_truncate BEFORE TRUNCATE ON institution.roster_import_entry
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_roster_import_change();

-- The limits, named once (server/institution/roster-import.ts holds the same).
CREATE FUNCTION institution.roster_import_max_rows() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 1000 $$;
CREATE FUNCTION institution.roster_import_valid_for() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT interval '30 minutes' $$;

-- A name as compared: lower case, spaces at the ends gone, runs of space one.
CREATE FUNCTION institution.roster_name_key(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')) $$;

-- The caller as a confirmed, unrevoked administrator, the row held FOR SHARE
-- until the end (as admin_create_course), or ZD403.
CREATE FUNCTION institution.roster_import_admin(OUT user_id uuid, OUT institution_id uuid)
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
BEGIN
  SELECT a.user_id, a.institution_id INTO user_id, institution_id FROM institution.require_actor() a;
  PERFORM 1 FROM institution.institution_role r
   WHERE r.institution_id = roster_import_admin.institution_id AND r.user_id = roster_import_admin.user_id
     AND r.role = 'admin' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
   FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

-- p_rows: a JSON array of at most 1000 objects of exactly {identifier,
-- givenName, familyName}, the rows of the file the server already found well
-- formed and distinct (by identifier in lower case). The answer: the import
-- id, its expiry and one status per row, in the order of p_rows:
--   new               an account of the institution, not in the course;
--   already_enrolled  a student of the course already;
--   unknown_account   no account of the institution with this identifier;
--   name_mismatch     the account's known name is another;
--   removed           removed from the course by a teacher, return not allowed;
--   course_teacher    a teacher of the course.
CREATE FUNCTION institution.preview_roster_import(p_course_id uuid, p_source text, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_import uuid;
  v_expires timestamptz;
  v_rows jsonb;
  v_statuses jsonb;
  v_new integer;
BEGIN
  SELECT * INTO actor FROM institution.roster_import_admin();
  IF p_source IS NULL OR p_source NOT IN ('merlin', 'isvu')
     OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR jsonb_array_length(p_rows) > institution.roster_import_max_rows()
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_rows) e (row)
        WHERE jsonb_typeof(e.row) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(e.row)) <> 3
           OR jsonb_typeof(e.row -> 'identifier') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e.row -> 'givenName') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e.row -> 'familyName') IS DISTINCT FROM 'string'
           OR NOT (e.row ->> 'identifier') ~ '^[!-?A-~]{1,128}@[a-z0-9.-]{1,126}$'
           OR NOT coalesce(institution.is_plain_label(e.row ->> 'givenName'), false)
           OR NOT coalesce(institution.is_plain_label(e.row ->> 'familyName'), false))
     OR (SELECT count(DISTINCT lower(e.row ->> 'identifier')) FROM jsonb_array_elements(p_rows) e (row))
        <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.course c WHERE c.id = p_course_id AND c.institution_id = actor.institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', c.user_id, 'status', c.status) ORDER BY c.n), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT e.n, u.id AS user_id,
             CASE
               WHEN u.id IS NULL THEN 'unknown_account'
               WHEN EXISTS (SELECT 1 FROM institution.course_member m
                             WHERE m.course_id = p_course_id AND m.user_id = u.id
                               AND m.member_to IS NULL AND m.role = 'teacher') THEN 'course_teacher'
               WHEN EXISTS (SELECT 1 FROM institution.course_member m
                             WHERE m.course_id = p_course_id AND m.user_id = u.id
                               AND m.member_to IS NULL AND m.role = 'student') THEN 'already_enrolled'
               WHEN EXISTS (SELECT 1 FROM institution.course_member m
                             WHERE m.course_id = p_course_id AND m.user_id = u.id
                               AND m.removed_by IS NOT NULL AND m.return_allowed_at IS NULL) THEN 'removed'
               WHEN EXISTS (SELECT 1 FROM identity.person_name p
                             WHERE p.user_id = u.id AND p.institution_id = actor.institution_id
                               AND (institution.roster_name_key(p.given_name)
                                      <> institution.roster_name_key(e.row ->> 'givenName')
                                    OR institution.roster_name_key(p.family_name)
                                      <> institution.roster_name_key(e.row ->> 'familyName'))) THEN 'name_mismatch'
               ELSE 'new'
             END AS status
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e (row, n)
        LEFT JOIN identity.user_account u
          ON u.institution_id = actor.institution_id
         AND lower(u.hr_edu_person_unique_id) = lower(e.row ->> 'identifier')
    ) c;

  SELECT count(*) FILTER (WHERE r ->> 'status' = 'new'),
         coalesce(jsonb_agg(r -> 'status' ORDER BY n), '[]'::jsonb)
    INTO v_new, v_statuses
    FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS x (r, n);

  v_expires := now() + institution.roster_import_valid_for();
  INSERT INTO institution.roster_import (institution_id, course_id, source, created_by, expires_at, row_count, new_count)
  VALUES (actor.institution_id, p_course_id, p_source, actor.user_id, v_expires, jsonb_array_length(p_rows), v_new)
  RETURNING id INTO v_import;
  INSERT INTO institution.roster_import_entry (import_id, institution_id, user_id)
  SELECT v_import, actor.institution_id, (r ->> 'user_id')::uuid
    FROM jsonb_array_elements(v_rows) x (r) WHERE r ->> 'status' = 'new';

  RETURN jsonb_build_object(
    'import_id', v_import,
    'expires_at', to_char(v_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'statuses', v_statuses
  );
END
$$;

-- Enrols the accounts of a preview, each as enroll_with_code would: under the
-- same lock per student (remove_student and enroll_with_code take it), the
-- student's open seminar group places held FOR SHARE first. An account that
-- became a member or was removed meanwhile is counted, not enrolled. The
-- answer: {enrolled, already_enrolled, skipped, already_confirmed}.
CREATE FUNCTION institution.confirm_roster_import(p_import_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_import institution.roster_import;
  v_user uuid;
  v_enrolled integer := 0;
  v_already integer := 0;
  v_skipped integer := 0;
BEGIN
  SELECT * INTO actor FROM institution.roster_import_admin();
  SELECT * INTO v_import FROM institution.roster_import i
   WHERE i.id = p_import_id AND i.institution_id = actor.institution_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF v_import.confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('enrolled', v_import.enrolled_count, 'already_enrolled', v_import.already_count,
                              'skipped', v_import.skipped_count, 'already_confirmed', true);
  END IF;
  IF statement_timestamp() >= v_import.expires_at THEN
    RAISE EXCEPTION 'expired' USING ERRCODE = 'ZD410';
  END IF;

  -- In one order, so two confirmations of overlapping imports cannot deadlock.
  FOR v_user IN
    SELECT e.user_id FROM institution.roster_import_entry e WHERE e.import_id = v_import.id ORDER BY e.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('institution.enroll_with_code:' || v_user, 0));
    IF EXISTS (SELECT 1 FROM institution.course_member m
                WHERE m.course_id = v_import.course_id AND m.user_id = v_user AND m.member_to IS NULL) THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM institution.course_member m
                WHERE m.course_id = v_import.course_id AND m.user_id = v_user
                  AND m.removed_by IS NOT NULL AND m.return_allowed_at IS NULL) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    PERFORM 1 FROM institution.seminar_group g
      JOIN institution.seminar_group_member s ON s.group_id = g.id AND s.institution_id = g.institution_id
     WHERE s.course_id = v_import.course_id AND s.institution_id = actor.institution_id
       AND s.user_id = v_user AND s.valid_to IS NULL
     ORDER BY g.id
       FOR SHARE OF g;
    INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
    VALUES (v_import.course_id, actor.institution_id, v_user, 'student');
    v_enrolled := v_enrolled + 1;
  END LOOP;

  UPDATE institution.roster_import i
     SET confirmed_by = actor.user_id, confirmed_at = now(),
         enrolled_count = v_enrolled, already_count = v_already, skipped_count = v_skipped
   WHERE i.id = v_import.id;
  RETURN jsonb_build_object('enrolled', v_enrolled, 'already_enrolled', v_already,
                            'skipped', v_skipped, 'already_confirmed', false);
END
$$;

REVOKE ALL ON FUNCTION institution.refuse_roster_import_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.roster_import_max_rows() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.roster_import_valid_for() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.roster_name_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.roster_import_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.preview_roster_import(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.confirm_roster_import(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.preview_roster_import(uuid, text, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.confirm_roster_import(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.confirm_roster_import(uuid);
DROP FUNCTION institution.preview_roster_import(uuid, text, jsonb);
DROP FUNCTION institution.roster_import_admin();
DROP FUNCTION institution.roster_name_key(text);
DROP FUNCTION institution.roster_import_valid_for();
DROP FUNCTION institution.roster_import_max_rows();
DROP TABLE institution.roster_import_entry;
DROP TABLE institution.roster_import;
DROP FUNCTION institution.refuse_roster_import_change();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
