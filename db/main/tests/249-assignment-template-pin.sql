-- SRV-V17-TEMPLATE-ASSIGN: the work template of the institution frozen on an assignment.
-- Personas of institution.inc, all invented: Iva administers fak-a; Vesna teaches K1 (Z1) and
-- Marko K2 (Z2), both essay assignments; Ana and Dora are students in K1; Boris is in no course;
-- Lea administers fak-b, Petra teaches K3 (Z3) and Tomo is a student there.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid = 'institution.assignment_template_pin'::regclass;
SELECT ok(NOT has_table_privilege(r, 'institution.assignment_template_pin', 'SELECT,INSERT,UPDATE,DELETE'), r || ' has only RPC access to the pin')
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS t(r);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.set_assignment_template(uuid,boolean)', 'app.read_assignment_template(uuid)']) AS f;
SELECT ok(NOT has_function_privilege(r, 'institution.reject_assignment_template_pin_update()', 'EXECUTE'), r || ' cannot call the pin trigger function')
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS x(r);

CREATE FUNCTION pg_temp.setpin(p_actor text, p_assignment text, p_use text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.set_assignment_template(%s, %s)::text', p_assignment, p_use))
$$;
CREATE FUNCTION pg_temp.readpin(p_actor text, p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(version || %L || title_page::text || %L || jsonb_array_length(sections) || %L || citation_style, %L), %L) FROM app.read_assignment_template(%s)',
    ':', ':', ':', ',', 'none', p_assignment))
$$;
CREATE FUNCTION pg_temp.publish(p_actor text, p_type text, p_expected int, p_page text, p_sections text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.publish_work_template(%L, %s, %L::jsonb, %L::jsonb, %L)::text',
    p_type, p_expected, p_page, p_sections, 'fpzg'))
$$;
CREATE FUNCTION pg_temp.z(p_name text) RETURNS text
LANGUAGE sql AS $$ SELECT quote_literal(pg_temp.id(p_name)::text) || '::uuid' $$;

-- Nothing is pinned, and with no template the teacher's switch is a conflict.
SELECT is(pg_temp.readpin('ana', pg_temp.z('z1')), 'none', 'no pin at first');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'true'), 'ZD409: conflict', 'no template of the institution yet');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'false'), '0', 'switching off with no pin is fine');

-- Who may switch: only the teacher of the assignment's course.
SELECT is(pg_temp.publish('iva', 'essay', 0, '["title","author"]', '[{"title":"Uvod","hint":"Pitanje rada."},{"title":"Zaključak","hint":""}]'), '1', 'Iva publishes version 1 of the essay template');
SELECT is(pg_temp.setpin('anon', pg_temp.z('z1'), 'true'), 'ZD401: not authenticated', 'switching needs a session');
SELECT is(pg_temp.setpin(a, pg_temp.z('z1'), 'true'), 'ZD403: forbidden', a || ' cannot switch the template of Z1')
  FROM (VALUES ('ana'), ('dora'), ('boris'), ('iva'), ('marko'), ('nina'), ('petra'), ('lea'), ('tomo')) AS t(a);
SELECT is(pg_temp.setpin('vesna', quote_literal('00000000-0000-4000-8000-00000000dead') || '::uuid', 'true'), 'ZD403: forbidden', 'an assignment that does not exist is refused like a foreign one');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z3'), 'true'), 'ZD403: forbidden', 'and so is one of another institution');
SELECT is(pg_temp.setpin('vesna', 'NULL', 'true'), 'ZD422: invalid input', 'the assignment is not null');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'NULL'), 'ZD422: invalid input', 'the switch is not null');
SELECT is((SELECT count(*)::int FROM institution.assignment_template_pin), 0, 'nothing was pinned by the refusals');

