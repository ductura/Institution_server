-- SRV-21 (Ductus#2028, c.7009405737; C-5, PD-4): a student's notes beside the
-- submission, only ever added. The student adds and reads the own; a reader
-- of the student's work (teacher or collaborator of the course, seminar group
-- teacher, mentor) reads them; nobody else, and nobody changes or removes one.
-- Every person, course and text below is invented (fixtures/institution.inc,
-- fixtures/mentorship.inc).
BEGIN;
\ir fixtures/institution.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SET LOCAL lc_messages TO 'C';

SELECT plan(106);

-- 'ok' for an added note, else the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.add(p_actor text, p_assignment text, p_text text) RETURNS text
LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format('SELECT ''ok'' FROM app.add_submission_note(%s, %L)', p_assignment, p_text)), 1, 5)
$$;
-- The texts read, oldest first and joined with '|', or the SQLSTATE.
CREATE FUNCTION pg_temp.notes(p_actor text, p_assignment text, p_student text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT coalesce(string_agg(text, ''|'' ORDER BY created_at, id), ''-'') FROM app.submission_notes(%s%s)',
      p_assignment, coalesce(', ' || p_student, ''))) AS r) x
$$;

-- 1. Catalogue: the table, its RLS, its triggers and who may call what.
SELECT has_table('evidence', 'submission_note', 'the notes have their own table');
SELECT table_owner_is('evidence', 'submission_note', 'ductus_evidence', 'the evidence role owns it');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'evidence.submission_note'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'evidence' AND tablename = 'submission_note' $$,
  ARRAY['submission_note_owner ALL to ductus_evidence'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || p.privilege
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_evidence'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE has_table_privilege(r.rolname, 'evidence.submission_note', p.privilege) $$,
  'no role but the owner, nor PUBLIC, holds a privilege on the notes'
);
SELECT bag_eq(
  $$ SELECT t.tgname || ' ' || t.tgtype::text || ' ' || t.tgenabled::text FROM pg_trigger t
      WHERE t.tgrelid = 'evidence.submission_note'::regclass AND NOT t.tgisinternal $$,
  ARRAY['submission_note_append_only 27 O', 'submission_note_no_truncate 34 O'],
  'the append-only triggers: before update or delete of a row, before truncate'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.submission_note_append(uuid,uuid,text)', 'app.submission_notes_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only their owner and the identity role execute the writer and the reader'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.add_submission_note(uuid,text)', 'app.submission_notes(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only ductus_app and their owner execute the two RPCs'
);
SELECT is(
  (SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text
                     || ':' || coalesce('search_path=""' = ANY (p.proconfig), false)::text, ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
      AND p.proname IN ('add_submission_note', 'submission_notes', 'submission_note_append', 'submission_notes_of')),
  'add_submission_note:ductus_identity:true:true,submission_note_append:ductus_evidence:true:true,'
  || 'submission_notes:ductus_identity:true:true,submission_notes_of:ductus_evidence:true:true',
  'the RPCs belong to the identity role, the writer and the reader to the evidence role; all definers with an empty search_path'
);
SELECT is(substr(pg_temp.ask('ana', $$ SELECT 'x' FROM app.submission_note_append({z1}, {ana}, 'Napomena') $$), 1, 5), '42501',
  'the web role cannot call the writer');
SELECT is(substr(pg_temp.ask('ana', $$ SELECT 'x' FROM app.submission_notes_of({z1}, {ana}) $$), 1, 5), '42501',
  'nor the reader');

-- 2. Who adds. One cell per actor of the fixture on Z1 of K1, on Z3 of fak-b
-- and on the mentorship's ZM1. Nothing is written by a refusal.
SELECT is(pg_temp.add(c.actor, c.assignment, 'Napomena: ' || c.actor), c.outcome,
  format('%s adds a note on %s: %s', c.actor, c.assignment, c.outcome))
FROM (VALUES
  ('ana', '{z1}', 'ok'), ('dora', '{z1}', 'ok'), ('vesna', '{z1}', 'ZD403'), ('marko', '{z1}', 'ZD403'),
  ('iva', '{z1}', 'ZD403'), ('boris', '{z1}', 'ZD403'), ('nina', '{z1}', 'ZD403'), ('tomo', '{z1}', 'ZD403'),
  ('petra', '{z1}', 'ZD403'), ('lea', '{z1}', 'ZD403'), ('tomo', '{z3}', 'ok'), ('ana', '{z3}', 'ZD403'),
  ('petra', '{z3}', 'ZD403'), ('ana', '{zm1}', 'ok'), ('marko', '{zm1}', 'ZD403'), ('dora', '{zm1}', 'ZD403'),
  ('ana', '{z2}', 'ZD403'), ('ana', '{nobody}', 'ZD403'), ('ana', 'NULL', 'ZD403'), ('anon', '{z1}', 'ZD401'),
  ('expired', '{z1}', 'ZD401'), ('closed', '{z1}', 'ZD401')
) AS c (actor, assignment, outcome);
SELECT is((SELECT count(*) FROM evidence.submission_note), 4::bigint, 'four notes, one per accepted call');
SELECT results_eq(
  $$ SELECT p.name, n.assignment_id, n.institution_id FROM evidence.submission_note n JOIN person p ON p.id = n.student_id
      ORDER BY p.name, n.assignment_id $$,
  $$ VALUES ('ana', pg_temp.id('z1'), pg_temp.id('fak_a')), ('ana', pg_temp.id('zm1'), pg_temp.id('fak_a')),
            ('dora', pg_temp.id('z1'), pg_temp.id('fak_a')), ('tomo', pg_temp.id('z3'), pg_temp.id('fak_b')) $$,
  'each note carries the caller as student and the institution of the session'
);

