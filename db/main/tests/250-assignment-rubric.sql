-- SRV-V17-RUBRIC-DEF (Ductus#2055, val 17): the rubric of an assignment (20261219240000).
-- Personas of institution.inc and mentorship.inc, all invented: Vesna teaches K1 (assignment z1)
-- whose students are Ana and Dora; Marko teaches K2 and mentors Ana's master thesis (zm1);
-- Petra teaches K3 of fak-b, Tomo studies there; Iva administers fak-a. The access matrix:
-- a teacher of the assignment reads and adds versions; a student of it reads; everyone else,
-- another institution and an unknown assignment read the same ZD404; no session is ZD401.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid = 'institution.assignment_rubric_version'::regclass;
SELECT ok(NOT has_table_privilege(r, 'institution.assignment_rubric_version', 'SELECT,INSERT,UPDATE,DELETE'),
  r || ' has only RPC access to the rubric')
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS t(r);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_assignment_rubric_teacher(uuid)', 'app.read_assignment_rubric_student(uuid)',
    'app.publish_assignment_rubric(uuid,integer,jsonb)']) AS f;
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['institution.is_rubric_criteria(jsonb)', 'institution.assignment_rubric_role(uuid)',
    'institution.is_rubric_text(jsonb,integer,integer,boolean)']) AS f;

CREATE FUNCTION pg_temp.crit(p_id text, p_title text DEFAULT 'Izmišljena tema') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'levels', jsonb_build_array(
    jsonb_build_object('label', 'Treba doraditi', 'descriptor', 'Izmišljeni opis niže razine.'),
    jsonb_build_object('label', 'Dobro', 'descriptor', ''),
    jsonb_build_object('label', 'Vrlo dobro', 'descriptor', E'Prvi redak.\nDrugi redak.')))
$$;
CREATE FUNCTION pg_temp.rt(p_actor text, p_assignment text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(version || %L || (SELECT string_agg(c ->> %L, %L) FROM jsonb_array_elements(criteria) c), %L), %L) FROM app.read_assignment_rubric_teacher(%L::uuid)',
    ':', 'id', ',', ';', 'none', coalesce(pg_temp.id(p_assignment)::text, p_assignment)))
$$;
CREATE FUNCTION pg_temp.rs(p_actor text, p_assignment text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(version || %L || (SELECT string_agg(c ->> %L, %L) FROM jsonb_array_elements(criteria) c), %L), %L) FROM app.read_assignment_rubric_student(%L::uuid)',
    ':', 'id', ',', ';', 'none', coalesce(pg_temp.id(p_assignment)::text, p_assignment)))
$$;
CREATE FUNCTION pg_temp.pub(p_actor text, p_assignment text, p_expected int, p_list text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT version::text FROM app.publish_assignment_rubric(%L::uuid, %s, %L::jsonb)',
    coalesce(pg_temp.id(p_assignment)::text, p_assignment), p_expected, p_list))
$$;

-- Nothing before the teacher sets one.
SELECT is(pg_temp.rt('vesna', 'z1'), 'none', 'a teacher reads no rubric at first');
SELECT is(pg_temp.rs('ana', 'z1'), 'none', 'a student reads no stored rubric at first (the server adds the defaults)');

-- No session; no part; another institution; unknown.
SELECT is(pg_temp.rt('anon', 'z1'), 'ZD401: not authenticated', 'reading as a teacher needs a session');
SELECT is(pg_temp.rs('anon', 'z1'), 'ZD401: not authenticated', 'reading as a student needs a session');
SELECT is(pg_temp.pub('anon', 'z1', 0, jsonb_build_array(pg_temp.crit('a'))::text), 'ZD401: not authenticated', 'publishing needs a session');
SELECT is(pg_temp.rt(a, 'z1'), 'ZD404: not found', a || ' is no teacher of z1 and reads the same 404')
  FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('nina')) AS t(a);
