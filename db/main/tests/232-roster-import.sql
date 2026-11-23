-- SRV-ADMIN-2 admin-uvoz-popisa (Ductus#2055, NF-7 OA-10): the administrator
-- imports the list of students of a course in two steps,
-- institution.preview_roster_import and institution.confirm_roster_import.
-- Only an administrator of the course's institution; the preview enrols
-- nobody; the confirmation enrols exactly the preview's new rows, once.
-- Every person, identifier and course below is invented
-- (fixtures/institution.inc: identifiers are <name>@fak-<x>.example).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(72);

-- Fixed rows: Boris (fak-a, in no course) is new in K1, Ana is already a
-- student of K1, Vesna is its teacher, Tomo belongs to fak-b, nobody has the
-- last identifier.
CREATE FUNCTION pg_temp.row(p_identifier text, p_given text, p_family text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('identifier', p_identifier, 'givenName', p_given, 'familyName', p_family)
$$;
CREATE TEMP TABLE input AS
SELECT jsonb_build_array(
  pg_temp.row('boris@fak-a.example', 'Boris', 'Izmišljeni'),
  pg_temp.row('ana@fak-a.example', 'Ana', 'Izmišljena'),
  pg_temp.row('vesna@fak-a.example', 'Vesna', 'Izmišljena'),
  pg_temp.row('tomo@fak-b.example', 'Tomo', 'Izmišljeni'),
  pg_temp.row('nepostojeci@fak-a.example', 'Netko', 'Nepostojeći')
) AS rows;
GRANT SELECT ON input TO PUBLIC;

CREATE FUNCTION pg_temp.preview(p_actor text, p_course text, p_source text, p_rows jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT institution.preview_roster_import(%s, %L, %L::jsonb)::text',
                                     p_course, p_source, p_rows::text))
$$;
CREATE FUNCTION pg_temp.confirm(p_actor text, p_import text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT institution.confirm_roster_import(%L)::text', p_import))
$$;
CREATE FUNCTION pg_temp.students(p_course text) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM institution.course_member m
   WHERE m.course_id = pg_temp.id(p_course) AND m.role = 'student' AND m.member_to IS NULL
$$;
CREATE FUNCTION pg_temp.imports() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.roster_import $$;

-- 1. Only an administrator of the institution.
SELECT is(pg_temp.preview(v.actor, '{k1}', 'merlin', (SELECT rows FROM input)), v.answer, v.actor || ': ' || v.what)
FROM (VALUES
  (1, 'anon', 'ZD401: not authenticated', 'without a session is refused'),
  (2, 'expired', 'ZD401: not authenticated', 'with an expired session is refused'),
  (3, 'vesna', 'ZD403: forbidden', 'the teacher of the course is refused'),
  (4, 'marko', 'ZD403: forbidden', 'another teacher is refused'),
  (5, 'nina', 'ZD403: forbidden', 'an unconfirmed teacher is refused'),
  (6, 'ana', 'ZD403: forbidden', 'a student of the course is refused'),
  (7, 'boris', 'ZD403: forbidden', 'a user without a role is refused'),
  (8, 'lea', 'ZD404: not found', 'the administrator of fak-b does not find a course of fak-a')
) AS v (n, actor, answer, what)
ORDER BY v.n;
SELECT is(pg_temp.preview('iva', '{nobody}', 'merlin', '[]'), 'ZD404: not found', 'a course that does not exist');
SELECT is(pg_temp.imports(), 0::bigint, 'the refused calls kept no import');

-- 2. Input.
SELECT is(pg_temp.preview('iva', '{k1}', v.source, v.rows::jsonb), 'ZD422: invalid input', 'Iva: ' || v.what)
FROM (VALUES
  (1, 'moodle', '[]', 'a source other than merlin and isvu'),
  (2, 'merlin', '{}', 'rows that are no array'),
  (3, 'merlin', '[1]', 'a row that is no object'),
  (4, 'merlin', '[{"identifier": "boris@fak-a.example", "givenName": "Boris"}]', 'a row without a family name'),
  (5, 'merlin', '[{"identifier": "boris@fak-a.example", "givenName": "Boris", "familyName": "I", "x": 1}]', 'a row with a key too many'),
  (6, 'merlin', '[{"identifier": "boris", "givenName": "Boris", "familyName": "I"}]', 'an identifier without a domain'),
  (7, 'merlin', '[{"identifier": "boris@FAK-A.example", "givenName": "Boris", "familyName": "I"}]', 'a domain not in lower case'),
  (8, 'merlin', '[{"identifier": "boris@fak-a.example", "givenName": " ", "familyName": "I"}]', 'a blank given name'),
  (9, 'merlin', '[{"identifier": "boris@fak-a.example", "givenName": "B", "familyName": "I"}, {"identifier": "BORIS@fak-a.example", "givenName": "B", "familyName": "I"}]', 'the same identifier twice'),
  (10, 'merlin', '[{"identifier": 7, "givenName": "B", "familyName": "I"}]', 'an identifier that is no string'),
  (11, 'merlin', '[{"identifier": "ima razmak@fak-a.example", "givenName": "B", "familyName": "I"}]', 'an identifier with a space'),
  (12, 'merlin', '[{"identifier": "boriš@fak-a.example", "givenName": "B", "familyName": "I"}]', 'an identifier outside printable ASCII')
) AS v (n, source, rows, what)
ORDER BY v.n;
SELECT is(
  pg_temp.ask('iva', format('SELECT institution.preview_roster_import({k1}, %L, (SELECT jsonb_agg(jsonb_build_object(%L, %L || g || %L, %L, %L, %L, %L)) FROM generate_series(1, 1001) g))::text',
                            'merlin', 'identifier', 's', '@fak-a.example', 'givenName', 'A', 'familyName', 'B')),
  'ZD422: invalid input', 'more than 1000 rows are refused');
SELECT is(pg_temp.imports(), 0::bigint, 'the refused input kept no import');

-- 3. The preview: one status per row, nothing enrolled.
CREATE TEMP TABLE preview AS
SELECT pg_temp.preview('iva', '{k1}', 'merlin', (SELECT rows FROM input))::jsonb AS answer;
SELECT is((SELECT answer -> 'statuses' FROM preview),
          '["new", "already_enrolled", "course_teacher", "unknown_account", "unknown_account"]'::jsonb,
          'Boris new, Ana already enrolled, Vesna teacher, Tomo of fak-b and the unknown identifier unknown');
SELECT matches((SELECT answer ->> 'import_id' FROM preview), '^[0-9a-f-]{36}$', 'the preview has an import id');
SELECT matches((SELECT answer ->> 'expires_at' FROM preview), '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
               'and an expiry as an instant');
SELECT ok((SELECT (answer ->> 'expires_at')::timestamptz - now() BETWEEN interval '29 minutes 59 seconds' AND interval '30 minutes'
             FROM preview), 'thirty minutes after the preview, to the millisecond');
SELECT is(pg_temp.students('k1'), 2::bigint, 'the preview enrolled nobody');
SELECT is((SELECT concat_ws(' ', i.course_id = pg_temp.id('k1'), i.created_by = pg_temp.id('iva'), i.source,
                            i.row_count, i.new_count, i.confirmed_at IS NULL)
             FROM institution.roster_import i),
          't t merlin 5 1 t', 'the import keeps the course, Iva, the source and the counts, unconfirmed');
SELECT is((SELECT array_agg(e.user_id) FROM institution.roster_import_entry e),
          ARRAY[pg_temp.id('boris')], 'it keeps only Boris''s account to enrol');
SELECT is((SELECT count(*) FROM pg_attribute a
            WHERE a.attrelid IN ('institution.roster_import'::regclass, 'institution.roster_import_entry'::regclass)
              AND a.attnum > 0 AND a.attname ~ 'identifier|name|csv'),
          0::bigint, 'no identifier, name or file of a row is kept');

-- Case of the identifier and the account's name.
INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
SELECT id, institution_id, 'Boris', 'Izmišljeni' FROM person WHERE name = 'boris';
SELECT is(pg_temp.preview('iva', '{k1}', 'isvu', jsonb_build_array(pg_temp.row('Boris@fak-a.example', '  boris ', 'IZMIŠLJENI')))::jsonb -> 'statuses',
          '["new"]'::jsonb, 'the identifier''s local part and the name compare without case and outer spaces');
SELECT is(pg_temp.preview('iva', '{k1}', 'isvu', jsonb_build_array(pg_temp.row('boris@fak-a.example', 'Borna', 'Izmišljeni')))::jsonb -> 'statuses',
          '["name_mismatch"]'::jsonb, 'another given name than the account''s is a mismatch');
SELECT is(pg_temp.preview('iva', '{k1}', 'isvu', '[]')::jsonb -> 'statuses', '[]'::jsonb, 'an empty list previews to nothing');

-- 4. Who confirms.
CREATE TEMP TABLE first AS SELECT answer ->> 'import_id' AS id FROM preview;
GRANT SELECT ON first TO PUBLIC;
SELECT is(pg_temp.confirm(v.actor, (SELECT id FROM first)), v.answer, v.actor || ': ' || v.what)
FROM (VALUES
  (1, 'anon', 'ZD401: not authenticated', 'without a session is refused'),
  (2, 'vesna', 'ZD403: forbidden', 'the teacher of the course is refused'),
  (3, 'ana', 'ZD403: forbidden', 'a student is refused'),
  (4, 'boris', 'ZD403: forbidden', 'the student on the list is refused'),
  (5, 'lea', 'ZD404: not found', 'the administrator of fak-b does not find the import')
) AS v (n, actor, answer, what)
ORDER BY v.n;
SELECT is(pg_temp.confirm('iva', '00000000-0000-4000-8000-00000000dead'), 'ZD404: not found', 'an unknown import');
SELECT is(pg_temp.confirm('iva', 'nije-uuid'), '22P02: invalid input syntax for type uuid: "nije-uuid"',
          'an import id that is no UUID is refused before the function');
SELECT is(pg_temp.students('k1'), 2::bigint, 'the refused confirmations enrolled nobody');

-- 5. The confirmation enrols the preview's new rows, once.
SELECT is(pg_temp.confirm('iva', (SELECT id FROM first))::jsonb,
          '{"enrolled": 1, "already_enrolled": 0, "skipped": 0, "already_confirmed": false}'::jsonb,
          'Iva confirms: Boris is enrolled');
SELECT is(pg_temp.students('k1'), 3::bigint, 'K1 has one student more');
SELECT ok(EXISTS (SELECT 1 FROM institution.course_member m
                   WHERE m.course_id = pg_temp.id('k1') AND m.user_id = pg_temp.id('boris')
                     AND m.role = 'student' AND m.member_to IS NULL), 'Boris is an open student member of K1');
SELECT is(pg_temp.ask('boris', 'SELECT institution.actor_course_role({k1})'), 'student', 'and K1 is his to read');
SELECT is(pg_temp.confirm('iva', (SELECT id FROM first))::jsonb,
          '{"enrolled": 1, "already_enrolled": 0, "skipped": 0, "already_confirmed": true}'::jsonb,
          'confirmed again it answers the first result');
SELECT is(pg_temp.students('k1'), 3::bigint, 'and enrols nobody twice');
SELECT is((SELECT concat_ws(' ', i.confirmed_by = pg_temp.id('iva'), i.confirmed_at IS NOT NULL,
                            i.enrolled_count, i.already_count, i.skipped_count)
             FROM institution.roster_import i WHERE i.id = (SELECT id FROM first)::uuid),
          't t 1 0 0', 'the import keeps who confirmed, when and the counts');

-- A second preview of the same list after the first confirmation.
CREATE TEMP TABLE second AS
SELECT pg_temp.preview('iva', '{k1}', 'merlin', (SELECT rows FROM input))::jsonb AS answer;
SELECT is((SELECT answer -> 'statuses' -> 0 FROM second), '"already_enrolled"'::jsonb,
          'previewed again, Boris is already enrolled');

-- Two previews of the same student, both confirmed: one membership.
INSERT INTO person VALUES ('mila', '00000000-0000-4000-8000-000000000111', pg_temp.id('fak_a'), 'fak-a');
INSERT INTO ref VALUES ('mila', '00000000-0000-4000-8000-000000000111');
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
VALUES (pg_temp.id('mila'), pg_temp.id('fak_a'), 'https://issuer.test', 'sub-mila', 'mila@fak-a.example');
CREATE TEMP TABLE twice AS
SELECT pg_temp.preview('iva', '{k1}', 'merlin', jsonb_build_array(pg_temp.row('mila@fak-a.example', 'Mila', 'I')))::jsonb ->> 'import_id' AS a,
       pg_temp.preview('iva', '{k1}', 'isvu', jsonb_build_array(pg_temp.row('mila@fak-a.example', 'Mila', 'I')))::jsonb ->> 'import_id' AS b;
GRANT SELECT ON twice TO PUBLIC;
SELECT is(pg_temp.confirm('iva', (SELECT a FROM twice))::jsonb ->> 'enrolled', '1', 'the first of two imports enrols Mila');
SELECT is(pg_temp.confirm('iva', (SELECT b FROM twice))::jsonb,
          '{"enrolled": 0, "already_enrolled": 1, "skipped": 0, "already_confirmed": false}'::jsonb,
          'the second counts her as already enrolled');
SELECT is((SELECT count(*) FROM institution.course_member m
            WHERE m.course_id = pg_temp.id('k1') AND m.user_id = pg_temp.id('mila') AND m.member_to IS NULL),
          1::bigint, 'Mila has one open membership of K1');

-- 6. A student removed by a teacher stays out.
SELECT is(pg_temp.ask('vesna', 'SELECT institution.remove_student({k1}, {dora})::text'), 'true', 'Vesna removes Dora from K1');
SELECT is(pg_temp.preview('iva', '{k1}', 'merlin', jsonb_build_array(pg_temp.row('dora@fak-a.example', 'Dora', 'I')))::jsonb -> 'statuses',
          '["removed"]'::jsonb, 'previewed, Dora is removed');
-- Removed between the preview and the confirmation: counted, not enrolled.
CREATE TEMP TABLE late AS
SELECT pg_temp.preview('iva', '{k2}', 'merlin', jsonb_build_array(pg_temp.row('ana@fak-a.example', 'Ana', 'I')))::jsonb AS answer;
GRANT SELECT ON late TO PUBLIC;
SELECT is((SELECT answer -> 'statuses' FROM late), '["new"]'::jsonb, 'Ana is new in K2');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from, member_to, removed_by)
VALUES (pg_temp.id('k2'), pg_temp.id('fak_a'), pg_temp.id('ana'), 'student', now() - interval '1 day', now(), pg_temp.id('marko'));
SELECT is(pg_temp.confirm('iva', (SELECT answer ->> 'import_id' FROM late))::jsonb,
          '{"enrolled": 0, "already_enrolled": 0, "skipped": 1, "already_confirmed": false}'::jsonb,
          'Marko removed her meanwhile: skipped');
SELECT is(pg_temp.students('k2'), 0::bigint, 'K2 has no student');

-- 7. Expiry.
CREATE TEMP TABLE old AS
SELECT pg_temp.preview('iva', '{k2}', 'merlin', jsonb_build_array(pg_temp.row('boris@fak-a.example', 'Boris', 'Izmišljeni')))::jsonb ->> 'import_id' AS id;
GRANT SELECT ON old TO PUBLIC;
ALTER TABLE institution.roster_import DISABLE TRIGGER roster_import_fixed;
UPDATE institution.roster_import SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'
 WHERE id = (SELECT id FROM old)::uuid;
ALTER TABLE institution.roster_import ENABLE TRIGGER roster_import_fixed;
SELECT is(pg_temp.confirm('iva', (SELECT id FROM old)), 'ZD410: expired', 'a preview past its expiry is not confirmed');
SELECT is(pg_temp.students('k2'), 0::bigint, 'and enrolled nobody');

-- 8. The rows are fixed and reached only through the two functions.
SELECT throws_ok($$ UPDATE institution.roster_import SET new_count = 0 $$, 'ZD409', 'roster import is fixed',
                 'even the owner cannot change an import');
SELECT throws_ok($$ DELETE FROM institution.roster_import_entry $$, 'ZD409', 'roster import is fixed',
                 'nor delete an entry');
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM institution.roster_import'),
          '42501: permission denied for table roster_import', 'the web role cannot read an import, even as administrator');
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM institution.roster_import_entry'),
          '42501: permission denied for table roster_import_entry', 'nor an entry');