-- 3. The text: 1 to 600 characters (code points), not only blanks.
SELECT is(pg_temp.add('ana', '{z1}', t.v), t.outcome, t.label)
FROM (VALUES
  ('', 'ZD422', 'an empty text is refused'),
  (E'  \n\t ', 'ZD422', 'a text of blanks only is refused'),
  (repeat('a', 601), 'ZD422', '601 characters are refused'),
  (repeat('🌱', 601), 'ZD422', '601 supplementary characters are refused'),
  (repeat('a', 600), 'ok', '600 characters are accepted'),
  (repeat('🌱', 600), 'ok', '600 supplementary characters are accepted (code points, not bytes)'),
  (' x ', 'ok', 'one character that is not blank is enough')
) AS t (v, outcome, label);
SELECT is(substr(pg_temp.ask('ana', $$ SELECT 'ok' FROM app.add_submission_note({z1}, NULL) $$), 1, 5), 'ZD422',
  'no text is refused');
SELECT is(substr(pg_temp.ask('boris', $$ SELECT 'ok' FROM app.add_submission_note({z1}, '') $$), 1, 5), 'ZD422',
  'the text is checked before the relation, so its refusal says nothing of the assignment');
SELECT is(substr(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text) VALUES (%L, %L, %L, %L)',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), t.v)), 1, 5), '23514', 'the table refuses it too: ' || t.label)
FROM (VALUES ('', 'empty'), ('   ', 'blanks'), (repeat('a', 601), '601 characters')) AS t (v, label);
SELECT is(substr(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text) VALUES (%L, %L, %L, ''x'')',
  pg_temp.id('fak_b'), pg_temp.id('z1'), pg_temp.id('ana'))), 1, 5), '23503',
  'a note cannot combine an assignment and a student of another institution');
SELECT is((SELECT count(*) FROM evidence.submission_note), 7::bigint, 'only the three accepted texts were added');

-- 4. Who reads. Ana's notes on Z1 are three texts after the first; the order
-- is the table's (created_at, id), as the contract says.
CREATE TEMP TABLE ana_z1 AS
  SELECT string_agg(text, '|' ORDER BY created_at, id) AS v FROM evidence.submission_note
   WHERE student_id = pg_temp.id('ana') AND assignment_id = pg_temp.id('z1');