SELECT is(pg_temp.rs(a, 'z1'), 'ZD404: not found', a || ' is no student of z1 and reads the same 404')
  FROM (VALUES ('vesna'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris')) AS t(a);
SELECT is(pg_temp.pub(a, 'z1', 0, jsonb_build_array(pg_temp.crit('a'))::text), 'ZD404: not found', a || ' cannot publish for z1')
  FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('nina')) AS t(a);
SELECT is(pg_temp.rt('vesna', '00000000-0000-4000-8000-00000000dead'), 'ZD404: not found', 'an unknown assignment is the same 404');
SELECT is(pg_temp.pub('vesna', '00000000-0000-4000-8000-00000000dead', 0, jsonb_build_array(pg_temp.crit('a'))::text), 'ZD404: not found', 'and publishing to it');
-- An unknown assignment is told before the input is judged: a stranger learns nothing of the rules.
SELECT is(pg_temp.pub('ana', 'z1', 0, '[]'), 'ZD404: not found', 'a student gets 404 even for invalid input');

-- Invalid input.
SELECT is(pg_temp.pub('vesna', 'z1', 0, l), 'ZD422: invalid input', what)
  FROM (VALUES
    ('{}', 'an object is not a list'),
    ('[]', 'no criterion'),
    ((SELECT jsonb_agg(pg_temp.crit('c' || n))::text FROM generate_series(1, 13) n), 'more than 12 criteria'),
    (jsonb_build_array(pg_temp.crit('a'), pg_temp.crit('a'))::text, 'a repeated id'),
    (jsonb_build_array(pg_temp.crit('A'))::text, 'an id with a capital'),
    (jsonb_build_array(pg_temp.crit(''))::text, 'an empty id'),
    (jsonb_build_array(pg_temp.crit(repeat('a', 33)))::text, 'an id over 32 characters'),
    (jsonb_build_array(pg_temp.crit('a', '  '))::text, 'a blank title'),
    (jsonb_build_array(pg_temp.crit('a', repeat('x', 121)))::text, 'a title over 120 characters'),
    (jsonb_build_array(pg_temp.crit('a') || '{"extra":1}')::text, 'an unknown key'),
    (jsonb_build_array(pg_temp.crit('a') - 'title')::text, 'a missing title'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels}', (pg_temp.crit('a') -> 'levels') - 2))::text, 'two levels'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels}', (pg_temp.crit('a') -> 'levels') || (pg_temp.crit('a') -> 'levels' -> 0)))::text, 'four levels'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels,0,label}', '""'))::text, 'an empty level label'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels,0,label}', to_jsonb(repeat('x', 81))))::text, 'a level label over 80 characters'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels,0,descriptor}', to_jsonb(repeat('x', 401))))::text, 'a descriptor over 400 characters'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels,0,points}', '3'))::text, 'a number on a level'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels,0,descriptor}', '5'))::text, 'a descriptor that is not text'),
    (jsonb_build_array(jsonb_set(pg_temp.crit('a'), '{levels,0,label}', to_jsonb(E'a\tb'::text)))::text, 'a control character in a label'),
    ('["a"]', 'a criterion that is not an object')
  ) AS t(l, what);
SELECT is(pg_temp.ask('vesna', format('SELECT version::text FROM app.publish_assignment_rubric(%L::uuid, -1, %L::jsonb)', pg_temp.id('z1'), jsonb_build_array(pg_temp.crit('a')))), 'ZD422: invalid input', 'the expected version is not negative');
SELECT is(pg_temp.ask('vesna', format('SELECT version::text FROM app.publish_assignment_rubric(%L::uuid, NULL, %L::jsonb)', pg_temp.id('z1'), jsonb_build_array(pg_temp.crit('a')))), 'ZD422: invalid input', 'the expected version is not null');
SELECT is((SELECT count(*)::int FROM institution.assignment_rubric_version), 0, 'nothing invalid was stored');