-- 9. The import never enrols the caller's own account, nor an account with an
-- administrator role or an engineer appointment of the institution; such a
-- row is unsuitable in the preview and not enrolled at the confirmation.
INSERT INTO person VALUES
  ('zora', '00000000-0000-4000-8000-000000000112', pg_temp.id('fak_a'), 'fak-a'),
  ('eno', '00000000-0000-4000-8000-000000000113', pg_temp.id('fak_a'), 'fak-a'),
  ('rade', '00000000-0000-4000-8000-000000000114', pg_temp.id('fak_a'), 'fak-a'),
  ('sara', '00000000-0000-4000-8000-000000000115', pg_temp.id('fak_a'), 'fak-a'),
  ('tea', '00000000-0000-4000-8000-000000000116', pg_temp.id('fak_a'), 'fak-a');
INSERT INTO ref SELECT name, id::text FROM person WHERE name IN ('zora', 'eno', 'rade', 'sara', 'tea');
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
SELECT p.id, p.institution_id, 'https://issuer.test', 'sub-' || p.name, p.name || '@fak-a.example'
  FROM person p WHERE p.name IN ('zora', 'eno', 'rade', 'sara', 'tea');
-- Zora an administrator, appointed but not yet confirmed; Eno an engineer;
-- Rade's appointment revoked.
INSERT INTO institution.institution_role (institution_id, user_id, role)
VALUES (pg_temp.id('fak_a'), pg_temp.id('zora'), 'admin');
INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by, appointed_at, revoked_at)
VALUES (pg_temp.id('fak_a'), pg_temp.id('eno'), pg_temp.id('iva'), now() - interval '1 day', NULL),
       (pg_temp.id('fak_a'), pg_temp.id('rade'), pg_temp.id('iva'), now() - interval '1 day', now());