-- The teacher switches on: the latest version is frozen.
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'true'), '1', 'Vesna pins version 1 on Z1');
SELECT is(pg_temp.readpin('ana', pg_temp.z('z1')), '1:["title", "author"]:2:fpzg', 'Ana reads the skeleton');
SELECT is(pg_temp.readpin('dora', pg_temp.z('z1')), '1:["title", "author"]:2:fpzg', 'and so does Dora');

-- A later version changes nothing for the frozen assignment, and a second switch keeps the pin.
SELECT is(pg_temp.publish('iva', 'essay', 1, '["title"]', '[{"title":"Drugi","hint":""}]'), '2', 'Iva publishes version 2');
SELECT is(pg_temp.readpin('ana', pg_temp.z('z1')), '1:["title", "author"]:2:fpzg', 'Z1 still shows version 1');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'true'), '1', 'switching on again keeps version 1');
SELECT is(pg_temp.setpin('marko', pg_temp.z('z2'), 'true'), '2', 'Z2 pinned now freezes version 2');
SELECT is(pg_temp.readpin('vesna', pg_temp.z('z2')), 'ZD403: forbidden', 'a teacher does not read through the student route');

-- Who may read: only a student of the course.
SELECT is(pg_temp.readpin('anon', pg_temp.z('z1')), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.readpin(a, pg_temp.z('z1')), 'ZD403: forbidden', a || ' cannot read the template of Z1')
  FROM (VALUES ('boris'), ('vesna'), ('marko'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS t(a);
SELECT is(pg_temp.readpin('ana', pg_temp.z('z2')), 'ZD403: forbidden', 'Ana is not a student of K2');
SELECT is(pg_temp.readpin('ana', pg_temp.z('z3')), 'ZD403: forbidden', 'nor of another institution''s course');
SELECT is(pg_temp.readpin('ana', quote_literal('00000000-0000-4000-8000-00000000dead') || '::uuid'), 'ZD403: forbidden', 'a missing assignment is refused the same way');
SELECT is(pg_temp.readpin('ana', 'NULL'), 'ZD422: invalid input', 'the assignment is not null');
SELECT is(pg_temp.readpin('tomo', pg_temp.z('z3')), 'none', 'an assignment without a pin has no template for its own student');

-- A switch off by someone else changes nothing; the teacher's removes the pin.
SELECT is(pg_temp.setpin('marko', pg_temp.z('z1'), 'false'), 'ZD403: forbidden', 'another teacher cannot switch it off');
SELECT is(pg_temp.setpin('ana', pg_temp.z('z1'), 'false'), 'ZD403: forbidden', 'a student cannot either');
SELECT is(pg_temp.readpin('ana', pg_temp.z('z1')), '1:["title", "author"]:2:fpzg', 'the pin is still there');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'false'), '0', 'Vesna switches it off');
SELECT is(pg_temp.readpin('ana', pg_temp.z('z1')), 'none', 'Ana reads nothing');
SELECT is(pg_temp.setpin('vesna', pg_temp.z('z1'), 'true'), '2', 'switching on after an off takes the latest version');

-- The institution's chain is untouched, and nobody but the functions touches the pins.
SELECT is((SELECT count(*)::int FROM institution.work_template_version), 2, 'both template versions remain');
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', 'UPDATE institution.assignment_template_pin SET template_version = 1'),
  'ZD409: assignment template pin is frozen', 'a pin cannot be updated');
SELECT ok(NOT has_table_privilege('ductus_app', 'institution.assignment_template_pin', 'TRUNCATE'), 'the app role cannot truncate the pins');
SELECT is(pg_temp.ask_as('ductus_app', 'ana', 'SELECT count(*)::text FROM institution.assignment_template_pin'),
  '42501: permission denied for table assignment_template_pin', 'the app role cannot read the table');
SELECT is(pg_temp.ask_as('ductus_app', 'vesna', 'DELETE FROM institution.assignment_template_pin'),
  '42501: permission denied for table assignment_template_pin', 'nor delete from it');

SELECT * FROM finish();
ROLLBACK;