-- Publish, read, replace.
SELECT is(pg_temp.pub('vesna', 'z1', 1, jsonb_build_array(pg_temp.crit('a'))::text), 'ZD409: conflict', 'the first version expects 0');
SELECT is(pg_temp.pub('vesna', 'z1', 0, jsonb_build_array(pg_temp.crit('tema'), pg_temp.crit('izvori', 'Izvori i navođenje'))::text), '1', 'the first version');
SELECT is(pg_temp.pub('vesna', 'z1', 0, jsonb_build_array(pg_temp.crit('a'))::text), 'ZD409: conflict', 'a stale expected version is a conflict');
SELECT is(pg_temp.rt('vesna', 'z1'), '1:tema,izvori', 'the teacher reads the version');
SELECT is(pg_temp.rs('ana', 'z1'), '1:tema,izvori', 'the student reads the same');
SELECT is(pg_temp.rs('dora', 'z1'), '1:tema,izvori', 'and so does the other student of the course');
SELECT is(pg_temp.rs('tomo', 'z1'), 'ZD404: not found', 'a student of another institution still reads 404');
SELECT is(pg_temp.pub('vesna', 'z1', 1, jsonb_build_array(pg_temp.crit('metoda'))::text), '2', 'the teacher adds the next version');
SELECT is(pg_temp.rt('vesna', 'z1'), '2:metoda', 'the latest one is read');
SELECT is(pg_temp.rs('ana', 'z1'), '2:metoda', 'the student reads the latest one');
SELECT is((SELECT string_agg(version::text, ',' ORDER BY version) FROM institution.assignment_rubric_version), '1,2', 'both versions are kept');
SELECT is((SELECT criteria -> 0 ->> 'id' FROM institution.assignment_rubric_version WHERE version = 1), 'tema', 'version 1 is as it was');
SELECT is(pg_temp.rt('vesna', 'z2'), 'ZD404: not found', 'the rubric of z1 is no part of z2');
SELECT is(pg_temp.rt('marko', 'z2'), 'none', 'Marko teaches z2 and it has none');
SELECT is(pg_temp.pub('marko', 'z2', 0, jsonb_build_array(pg_temp.crit('a'))::text), '1', 'and has a chain of its own');

-- A confirmed role is part of being a teacher: Nina''s is not confirmed. (Nina teaches nothing; the 404 above covers it.)
-- A mentored work: the mentor is its teacher, the student of the mentorship its student.
SELECT is(pg_temp.rt('marko', 'zm1'), 'none', 'the mentor reads the rubric of the mentored assignment');
SELECT is(pg_temp.pub('marko', 'zm1', 0, jsonb_build_array(pg_temp.crit('a'))::text), '1', 'and adds one');
SELECT is(pg_temp.rs('ana', 'zm1'), '1:a', 'the student of the mentorship reads it');
SELECT is(pg_temp.rt('ana', 'zm1'), 'ZD404: not found', 'but cannot read it as a teacher');
SELECT is(pg_temp.rs('dora', 'zm1'), 'ZD404: not found', 'another student has no part');
SELECT is(pg_temp.rt('vesna', 'zm1'), 'ZD404: not found', 'a teacher of another course has no part');

-- A revoked teacher role ends the right to read and write.
SET LOCAL ROLE ductus_identity;
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('marko') AND role = 'teacher';
RESET ROLE;
SELECT is(pg_temp.rt('marko', 'z2'), 'ZD404: not found', 'a revoked teacher reads 404');
SELECT is(pg_temp.pub('marko', 'z2', 1, jsonb_build_array(pg_temp.crit('b'))::text), 'ZD404: not found', 'and cannot publish');

-- Append only for every role.
SELECT is(pg_temp.ask_as('ductus_identity', 'vesna', stmt), 'ZD409: assignment rubric version is immutable', what)
  FROM (VALUES ('UPDATE institution.assignment_rubric_version SET criteria = ''[]''', 'a version cannot be updated'),
               ('DELETE FROM institution.assignment_rubric_version', 'a version cannot be deleted'),
               ('TRUNCATE institution.assignment_rubric_version', 'a version cannot be truncated')) AS t(stmt, what);

SELECT * FROM finish();
ROLLBACK;