GRANT SELECT ON ana_z1 TO PUBLIC;
SELECT is(pg_temp.notes('ana', '{z1}'), (SELECT v FROM ana_z1), 'Ana reads her notes on Z1, oldest first, then by id');
SELECT is(pg_temp.notes('ana', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'the same when she names herself');
SELECT is(pg_temp.notes('ana', '{zm1}'), 'Napomena: ana', 'and her note on the mentorship''s assignment, apart');
SELECT is(pg_temp.notes(c.actor, c.assignment, c.student), c.outcome,
  format('%s reads the notes of %s on %s: %s', c.actor, coalesce(c.student, 'self'), c.assignment, c.outcome))
FROM (VALUES
  ('dora', '{z1}', NULL, 'Napomena: dora'), ('tomo', '{z3}', NULL, 'Napomena: tomo'),
  ('dora', '{z1}', '{ana}', 'ZD403'), ('ana', '{z1}', '{dora}', 'ZD403'),
  ('vesna', '{z1}', '{dora}', 'Napomena: dora'), ('vesna', '{z1}', NULL, 'ZD403'),
  ('marko', '{z1}', '{ana}', 'ZD403'), ('marko', '{zm1}', '{ana}', 'Napomena: ana'),
  ('vesna', '{zm1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'), ('boris', '{z1}', '{ana}', 'ZD403'),
  ('nina', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'), ('lea', '{z1}', '{ana}', 'ZD403'),
  ('petra', '{z3}', '{tomo}', 'Napomena: tomo'), ('vesna', '{z3}', '{tomo}', 'ZD403'),
  ('vesna', '{z1}', '{boris}', 'ZD403'), ('vesna', '{z1}', '{tomo}', 'ZD403'), ('vesna', '{z1}', '{vesna}', 'ZD403'),
  ('vesna', '{z1}', '{nobody}', 'ZD403'), ('vesna', '{nobody}', '{ana}', 'ZD403'), ('vesna', 'NULL', '{ana}', 'ZD403'),
  ('ana', 'NULL', NULL, 'ZD403'), ('ana', '{z2}', NULL, 'ZD403'), ('anon', '{z1}', NULL, 'ZD401'),
  ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, outcome);
SELECT is(pg_temp.notes('vesna', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'Vesna, teacher of K1, reads Ana''s notes on Z1');
SELECT is(pg_temp.notes('dora', '{z1}', '{dora}'), 'Napomena: dora', 'a student with no other note reads only her own');

-- A seminar group teacher (Marko, teacher of K2 only, of K1's G1 with Ana).
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok',
  'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok',
  'fixture: Ana joins G1');
SELECT is(pg_temp.notes('marko', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'the teacher of Ana''s seminar group reads her notes');
SELECT is(pg_temp.notes('marko', '{z1}', '{dora}'), 'ZD403', 'but not those of a student outside his group');
SELECT is(pg_temp.add('marko', '{z1}', 'Napomena nastavnika'), 'ZD403', 'and he adds none');

-- A collaborator of the course (C-7): Nina, confirmed, joins K1 as a second teacher.
INSERT INTO identity.teacher_eligibility (user_id, institution_id) VALUES (pg_temp.id('nina'), pg_temp.id('fak_a'));
SELECT is(pg_temp.ask('iva', $$ SELECT 'ok' FROM institution.confirm_teacher_role({nina}) $$), 'ok',
  'fixture: Iva confirms Nina''s teacher role');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
  VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('nina'), 'teacher');
SELECT is(pg_temp.notes('nina', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'a collaborator of the course reads Ana''s notes');
SELECT is(pg_temp.notes('nina', '{z1}', '{dora}'), 'Napomena: dora', 'and Dora''s');
SELECT is(pg_temp.add('nina', '{z1}', 'Napomena suradnice'), 'ZD403', 'and adds none');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'no read of a note writes the access log');

-- 5. Only ever added: the owner cannot change, remove or empty a note, and a
-- mistaken grant to the web role still reaches no row.
SELECT is(substr(pg_temp.ask_as('ductus_evidence', 'anon', s), 1, 5), 'ZD403', 'owner: ' || s)
FROM unnest(ARRAY[
  $$UPDATE evidence.submission_note SET text = 'Izmijenjeno' RETURNING 1$$,
  $$DELETE FROM evidence.submission_note RETURNING 1$$,
  'TRUNCATE evidence.submission_note']) s;
SELECT is(substr(pg_temp.ask('ana', s), 1, 5), '42501', 'web role: ' || split_part(s, E'\n', 1))
FROM unnest(ARRAY[
  'SELECT count(*)::text FROM evidence.submission_note',
  $$INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text)
    VALUES ({fak_a}, {z1}, {ana}, 'Izravno') RETURNING 1$$,
  $$UPDATE evidence.submission_note SET text = 'Izmijenjeno' RETURNING 1$$,
  $$DELETE FROM evidence.submission_note RETURNING 1$$]) s;
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence.submission_note TO ductus_app;
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM evidence.submission_note'), '0', 'mistaken grant: SELECT sees 0 rows');
SELECT is(pg_temp.ask('ana', $$WITH x AS (UPDATE evidence.submission_note SET text = 'Izmijenjeno' RETURNING 1)
  SELECT count(*)::text FROM x$$), '0', 'mistaken grant: UPDATE touches 0 rows');
SELECT is(pg_temp.ask('ana', 'WITH x AS (DELETE FROM evidence.submission_note RETURNING 1) SELECT count(*)::text FROM x'),
  '0', 'mistaken grant: DELETE touches 0 rows');
SELECT is(substr(pg_temp.ask('ana', $$INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text)
  VALUES ({fak_a}, {z1}, {ana}, 'Izravno') RETURNING 1$$), 1, 5), '42501', 'mistaken grant: INSERT refused by RLS');
REVOKE ALL ON evidence.submission_note FROM ductus_app;
SELECT is((SELECT count(*) FROM evidence.submission_note), 7::bigint, 'no note was changed, removed or added directly');

-- 6. A removed student neither adds nor reads more; her teacher still reads
-- what she wrote, as every read of her work through actor_role.
UPDATE institution.course_member SET member_to = greatest(now(), member_from)
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('ana');
SELECT is(pg_temp.add('ana', '{z1}', 'Kasna napomena'), 'ZD403', 'a removed student adds no note');
SELECT is(pg_temp.notes('ana', '{z1}'), 'ZD403', 'nor reads her notes on the course''s assignment');
SELECT is(pg_temp.notes('vesna', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'the teacher still reads the notes of a removed student');
SELECT is(pg_temp.notes('ana', '{zm1}'), 'Napomena: ana', 'the mentorship is untouched by leaving the course');

SELECT * FROM finish();
ROLLBACK;
