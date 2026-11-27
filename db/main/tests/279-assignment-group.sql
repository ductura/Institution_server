-- F4 wave 2 #5, task 1.8: the groups of an assignment
-- (institution.assignment_group, add_assignment_groups, assignment_groups).
-- Personas of institution.inc; the group names are invented. Vesna teaches K1
-- (assignment z1), Marko K2 (z2), Petra K3 (z3) at the other faculty.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- The number of new links, or "SQLSTATE: ...".
CREATE FUNCTION pg_temp.link(p_actor text, p_args text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask(p_actor, 'SELECT institution.add_assignment_groups(' || p_args || ')::text') $$;
-- The linked groups by name, or "SQLSTATE: ...".
CREATE FUNCTION pg_temp.linked(p_actor text, p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(string_agg(g.name, ' ' ORDER BY g.name), '-') FROM institution.assignment_groups({%s}) g $q$,
    p_assignment))
$$;

INSERT INTO ref VALUES ('ga', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa A') $$));
INSERT INTO ref VALUES ('gb', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa B') $$));
INSERT INTO ref VALUES ('gc', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa C') $$));
INSERT INTO ref VALUES ('gk2', pg_temp.ask('marko', $$ SELECT institution.create_seminar_group({k2}, 'Grupa A') $$));
INSERT INTO ref VALUES ('gk3', pg_temp.ask('petra', $$ SELECT institution.create_seminar_group({k3}, 'Grupa A') $$));
SELECT is((SELECT count(*)::integer FROM ref WHERE name IN ('ga', 'gb', 'gc', 'gk2', 'gk3') AND val ~ '^[0-9a-f-]{36}$'), 5,
  'setup: three groups of K1, one of K2, one of K3');

-- 1. The table: RLS on and forced, the owner's policy only, nothing for the
-- web role, the worker or the migrator.
SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
             FROM pg_class c WHERE c.oid = 'institution.assignment_group'::regclass),
  'assignment_group has ENABLE and FORCE ROW LEVEL SECURITY and belongs to ductus_identity');
SELECT is((SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || array_to_string(p.roles, ','), '; ')
             FROM pg_policies p WHERE p.schemaname = 'institution' AND p.tablename = 'assignment_group'),
  'assignment_group_owner ALL ductus_identity', 'the only policy is the owner''s');
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || x.p FROM pg_roles r
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS x (p)
      WHERE r.rolname LIKE 'ductus\_%' AND r.rolname <> 'ductus_identity' AND NOT r.rolcanlogin
        AND has_table_privilege(r.rolname, 'institution.assignment_group', x.p) $$,
  'no group role but the owner holds a privilege on assignment_group');
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM institution.assignment_group'),
  '42501: permission denied for table assignment_group', 'the web role cannot read the table');
SELECT is(pg_temp.ask('vesna', $$ INSERT INTO institution.assignment_group (assignment_id, group_id, course_id,
    institution_id, assigned_by) VALUES ({z1}, {ga}, {k1}, {fak_a}, {vesna}) RETURNING 'ok' $$),
  '42501: permission denied for table assignment_group', 'the web role cannot write the table');
SELECT is((SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname)
             FROM pg_proc p
            WHERE p.pronamespace = 'institution'::regnamespace
              AND p.proname IN ('add_assignment_groups', 'assignment_groups', 'check_assignment_group_course')
              AND has_function_privilege('public', p.oid, 'EXECUTE')),
  NULL, 'PUBLIC executes none of the three functions');

-- 2. The teacher of the course links groups of that course.
SELECT is(pg_temp.link('vesna', '{z1}, ARRAY[{ga}, {gb}]::uuid[]'), '2', 'Vesna links groups A and B to z1');
SELECT is(pg_temp.linked('vesna', 'z1'), 'Grupa A Grupa B', 'Vesna reads groups A and B of z1');
SELECT is((SELECT string_agg(l.assigned_by::text || ' ' || l.course_id::text || ' ' || l.institution_id::text, ', ')
             FROM institution.assignment_group l WHERE l.assignment_id = pg_temp.id('z1') AND l.group_id = pg_temp.id('ga')),
  pg_temp.id('vesna')::text || ' ' || pg_temp.id('k1')::text || ' ' || pg_temp.id('fak_a')::text,
  'the row carries the caller, the course and the institution of the session');
SELECT is(pg_temp.link('vesna', '{z1}, ARRAY[{ga}, {gb}]::uuid[]'), '0', 'the same call again adds no link');
SELECT is(pg_temp.link('vesna', '{z1}, ARRAY[{gb}, {gc}]::uuid[]'), '1', 'a call with one new group adds only that one');
SELECT is((SELECT count(*)::integer FROM institution.assignment_group WHERE assignment_id = pg_temp.id('z1')), 3,
  'z1 has three links, one row per group');
SELECT is(pg_temp.link('vesna', '{z1}, ''{}''::uuid[]'), '0', 'an empty list adds nothing');
SELECT is(pg_temp.linked('marko', 'z2'), '-', 'Marko reads no group of his z2, which has none');
SELECT is(pg_temp.linked('vesna', 'z2'), 'ZD403: forbidden', 'Vesna does not read the groups of z2 of K2');

-- 3. Wrong input is ZD422, and changes nothing.
CREATE TEMP TABLE bad (args text, what text);
INSERT INTO bad VALUES
  ('{z1}, ARRAY[{gk2}]::uuid[]', 'a group of another course of the same faculty'),
  ('{z1}, ARRAY[{gk3}]::uuid[]', 'a group of another faculty'),
  ('{z1}, ARRAY[{gc}, {gk2}]::uuid[]', 'a list with one group of another course'),
  ('{z1}, ARRAY[{nobody}]::uuid[]', 'an id that is no group'),
  ('{z1}, ARRAY[{ga}, {ga}]::uuid[]', 'the same group twice in the list'),
  ('{z1}, ARRAY[{ga}, NULL]::uuid[]', 'a null in the list'),
  ('{z1}, NULL::uuid[]', 'a null list'),
  ('{z1}, ARRAY[ARRAY[{ga}], ARRAY[{gb}]]::uuid[]', 'a list of two dimensions');
