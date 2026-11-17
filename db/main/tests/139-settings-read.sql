-- DAN-826-3 (S-1J-g; contract on Ductus#1836, comment 6936739450):
-- settings.read_values returns exactly the rows of one level in the caller's
-- scope. A row of another person, course or institution, or of a level the
-- caller may not write, never appears; another's level or course and a course
-- that does not exist are the same ZD403. The levels the caller reads are
-- exactly those settings.set_value lets the caller write. Personas of
-- institution.inc, plus Boris as network engineer of fak-a, Dora with a
-- revoked appointment and Nina with one that starts tomorrow; every person
-- and value is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by, appointed_at, revoked_at)
VALUES (pg_temp.id('fak_a'), pg_temp.id('boris'), pg_temp.id('iva'), now() - interval '1 day', NULL),
       (pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('iva'), now() - interval '2 days', now() - interval '1 day'),
       (pg_temp.id('fak_a'), pg_temp.id('nina'), pg_temp.id('iva'), now() + interval '1 day', NULL);

-- One row in every scope, each with its own value, written as the owner.
INSERT INTO settings.value (level, institution_id, user_id, course_id, key, value, bound)
VALUES ('personal', pg_temp.id('fak_a'), pg_temp.id('ana'), NULL, 'ui.size', '11', NULL),
       ('personal', pg_temp.id('fak_a'), pg_temp.id('vesna'), NULL, 'ui.size', '12', NULL),
       ('personal', pg_temp.id('fak_b'), pg_temp.id('tomo'), NULL, 'ui.size', '13', NULL),
       ('course', pg_temp.id('fak_a'), NULL, pg_temp.id('k1'), 'ui.size', '21', NULL),
       ('course', pg_temp.id('fak_a'), NULL, pg_temp.id('k2'), 'ui.size', '22', NULL),
       ('course', pg_temp.id('fak_b'), NULL, pg_temp.id('k3'), 'ui.size', '23', NULL),
       ('institution', pg_temp.id('fak_a'), NULL, NULL, 'ui.size', '31', '{"min": 10, "max": 40}'),
       ('institution', pg_temp.id('fak_b'), NULL, NULL, 'ui.size', '32', NULL),
       ('system', NULL, NULL, NULL, 'ui.size', '41', NULL),
       ('network_security', NULL, NULL, NULL, 'network.idle', '51', NULL);

