-- DAN-801 (S-1J-e; contract on Ductus#1836, comment 6904644368, confirmed in
-- 6904658286): settings by level (D-298, plan annex 3a), who may change which
-- level (D-297), and the history of every change.
--
-- Levels, lowest first: personal (a person), course, institution, and the two
-- application-wide levels system and network_security, which do not bound
-- each other. A row's scope is a set of columns with foreign keys, never a
-- free id. The key is not checked against a catalogue yet (S-1J-f) and the
-- value is any JSON. There is no read function yet and no role but the owner
-- holds a right on either table.
--
-- The bound of a higher level holds for every lower level in its scope:
-- institution bounds the course and personal rows of that institution; system
-- and network_security bound every institution, course and personal row. A
-- bound is {"locked": true} or {"min": n, "max": n} with JSON numbers, either
-- end optional and inclusive; a bounded value must be a JSON number. Only the
-- institution, system and network_security levels set a bound. A bound must
-- lie inside every higher one, and a level's own value inside its own bound
-- (a lock holds the level's own value for the levels below).
-- When a higher level sets or narrows a bound, every lower row of that key in
-- its scope that breaks it is deleted in the same transaction, each with a
-- history row (cause 'bound'), so no stored value ever crosses a higher bound
-- and a lower level cannot hold a higher one back. All writes of one key take
-- one transaction-level advisory lock, so a bound and a lower write never pass
-- each other.
--
-- Who writes (D-297, D-298): personal, every person for themselves; course,
-- an open teacher of the course or an administrator of its institution;
-- institution, its administrator; network_security, a network engineer with
-- an open appointment. system has no writer, and the application
-- administrator does not write network_security either, until identity.app_admin
-- is linked to an account (owner action V-7, plan question 8).
--
-- settings.change is append-only, in three layers like identity.app_admin
-- (DAN-798): its owner has only SELECT and INSERT, the only policies are for
-- those two, and a trigger refuses UPDATE, DELETE and TRUNCATE to every role
-- that is not a superuser (ZD409).
-- migrate:up

SET LOCAL ROLE ductus_migrator;
CREATE SCHEMA settings;
GRANT USAGE ON SCHEMA settings TO ductus_app, ductus_identity;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA settings TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- {"locked": true} alone, or "min" and/or "max" as JSON numbers, min <= max.
CREATE FUNCTION settings.is_bound(p_bound jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_bound) IS DISTINCT FROM 'object' OR octet_length(p_bound::text) > 256 THEN false
    WHEN p_bound = '{"locked": true}'::jsonb THEN true
    WHEN p_bound = '{}'::jsonb OR p_bound ? 'locked'
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_bound) k WHERE k NOT IN ('min', 'max'))
      OR (p_bound ? 'min' AND pg_catalog.jsonb_typeof(p_bound -> 'min') <> 'number')
      OR (p_bound ? 'max' AND pg_catalog.jsonb_typeof(p_bound -> 'max') <> 'number') THEN false
    ELSE coalesce((p_bound ->> 'min')::numeric <= (p_bound ->> 'max')::numeric, true)
  END
$$;