SELECT is(pg_temp.link('vesna', b.args), 'ZD422: invalid input', 'ZD422 for ' || b.what) FROM bad b;
SELECT is((SELECT count(*)::integer FROM institution.assignment_group), 3, 'none of them added a link');
SELECT ok(position((SELECT val FROM ref WHERE name = 'gk2') IN pg_temp.link('vesna', '{z1}, ARRAY[{gk2}]::uuid[]')) = 0,
  'the error does not name the group it refused');

-- 4. Nobody but a teacher of the assignment's course: the same answer for an
-- assignment that does not exist. ZD401 without a session.
CREATE TEMP TABLE who (actor text, what text);
INSERT INTO who VALUES
  ('marko', 'a teacher of another course'), ('ana', 'a student of K1'), ('boris', 'a student in no course'),
  ('iva', 'the administrator of the faculty'), ('nina', 'an unconfirmed teacher'),
  ('petra', 'a teacher of another faculty'), ('lea', 'the administrator of another faculty');
SELECT is(pg_temp.link(w.actor, '{z1}, ARRAY[{gc}]::uuid[]'), 'ZD403: forbidden', w.what || ' cannot link a group of z1')
  FROM who w;
SELECT is(pg_temp.linked(w.actor, 'z1'), 'ZD403: forbidden', w.what || ' cannot read the groups of z1') FROM who w;
SELECT is(pg_temp.link('vesna', '{nobody}, ARRAY[{ga}]::uuid[]'), 'ZD403: forbidden', 'an unknown assignment is ZD403');
SELECT is(pg_temp.linked('vesna', 'nobody'), 'ZD403: forbidden', 'and reads as ZD403');
SELECT is(pg_temp.link('marko', '{z2}, ARRAY[{ga}]::uuid[]'), 'ZD422: invalid input',
  'Marko cannot link a K1 group to his own z2');
SELECT is(pg_temp.link('petra', '{z3}, ARRAY[{gk3}]::uuid[]'), '1', 'Petra links her own group at the other faculty');
SELECT is(pg_temp.linked('petra', 'z3'), 'Grupa A', 'and reads only it');
SELECT is(pg_temp.link('anon', '{z1}, ARRAY[{ga}]::uuid[]'), 'ZD401: not authenticated', 'no session is ZD401');
SELECT is(left(pg_temp.linked('expired', 'z1'), 5), 'ZD401', 'an expired session is ZD401');

-- 5. The table holds what the functions promise, whoever writes: the owner
-- cannot link a group of another course nor the same group twice.
SELECT is(pg_temp.ask_as('ductus_identity', 'vesna', $$ INSERT INTO institution.assignment_group (assignment_id, group_id,
    course_id, institution_id, assigned_by) VALUES ({z1}, {gk2}, {k2}, {fak_a}, {vesna}) RETURNING 'ok' $$),
  'ZD422: invalid input', 'the owner cannot link a K2 group to z1 of K1');
SELECT is(left(pg_temp.ask_as('ductus_identity', 'vesna', $$ INSERT INTO institution.assignment_group (assignment_id, group_id,
    course_id, institution_id, assigned_by) VALUES ({z1}, {gk2}, {k1}, {fak_a}, {vesna}) RETURNING 'ok' $$), 5),
  '23503', 'nor name K1 for a group of K2');
SELECT is(left(pg_temp.ask_as('ductus_identity', 'vesna', $$ INSERT INTO institution.assignment_group (assignment_id, group_id,
    course_id, institution_id, assigned_by) VALUES ({z1}, {ga}, {k1}, {fak_a}, {vesna}) RETURNING 'ok' $$), 5),
  '23505', 'the same assignment and group twice is refused by the key');
SELECT is(pg_temp.ask_as('ductus_identity', 'vesna', $$ UPDATE institution.assignment_group SET assignment_id = {z2}
    WHERE assignment_id = {z1} AND group_id = {ga} RETURNING 'ok' $$),
  'ZD422: invalid input', 'nor moved to an assignment of another course');

-- 6. Deleting: a linked assignment or group stays, as for every other
-- reference to them (NO ACTION, no cascade).
SELECT is((SELECT string_agg(c.conname || ' ' || c.confdeltype || c.confupdtype, ', ' ORDER BY c.conname)
             FROM pg_constraint c WHERE c.conrelid = 'institution.assignment_group'::regclass AND c.contype = 'f'),
  'assignment_group_assigned_by_fkey aa, assignment_group_assignment_fkey aa, assignment_group_group_fkey aa',
  'every foreign key of the link is NO ACTION');
SELECT ok(pg_temp.ask_as('ductus_identity', 'vesna', $$ DELETE FROM institution.seminar_group WHERE id = {gc} RETURNING 'ok' $$)
            LIKE '23503: %assignment_group%',
  'a linked group cannot be deleted');
SELECT ok(pg_temp.ask_as('ductus_identity', 'vesna', $$ DELETE FROM institution.assignment WHERE id = {z3} RETURNING 'ok' $$)
            LIKE '23503: %',
  'a linked assignment cannot be deleted');
SELECT is((SELECT count(*)::integer FROM institution.assignment_group), 4, 'every link is still there');

SELECT * FROM finish();
ROLLBACK;