CREATE TEMP TABLE staff AS
SELECT pg_temp.preview('iva', '{k2}', 'merlin', jsonb_build_array(
         pg_temp.row('iva@fak-a.example', 'Iva', 'I'),
         pg_temp.row('lea@fak-b.example', 'Lea', 'I'),
         pg_temp.row('zora@fak-a.example', 'Zora', 'I'),
         pg_temp.row('eno@fak-a.example', 'Eno', 'I'),
         pg_temp.row('rade@fak-a.example', 'Rade', 'I')))::jsonb AS answer;
GRANT SELECT ON staff TO PUBLIC;
SELECT is((SELECT answer -> 'statuses' FROM staff),
          '["ineligible_account", "unknown_account", "ineligible_account", "ineligible_account", "new"]'::jsonb,
          'Iva''s own account, administrator Zora and engineer Eno are ineligible; Lea of fak-b unknown; Rade, revoked, new');
SELECT is((SELECT array_agg(e.user_id) FROM institution.roster_import_entry e
            WHERE e.import_id = (SELECT answer ->> 'import_id' FROM staff)::uuid),
          ARRAY[pg_temp.id('rade')], 'the import keeps only Rade''s account to enrol');
SELECT is(pg_temp.confirm('iva', (SELECT answer ->> 'import_id' FROM staff))::jsonb,
          '{"enrolled": 1, "already_enrolled": 0, "skipped": 0, "already_confirmed": false}'::jsonb,
          'confirmed, it enrols Rade alone');
