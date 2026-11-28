-- F4 wave 2 #5, task 1.8 (SRV#977 review): create_assignment_with_groups.
-- A replay of the key with another set of groups is ZD409 whichever way the
-- set differs, and writes nothing. Personas of institution.inc; the group
-- names and the content are invented. Vesna teaches K1, Marko K2.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- The id, or "SQLSTATE: ...".
CREATE FUNCTION pg_temp.create_with(p_actor text, p_key text, p_groups text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT institution.create_assignment_with_groups({k1}, %L::uuid,
      'Izmišljeni esej', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      'partially_allowed', '{}', 'basic', false, NULL, NULL, 1, false, false, false, %s)::text
  $q$, p_key, p_groups))
$$;
-- The linked groups by name, "-" for none.
CREATE FUNCTION pg_temp.names(p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(g.name, ' ' ORDER BY g.name), '-')
    FROM institution.assignment_group l JOIN institution.seminar_group g ON g.id = l.group_id
   WHERE l.assignment_id = p_assignment::uuid
$$;

INSERT INTO ref VALUES ('ga', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa A') $$));
INSERT INTO ref VALUES ('gb', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa B') $$));
INSERT INTO ref VALUES ('gk2', pg_temp.ask('marko', $$ SELECT institution.create_seminar_group({k2}, 'Grupa A') $$));
SELECT is((SELECT count(*)::integer FROM ref WHERE name IN ('ga', 'gb', 'gk2') AND val ~ '^[0-9a-f-]{36}$'), 3,
  'setup: two groups of K1, one of K2');

-- 1. A new key: the assignment and its links in one statement.
INSERT INTO ref SELECT 'za', pg_temp.create_with('vesna', '00000000-0000-4000-8000-00000000b801', 'ARRAY[{ga}]::uuid[]');
SELECT matches((SELECT val FROM ref WHERE name = 'za'), '^[0-9a-f-]{36}$', 'Vesna creates an assignment for group A');
SELECT is(pg_temp.names((SELECT val FROM ref WHERE name = 'za')), 'Grupa A', 'it is linked to group A');
INSERT INTO ref SELECT 'zw', pg_temp.create_with('vesna', '00000000-0000-4000-8000-00000000b802', '''{}''::uuid[]');
SELECT matches((SELECT val FROM ref WHERE name = 'zw'), '^[0-9a-f-]{36}$', 'Vesna creates an assignment for the whole course');
SELECT is(pg_temp.names((SELECT val FROM ref WHERE name = 'zw')), '-', 'it has no link');

-- 2. The same key with the same set is the same assignment, nothing new.
SELECT is(pg_temp.create_with('vesna', '00000000-0000-4000-8000-00000000b801', 'ARRAY[{ga}]::uuid[]'),
  (SELECT val FROM ref WHERE name = 'za'), 'the same key and group answer the same id');
SELECT is(pg_temp.create_with('vesna', '00000000-0000-4000-8000-00000000b802', '''{}''::uuid[]'),
  (SELECT val FROM ref WHERE name = 'zw'), 'the same key for the whole course answers the same id');

-- 3. The same key with another set is ZD409, and links nothing.
CREATE TEMP TABLE other (key text, groups text, what text);
INSERT INTO other VALUES
  ('00000000-0000-4000-8000-00000000b801', 'ARRAY[{ga}, {gb}]::uuid[]', 'more groups'),
  ('00000000-0000-4000-8000-00000000b801', 'ARRAY[{gb}]::uuid[]', 'another group'),
  ('00000000-0000-4000-8000-00000000b801', '''{}''::uuid[]', 'the whole course for a group'),
  ('00000000-0000-4000-8000-00000000b802', 'ARRAY[{ga}]::uuid[]', 'a group for the whole course'),
  ('00000000-0000-4000-8000-00000000b801', 'ARRAY[{gk2}]::uuid[]', 'a group of another course');
SELECT is(pg_temp.create_with('vesna', o.key, o.groups), 'ZD409: conflict', 'a replay with ' || o.what || ' is ZD409')
  FROM other o;
SELECT is(pg_temp.names((SELECT val FROM ref WHERE name = 'za')), 'Grupa A', 'the group assignment keeps group A only');
SELECT is(pg_temp.names((SELECT val FROM ref WHERE name = 'zw')), '-', 'the whole course assignment keeps no link');

-- 4. Wrong input on a new key is ZD422, and creates nothing.
CREATE TEMP TABLE bad (key text, groups text, what text);
INSERT INTO bad VALUES
  ('00000000-0000-4000-8000-00000000b803', 'ARRAY[{gk2}]::uuid[]', 'a group of another course'),
  ('00000000-0000-4000-8000-00000000b804', 'ARRAY[{ga}, {ga}]::uuid[]', 'the same group twice'),
  ('00000000-0000-4000-8000-00000000b805', 'ARRAY[{ga}, NULL]::uuid[]', 'a null in the list'),
  ('00000000-0000-4000-8000-00000000b806', 'NULL::uuid[]', 'a null list');
SELECT is(pg_temp.create_with('vesna', b.key, b.groups), 'ZD422: invalid input', 'ZD422 for ' || b.what) FROM bad b;
SELECT is((SELECT count(*)::integer FROM institution.assignment WHERE request_id IN (
           '00000000-0000-4000-8000-00000000b803', '00000000-0000-4000-8000-00000000b804',
           '00000000-0000-4000-8000-00000000b805', '00000000-0000-4000-8000-00000000b806')),
  0, 'a refused creation writes no assignment');

-- 5. Who may is who creates: a student of the course or a teacher of another
-- course is ZD403; no session is ZD401.
SELECT is(pg_temp.create_with('ana', '00000000-0000-4000-8000-00000000b807', 'ARRAY[{ga}]::uuid[]'),
  'ZD403: forbidden', 'a student of K1 cannot create');
SELECT is(pg_temp.create_with('marko', '00000000-0000-4000-8000-00000000b808', 'ARRAY[{ga}]::uuid[]'),
  'ZD403: forbidden', 'a teacher of K2 cannot create in K1');
SELECT is(pg_temp.create_with('anon', '00000000-0000-4000-8000-00000000b809', 'ARRAY[{ga}]::uuid[]'),
  'ZD401: not authenticated', 'no session is ZD401');
SELECT is((SELECT string_agg(p.oid::regprocedure::text, ', ')
             FROM pg_proc p
            WHERE p.pronamespace = 'institution'::regnamespace
              AND p.proname = 'create_assignment_with_groups'
              AND has_function_privilege('public', p.oid, 'EXECUTE')),
  NULL, 'PUBLIC does not execute the function');

SELECT * FROM finish();
ROLLBACK;