-- read_values as p_actor: the rows as "key=value[ bound]", in order; '' for
-- none; else the SQLSTATE alone.
CREATE FUNCTION pg_temp.read(p_actor text, p_level text, p_course text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN left(r, 5) ELSE coalesce(r, '') END
  FROM pg_temp.ask(p_actor, format(
    $q$SELECT string_agg(key || '=' || value::text || coalesce(' ' || bound::text, '')
                         || CASE WHEN updated_at IS NULL THEN ' no-time' ELSE '' END, ', ' ORDER BY key)
       FROM settings.read_values(%s, %s)$q$,
    coalesce(quote_literal(p_level), 'NULL'), coalesce('{' || p_course || '}::uuid', 'NULL'))) AS r
$$;

-- 1. Every persona and level: exactly the expected rows, or the refusal.
SELECT is(pg_temp.read(c.actor, c.level, c.course), c.expected,
          format('%s reads %s%s: %s', c.actor, c.level, coalesce(' ' || c.course, ''), c.expected))
FROM (VALUES
  ('ana', 'personal', NULL, 'ui.size=11'),
  ('vesna', 'personal', NULL, 'ui.size=12'),
  ('tomo', 'personal', NULL, 'ui.size=13'),
  ('iva', 'personal', NULL, ''),
  ('vesna', 'course', 'k1', 'ui.size=21'),
  ('marko', 'course', 'k2', 'ui.size=22'),
  ('petra', 'course', 'k3', 'ui.size=23'),
  ('iva', 'course', 'k1', 'ui.size=21'),
  ('iva', 'course', 'k2', 'ui.size=22'),
  ('lea', 'course', 'k3', 'ui.size=23'),
  ('vesna', 'course', 'k2', 'ZD403'),
  ('vesna', 'course', 'k3', 'ZD403'),
  ('iva', 'course', 'k3', 'ZD403'),
  ('lea', 'course', 'k1', 'ZD403'),
  ('ana', 'course', 'k1', 'ZD403'),
  ('tomo', 'course', 'k3', 'ZD403'),
  ('nina', 'course', 'k1', 'ZD403'),
  ('vesna', 'course', 'nobody', 'ZD403'),
  ('iva', 'course', 'nobody', 'ZD403'),
  ('iva', 'institution', NULL, 'ui.size=31 {"max": 40, "min": 10}'),
  ('lea', 'institution', NULL, 'ui.size=32'),
  ('ana', 'institution', NULL, 'ZD403'),
  ('vesna', 'institution', NULL, 'ZD403'),
  ('boris', 'institution', NULL, 'ZD403'),
  ('boris', 'network_security', NULL, 'network.idle=51'),
  ('dora', 'network_security', NULL, 'ZD403'),
  ('nina', 'network_security', NULL, 'ZD403'),
  ('ana', 'network_security', NULL, 'ZD403'),
  ('vesna', 'network_security', NULL, 'ZD403'),
  ('iva', 'network_security', NULL, 'ZD403'),
  ('iva', 'system', NULL, 'ZD403'),
  ('boris', 'system', NULL, 'ZD403'),
  ('ana', 'system', NULL, 'ZD403')
) AS c (actor, level, course, expected);

-- 2. No session, and the wrong shape.
SELECT is(pg_temp.read(c.actor, c.level, c.course), c.expected,
          format('%s, %s%s: %s', c.actor, coalesce(c.level, 'NULL'), coalesce(' ' || c.course, ''), c.expected))
FROM (VALUES
  ('anon', 'personal', NULL, 'ZD401'),
  ('unknown', 'personal', NULL, 'ZD401'),
  ('closed', 'personal', NULL, 'ZD401'),
  ('expired', 'personal', NULL, 'ZD401'),
  ('ana', 'Personal', NULL, 'ZD422'),
  ('ana', ' personal', NULL, 'ZD422'),
  ('ana', 'personal ', NULL, 'ZD422'),
  ('ana', NULL, NULL, 'ZD422'),
  ('ana', 'admin', NULL, 'ZD422'),
  ('ana', 'personal', 'k1', 'ZD422'),
  ('vesna', 'course', NULL, 'ZD422'),
  ('iva', 'institution', 'k1', 'ZD422')
) AS c (actor, level, course, expected);

-- 3. The levels read_values refuses are exactly the levels set_value
-- refuses, for every persona and target of the fixture. The writes this
-- makes come after section 1 and use a key no read above names.
CREATE TEMP TABLE outcome AS
SELECT p.name AS actor, t.level, t.course,
       pg_temp.read(p.name, t.level, t.course) = 'ZD403' AS read_refused,
       left(pg_temp.ask(p.name, format('SELECT settings.set_value(%L, %s, ''network.eq_check'', ''1''::jsonb)::text',
                                       t.level, coalesce('{' || t.course || '}::uuid', 'NULL'))), 5) = 'ZD403' AS write_refused
FROM person p
CROSS JOIN (VALUES ('personal', NULL), ('course', 'k1'), ('course', 'k2'), ('course', 'k3'), ('course', 'nobody'),
                   ('institution', NULL), ('system', NULL), ('network_security', NULL)) AS t (level, course);
SELECT is((SELECT count(*)::integer FROM outcome), 80, 'ten personas by eight targets');
SELECT ok((SELECT bool_or(read_refused) AND bool_or(NOT read_refused) FROM outcome),
  'control: some targets are refused and some are not');
SELECT is_empty(
  $$ SELECT actor || ' ' || level || coalesce(' ' || course, '') FROM outcome WHERE read_refused <> write_refused $$,
  'read_values refuses exactly where set_value refuses');

-- 4. Rights and form.
SELECT bag_eq(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\_%'
                            UNION ALL SELECT 'public') AS r
     WHERE r.rolname <> 'ductus_identity'
       AND has_function_privilege(r.rolname, 'settings.read_values(text,uuid)'::regprocedure, 'EXECUTE') $$,
  ARRAY['ductus_app', 'ductus_app_local'],
  'only the web process calls read_values');
SELECT ok(
  (SELECT p.prosecdef AND p.provolatile = 's' AND p.proowner = 'ductus_identity'::regrole
          AND p.proconfig = ARRAY['search_path=""']
   FROM pg_proc p WHERE p.oid = 'settings.read_values(text,uuid)'::regprocedure),
  'read_values is a STABLE SECURITY DEFINER of ductus_identity with an empty search_path');
SELECT doesnt_imatch((SELECT prosrc FROM pg_proc WHERE oid = 'settings.read_values(text,uuid)'::regprocedure),
  '\mEXECUTE\M', 'read_values runs no dynamic SQL');
SELECT ok(NOT has_table_privilege('ductus_app', 'settings.value', 'SELECT'),
  'ductus_app still has no SELECT on settings.value');
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM settings.value'), '42501: permission denied for table value',
  'and a direct read of the table is refused');

SELECT * FROM finish();
ROLLBACK;