SELECT is((SELECT array_agg(m.user_id ORDER BY m.user_id) FROM institution.course_member m
            WHERE m.course_id = pg_temp.id('k2') AND m.role = 'student' AND m.member_to IS NULL),
          ARRAY[pg_temp.id('rade')], 'K2 has Rade as its one student, neither Iva, Zora nor Eno');
-- Sara and Tea are new in the preview; Sara becomes an engineer and Tea an
-- administrator before the confirmation: both counted as skipped.
CREATE TEMP TABLE meanwhile AS
SELECT pg_temp.preview('iva', '{k2}', 'isvu', jsonb_build_array(
         pg_temp.row('sara@fak-a.example', 'Sara', 'I'),
         pg_temp.row('tea@fak-a.example', 'Tea', 'I')))::jsonb AS answer;
GRANT SELECT ON meanwhile TO PUBLIC;
SELECT is((SELECT answer -> 'statuses' FROM meanwhile), '["new", "new"]'::jsonb, 'Sara and Tea are new in K2');
INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by)
VALUES (pg_temp.id('fak_a'), pg_temp.id('sara'), pg_temp.id('iva'));
INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_at)
VALUES (pg_temp.id('fak_a'), pg_temp.id('tea'), 'admin', now());
SELECT is(pg_temp.confirm('iva', (SELECT answer ->> 'import_id' FROM meanwhile))::jsonb,
          '{"enrolled": 0, "already_enrolled": 0, "skipped": 2, "already_confirmed": false}'::jsonb,
          'an engineer and an administrator since the preview are skipped');
SELECT is((SELECT count(*) FROM institution.course_member m
            WHERE m.course_id = pg_temp.id('k2') AND m.user_id IN (pg_temp.id('sara'), pg_temp.id('tea'))),
          0::bigint, 'neither Sara nor Tea is a member of K2');

SELECT * FROM finish();
ROLLBACK;