-- Does a value (NULL: none) keep inside a bound (NULL: none)?
CREATE FUNCTION settings.fits(p_value jsonb, p_bound jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_bound IS NULL OR p_value IS NULL THEN true
    WHEN p_bound ? 'locked' OR pg_catalog.jsonb_typeof(p_value) <> 'number' THEN false
    ELSE coalesce((p_value #>> '{}')::numeric >= (p_bound ->> 'min')::numeric, true)
     AND coalesce((p_value #>> '{}')::numeric <= (p_bound ->> 'max')::numeric, true)
  END
$$;

-- Does a lower bound (NULL: none) lie inside a higher one (NULL: none)?
CREATE FUNCTION settings.bound_within(p_inner jsonb, p_outer jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_outer IS NULL OR p_inner IS NULL THEN true
    WHEN p_outer ? 'locked' THEN false
    WHEN p_inner ? 'locked' THEN true
    ELSE (NOT p_outer ? 'min' OR coalesce((p_inner ->> 'min')::numeric >= (p_outer ->> 'min')::numeric, false))
     AND (NOT p_outer ? 'max' OR coalesce((p_inner ->> 'max')::numeric <= (p_outer ->> 'max')::numeric, false))
  END
$$;

CREATE TABLE settings.value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL CHECK (level IN ('personal', 'course', 'institution', 'system', 'network_security')),
  institution_id uuid REFERENCES identity.institution (id),
  user_id uuid,
  course_id uuid,
  key text NOT NULL CHECK (length(key) <= 64 AND key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  value jsonb CHECK (octet_length(value::text) <= 8192),
  bound jsonb CHECK (bound IS NULL OR (settings.is_bound(bound) AND level IN ('institution', 'system', 'network_security'))),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (course_id, institution_id) REFERENCES institution.course (id, institution_id),
  CHECK (value IS NOT NULL OR bound IS NOT NULL),
  -- A level may lock its own value; any other own bound must hold it.
  CHECK (coalesce(bound ? 'locked', false) OR settings.fits(value, bound)),
  CHECK (CASE level
    WHEN 'personal' THEN user_id IS NOT NULL AND institution_id IS NOT NULL AND course_id IS NULL
    WHEN 'course' THEN course_id IS NOT NULL AND institution_id IS NOT NULL AND user_id IS NULL
    WHEN 'institution' THEN institution_id IS NOT NULL AND user_id IS NULL AND course_id IS NULL
    ELSE institution_id IS NULL AND user_id IS NULL AND course_id IS NULL
  END)
);
CREATE UNIQUE INDEX value_scope_key ON settings.value
  (level, coalesce(user_id, course_id, institution_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
CREATE INDEX value_key ON settings.value (key, level);
CREATE INDEX value_user ON settings.value (user_id, institution_id) WHERE user_id IS NOT NULL;
CREATE INDEX value_course ON settings.value (course_id, institution_id) WHERE course_id IS NOT NULL;
CREATE INDEX value_institution ON settings.value (institution_id) WHERE institution_id IS NOT NULL;

ALTER TABLE settings.value ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.value FORCE ROW LEVEL SECURITY;
CREATE POLICY value_owner ON settings.value TO ductus_identity USING (true) WITH CHECK (true);

-- The scope and the author are copied, without foreign keys: the history
-- outlives them, and a foreign key's check would take FOR KEY SHARE on these
-- rows, which needs the UPDATE right the owner gives up below.
CREATE TABLE settings.change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('personal', 'course', 'institution', 'system', 'network_security')),
  institution_id uuid,
  user_id uuid,
  course_id uuid,
  key text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  old_bound jsonb,
  new_bound jsonb,
  cause text NOT NULL CHECK (cause IN ('set', 'bound')),
  changed_by uuid NOT NULL,
  changed_by_institution uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (old_value IS DISTINCT FROM new_value OR old_bound IS DISTINCT FROM new_bound)
);
CREATE INDEX change_key ON settings.change (key, changed_at);

ALTER TABLE settings.change ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.change FORCE ROW LEVEL SECURITY;
CREATE POLICY change_owner_read ON settings.change FOR SELECT TO ductus_identity USING (true);
CREATE POLICY change_owner_append ON settings.change FOR INSERT TO ductus_identity WITH CHECK (true);
REVOKE UPDATE, DELETE, TRUNCATE ON settings.change FROM ductus_identity;

-- SECURITY INVOKER, so current_user is the role that writes, not the owner.
CREATE FUNCTION settings.refuse_change_rewrite() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF NOT coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'settings.change is append-only' USING ERRCODE = 'ZD409';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER change_refuse_row_rewrite BEFORE UPDATE OR DELETE ON settings.change
  FOR EACH ROW EXECUTE FUNCTION settings.refuse_change_rewrite();
CREATE TRIGGER change_refuse_truncate BEFORE TRUNCATE ON settings.change
  FOR EACH STATEMENT EXECUTE FUNCTION settings.refuse_change_rewrite();

-- Sets the caller's value and/or bound of a key at a level; both NULL removes
-- the row, and the level above holds again. p_course names the course for
-- the course level and must be NULL for every other: who and which
-- institution always come from the session. Returns the id of the history
-- row, or NULL when nothing changed. ZD401 without a live session, ZD422 for
-- an input of a wrong shape, ZD403 for a level or course that is not the
-- caller's (another institution's course and a course that does not exist
-- alike), ZD409 when a higher bound is crossed.
--
-- The session row is taken FOR SHARE before app.current_actor() is asked, as
-- in identity.set_interface_locale(), so a write never follows a confirmed
-- logout. Locks are always taken session first, key second.
CREATE FUNCTION settings.set_value(
  p_level text, p_course uuid, p_key text, p_value jsonb, p_bound jsonb DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_actor_institution uuid;
  v_institution uuid;
  v_allowed boolean;
  v_old settings.value;
  v_low settings.value;
  v_change bigint;
BEGIN
  PERFORM 1 FROM identity.session s
   WHERE s.token_hash = pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.current_setting('app.session_token', true), 'UTF8'))
     FOR SHARE;
  SELECT a.user_id, a.institution_id INTO v_user, v_actor_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;

  IF p_level IS NULL OR p_level NOT IN ('personal', 'course', 'institution', 'system', 'network_security')
     OR (p_level = 'course') <> (p_course IS NOT NULL)
     OR p_key IS NULL OR length(p_key) > 64 OR p_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
     OR octet_length(p_value::text) > 8192
     OR (p_bound IS NOT NULL AND (p_level NOT IN ('institution', 'system', 'network_security')
                                  OR NOT settings.is_bound(p_bound)))
     OR NOT (coalesce(p_bound ? 'locked', false) OR settings.fits(p_value, p_bound)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  v_allowed := CASE p_level
    WHEN 'personal' THEN true
    WHEN 'course' THEN institution.actor_course_role(p_course) IS NOT DISTINCT FROM 'teacher'
      OR (institution.actor_has_role('admin')
          AND EXISTS (SELECT 1 FROM institution.course c
                      WHERE c.id = p_course AND c.institution_id = v_actor_institution))
    WHEN 'institution' THEN institution.actor_has_role('admin')
    WHEN 'network_security' THEN EXISTS (
      SELECT 1 FROM identity.network_engineer_appointment n
       WHERE n.user_id = v_user AND n.institution_id = v_actor_institution AND n.revoked_at IS NULL)
    ELSE false
  END;
  IF NOT coalesce(v_allowed, false) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD403';
  END IF;
  v_institution := CASE WHEN p_level IN ('personal', 'course', 'institution') THEN v_actor_institution END;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('settings.value:' || p_key, 0));

  -- Removing is always allowed; setting must stay inside every higher bound.
  IF (p_value IS NOT NULL OR p_bound IS NOT NULL) AND EXISTS (
    SELECT 1 FROM settings.value h
     WHERE h.key = p_key AND h.bound IS NOT NULL
       AND ((h.level IN ('system', 'network_security') AND p_level IN ('personal', 'course', 'institution'))
            OR (h.level = 'institution' AND p_level IN ('personal', 'course') AND h.institution_id = v_institution))
       AND NOT (settings.fits(p_value, h.bound) AND settings.bound_within(p_bound, h.bound))) THEN
    RAISE EXCEPTION 'crosses a higher bound' USING ERRCODE = 'ZD409';
  END IF;

  SELECT * INTO v_old FROM settings.value v
   WHERE v.level = p_level AND v.key = p_key
     AND v.user_id IS NOT DISTINCT FROM CASE WHEN p_level = 'personal' THEN v_user END
     AND v.course_id IS NOT DISTINCT FROM p_course
     AND v.institution_id IS NOT DISTINCT FROM v_institution
     FOR UPDATE;
  IF v_old.value IS NOT DISTINCT FROM p_value AND v_old.bound IS NOT DISTINCT FROM p_bound THEN
    RETURN NULL;
  END IF;

  IF p_value IS NULL AND p_bound IS NULL THEN
    DELETE FROM settings.value v WHERE v.id = v_old.id;
  ELSIF v_old.id IS NULL THEN
    INSERT INTO settings.value (level, institution_id, user_id, course_id, key, value, bound)
    VALUES (p_level, v_institution, CASE WHEN p_level = 'personal' THEN v_user END, p_course, p_key, p_value, p_bound);
  ELSE
    UPDATE settings.value v SET value = p_value, bound = p_bound, updated_at = pg_catalog.statement_timestamp()
     WHERE v.id = v_old.id;
  END IF;
  INSERT INTO settings.change (level, institution_id, user_id, course_id, key, old_value, new_value,
                               old_bound, new_bound, cause, changed_by, changed_by_institution)
  VALUES (p_level, v_institution, CASE WHEN p_level = 'personal' THEN v_user END, p_course, p_key,
          v_old.value, p_value, v_old.bound, p_bound, 'set', v_user, v_actor_institution)
  RETURNING id INTO v_change;

  -- A new or narrower bound deletes the lower rows in its scope that break it.
  IF p_bound IS NOT NULL THEN
    FOR v_low IN
      DELETE FROM settings.value l
       WHERE l.key = p_key
         AND ((p_level IN ('system', 'network_security') AND l.level IN ('personal', 'course', 'institution'))
              OR (p_level = 'institution' AND l.level IN ('personal', 'course') AND l.institution_id = v_institution))
         AND NOT (settings.fits(l.value, p_bound) AND settings.bound_within(l.bound, p_bound))
      RETURNING l.*
    LOOP
      INSERT INTO settings.change (level, institution_id, user_id, course_id, key, old_value, old_bound,
                                   cause, changed_by, changed_by_institution)
      VALUES (v_low.level, v_low.institution_id, v_low.user_id, v_low.course_id, v_low.key, v_low.value,
              v_low.bound, 'bound', v_user, v_actor_institution);
    END LOOP;
  END IF;
  RETURN v_change;
END
$$;

REVOKE ALL ON FUNCTION settings.is_bound(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION settings.fits(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION settings.bound_within(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION settings.refuse_change_rewrite() FROM PUBLIC;
REVOKE ALL ON FUNCTION settings.set_value(text, uuid, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settings.set_value(text, uuid, text, jsonb, jsonb) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA settings FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
DROP SCHEMA settings CASCADE;
