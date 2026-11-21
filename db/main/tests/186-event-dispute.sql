-- SRV-1314 (Ductus#2052; plan M7.8, R-08): the student who owns a work adds an
-- amendment to, or disputes, the description of an event of the process
-- summary; a record is only ever added. The student adds and reads the own; a
-- reader of the student's work (teacher or collaborator of the course, seminar
-- group teacher, mentor) reads them but writes none; nobody else, and nobody
-- changes or removes one, the owner neither. Every person, course and text
-- below is invented (fixtures/institution.inc, fixtures/mentorship.inc).
BEGIN;
\ir fixtures/institution.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SET LOCAL lc_messages TO 'C';

SELECT plan(131);

-- 'ok' for an added record, else the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.add(p_actor text, p_assignment text, p_text text,
                            p_kind text DEFAULT 'dispute', p_event text DEFAULT 'pastes/0') RETURNS text
LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format('SELECT ''ok'' FROM app.add_event_dispute(%s, %L, %L, %L)',
                                            p_assignment, p_kind, p_event, p_text)), 1, 5)
$$;
-- The records read as kind:event:text, oldest first and joined with '|', or
-- the SQLSTATE.
CREATE FUNCTION pg_temp.records(p_actor text, p_assignment text, p_student text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT coalesce(string_agg(kind || '':'' || event_id || '':'' || text, ''|'' ORDER BY created_at, id), ''-'') '
      'FROM app.event_disputes(%s%s)', p_assignment, coalesce(', ' || p_student, ''))) AS r) x
$$;

-- 1. Catalogue: the table, its RLS, its triggers and who may call what.
SELECT has_table('evidence', 'event_dispute', 'the records have their own table');
SELECT table_owner_is('evidence', 'event_dispute', 'ductus_evidence', 'the evidence role owns it');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'evidence.event_dispute'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'evidence' AND tablename = 'event_dispute' $$,
  ARRAY['event_dispute_owner ALL to ductus_evidence'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || p.privilege
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_evidence'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE has_table_privilege(r.rolname, 'evidence.event_dispute', p.privilege) $$,
  'no role but the owner, nor PUBLIC, holds a privilege on the records'
);
SELECT bag_eq(
  $$ SELECT t.tgname || ' ' || t.tgtype::text || ' ' || t.tgenabled::text FROM pg_trigger t
      WHERE t.tgrelid = 'evidence.event_dispute'::regclass AND NOT t.tgisinternal $$,
  ARRAY['event_dispute_append_only 27 O', 'event_dispute_no_truncate 34 O'],
  'the append-only triggers: before update or delete of a row, before truncate'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.event_dispute_append(uuid,uuid,text,text,text)', 'app.event_disputes_of(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only their owner and the identity role execute the writer and the reader'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.add_event_dispute(uuid,text,text,text)', 'app.event_disputes(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only ductus_app and their owner execute the two RPCs'
);
SELECT is(
  (SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text
                     || ':' || coalesce('search_path=""' = ANY (p.proconfig), false)::text, ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
      AND p.proname IN ('add_event_dispute', 'event_disputes', 'event_dispute_append', 'event_disputes_of')),
  'add_event_dispute:ductus_identity:true:true,event_dispute_append:ductus_evidence:true:true,'
  || 'event_disputes:ductus_identity:true:true,event_disputes_of:ductus_evidence:true:true',
  'the RPCs belong to the identity role, the writer and the reader to the evidence role; all definers with an empty search_path'
);
SELECT is(substr(pg_temp.ask('ana', $$ SELECT 'x' FROM app.event_dispute_append({z1}, {ana}, 'dispute', 'pastes/0', 'Opis') $$), 1, 5),
  '42501', 'the web role cannot call the writer');
SELECT is(substr(pg_temp.ask('ana', $$ SELECT 'x' FROM app.event_disputes_of({z1}, {ana}) $$), 1, 5), '42501',
  'nor the reader');

-- 2. Who adds. One cell per actor of the fixture on Z1 of K1, on Z3 of fak-b
-- and on the mentorship's ZM1. Another's work, an unknown assignment and no
-- assignment get the same ZD403. Nothing is written by a refusal.
SELECT is(pg_temp.add(c.actor, c.assignment, 'Osporavam: ' || c.actor), c.outcome,
  format('%s disputes an event of %s: %s', c.actor, c.assignment, c.outcome))
FROM (VALUES
  ('ana', '{z1}', 'ok'), ('dora', '{z1}', 'ok'), ('vesna', '{z1}', 'ZD403'), ('marko', '{z1}', 'ZD403'),
  ('iva', '{z1}', 'ZD403'), ('boris', '{z1}', 'ZD403'), ('nina', '{z1}', 'ZD403'), ('tomo', '{z1}', 'ZD403'),
  ('petra', '{z1}', 'ZD403'), ('lea', '{z1}', 'ZD403'), ('tomo', '{z3}', 'ok'), ('ana', '{z3}', 'ZD403'),
  ('petra', '{z3}', 'ZD403'), ('ana', '{zm1}', 'ok'), ('marko', '{zm1}', 'ZD403'), ('dora', '{zm1}', 'ZD403'),
  ('ana', '{z2}', 'ZD403'), ('ana', '{nobody}', 'ZD403'), ('ana', 'NULL', 'ZD403'), ('anon', '{z1}', 'ZD401'),
  ('expired', '{z1}', 'ZD401'), ('closed', '{z1}', 'ZD401')
) AS c (actor, assignment, outcome);
SELECT is(pg_temp.add('dora', '{zm1}', 'Tuđi rad'), pg_temp.add('dora', '{nobody}', 'Nepostojeći rad'),
  'a work of another and a work that does not exist get the same answer');
SELECT is((SELECT count(*) FROM evidence.event_dispute), 4::bigint, 'four records, one per accepted call');
SELECT results_eq(
  $$ SELECT p.name, d.assignment_id, d.institution_id, d.kind, d.event_id
       FROM evidence.event_dispute d JOIN person p ON p.id = d.student_id
      ORDER BY p.name, d.assignment_id $$,
  $$ VALUES ('ana', pg_temp.id('z1'), pg_temp.id('fak_a'), 'dispute', 'pastes/0'),
            ('ana', pg_temp.id('zm1'), pg_temp.id('fak_a'), 'dispute', 'pastes/0'),
            ('dora', pg_temp.id('z1'), pg_temp.id('fak_a'), 'dispute', 'pastes/0'),
            ('tomo', pg_temp.id('z3'), pg_temp.id('fak_b'), 'dispute', 'pastes/0') $$,
  'each record carries the caller as student and the institution of the session'
);

-- 3. The input: the kind, the event id, and the text of 1 to 1000 characters
-- (code points), not only blanks.
SELECT is(pg_temp.add('ana', '{z1}', t.v), t.outcome, t.label)
FROM (VALUES
  ('', 'ZD422', 'an empty text is refused'),
  (E'  \n\t ', 'ZD422', 'a text of blanks only is refused'),
  (repeat('a', 1001), 'ZD422', '1001 characters are refused'),
  (repeat('🌱', 1001), 'ZD422', '1001 supplementary characters are refused'),
  (repeat('a', 1000), 'ok', '1000 characters are accepted'),
  (repeat('🌱', 1000), 'ok', '1000 supplementary characters are accepted (code points, not bytes)'),
  (' x ', 'ok', 'one character that is not blank is enough')
) AS t (v, outcome, label);
SELECT is(pg_temp.add('ana', '{z1}', 'Dopuna opisa', 'amendment', 'sessions/1'), 'ok', 'an amendment is accepted');
SELECT is(pg_temp.add('ana', '{z1}', 'Opis', k.v, 'pastes/0'), 'ZD422', 'the kind is refused: ' || coalesce(k.v, 'null'))
FROM (VALUES ('note'), ('Dispute'), (''), (NULL)) AS k (v);
SELECT is(pg_temp.add('ana', '{z1}', 'Opis', 'dispute', e.v), 'ZD422', 'the event id is refused: ' || e.label)
FROM (VALUES ('', 'empty'), (NULL, 'null'), ('Pastes/0', 'upper case'), ('0/pastes', 'not a letter first'),
             ('pastes 0', 'a blank'), (E'pastes/0\n', 'a line break'), ('pastes/0;', 'a character outside the set'),
             ('a' || repeat('b', 128), '129 characters')) AS e (v, label);
SELECT is(pg_temp.add('ana', '{z1}', 'Opis', 'dispute', e.v), 'ok', 'the event id is accepted: ' || e.v)
FROM (VALUES ('gaps/0'), ('sessions.items:2'), ('a' || repeat('b', 127))) AS e (v);
SELECT is(substr(pg_temp.ask('ana', $$ SELECT 'ok' FROM app.add_event_dispute({z1}, 'dispute', 'pastes/0', NULL) $$), 1, 5),
  'ZD422', 'no text is refused');
SELECT is(pg_temp.add('boris', '{z1}', ''), 'ZD422',
  'the input is checked before the relation, so its refusal says nothing of the assignment');
SELECT is(substr(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'INSERT INTO evidence.event_dispute (institution_id, assignment_id, student_id, kind, event_id, text) '
  'VALUES (%L, %L, %L, %L, %L, %L)', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), t.k, t.e, t.v)), 1, 5),
  '23514', 'the table refuses it too: ' || t.label)
FROM (VALUES ('dispute', 'pastes/0', '', 'empty'), ('dispute', 'pastes/0', '   ', 'blanks'),
             ('dispute', 'pastes/0', repeat('a', 1001), '1001 characters'), ('note', 'pastes/0', 'x', 'another kind'),
             ('dispute', 'Pastes', 'x', 'another event id')) AS t (k, e, v, label);
SELECT is(substr(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'INSERT INTO evidence.event_dispute (institution_id, assignment_id, student_id, kind, event_id, text) '
  'VALUES (%L, %L, %L, ''dispute'', ''pastes/0'', ''x'')', pg_temp.id('fak_b'), pg_temp.id('z1'), pg_temp.id('ana'))), 1, 5),
  '23503', 'a record cannot combine an assignment and a student of another institution');
SELECT is((SELECT count(*) FROM evidence.event_dispute), 11::bigint, 'only the seven accepted inputs were added');

-- 4. Who reads. Ana's records on Z1 are those after the first; the order is
-- the table's (created_at, id).
CREATE TEMP TABLE ana_z1 AS
  SELECT string_agg(kind || ':' || event_id || ':' || text, '|' ORDER BY created_at, id) AS v FROM evidence.event_dispute
   WHERE student_id = pg_temp.id('ana') AND assignment_id = pg_temp.id('z1');
GRANT SELECT ON ana_z1 TO PUBLIC;
SELECT is(pg_temp.records('ana', '{z1}'), (SELECT v FROM ana_z1), 'Ana reads her records on Z1, oldest first, then by id');
SELECT is(pg_temp.records('ana', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'the same when she names herself');
SELECT is(pg_temp.records('ana', '{zm1}'), 'dispute:pastes/0:Osporavam: ana', 'and her record on the mentorship''s assignment, apart');
SELECT is(pg_temp.records(c.actor, c.assignment, c.student), c.outcome,
  format('%s reads the records of %s on %s: %s', c.actor, coalesce(c.student, 'self'), c.assignment, c.outcome))
FROM (VALUES
  ('dora', '{z1}', NULL, 'dispute:pastes/0:Osporavam: dora'), ('tomo', '{z3}', NULL, 'dispute:pastes/0:Osporavam: tomo'),
  ('dora', '{z1}', '{ana}', 'ZD403'), ('ana', '{z1}', '{dora}', 'ZD403'),
  ('vesna', '{z1}', '{dora}', 'dispute:pastes/0:Osporavam: dora'), ('vesna', '{z1}', NULL, 'ZD403'),
  ('marko', '{z1}', '{ana}', 'ZD403'), ('marko', '{zm1}', '{ana}', 'dispute:pastes/0:Osporavam: ana'),
  ('vesna', '{zm1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'), ('boris', '{z1}', '{ana}', 'ZD403'),
  ('nina', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'), ('lea', '{z1}', '{ana}', 'ZD403'),
  ('petra', '{z3}', '{tomo}', 'dispute:pastes/0:Osporavam: tomo'), ('vesna', '{z3}', '{tomo}', 'ZD403'),
  ('vesna', '{z1}', '{boris}', 'ZD403'), ('vesna', '{z1}', '{tomo}', 'ZD403'), ('vesna', '{z1}', '{vesna}', 'ZD403'),
  ('vesna', '{z1}', '{nobody}', 'ZD403'), ('vesna', '{nobody}', '{ana}', 'ZD403'), ('vesna', 'NULL', '{ana}', 'ZD403'),
  ('ana', 'NULL', NULL, 'ZD403'), ('ana', '{z2}', NULL, 'ZD403'), ('anon', '{z1}', NULL, 'ZD401'),
  ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, outcome);
SELECT is(pg_temp.records('vesna', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'Vesna, teacher of K1, reads Ana''s records on Z1');
SELECT is(pg_temp.add('vesna', '{z1}', 'Nastavnik osporava'), 'ZD403', 'but the teacher of the course writes none');
SELECT is(pg_temp.records('dora', '{z1}', '{dora}'), 'dispute:pastes/0:Osporavam: dora',
  'a student with no other record reads only her own');

-- A seminar group teacher (Marko, teacher of K2 only, of K1's G1 with Ana).
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok',
  'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok',
  'fixture: Ana joins G1');
SELECT is(pg_temp.records('marko', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'the teacher of Ana''s seminar group reads her records');
SELECT is(pg_temp.records('marko', '{z1}', '{dora}'), 'ZD403', 'but not those of a student outside his group');
SELECT is(pg_temp.add('marko', '{z1}', 'Osporavanje nastavnika'), 'ZD403', 'and he adds none');
SELECT is(pg_temp.add('marko', '{zm1}', 'Osporavanje mentora'), 'ZD403', 'nor does he as the mentor of ZM1');

-- A collaborator of the course (C-7): Nina, confirmed, joins K1 as a second teacher.
INSERT INTO identity.teacher_eligibility (user_id, institution_id) VALUES (pg_temp.id('nina'), pg_temp.id('fak_a'));
SELECT is(pg_temp.ask('iva', $$ SELECT 'ok' FROM institution.confirm_teacher_role({nina}) $$), 'ok',
  'fixture: Iva confirms Nina''s teacher role');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
  VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('nina'), 'teacher');
SELECT is(pg_temp.records('nina', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'a collaborator of the course reads Ana''s records');
SELECT is(pg_temp.records('nina', '{z1}', '{dora}'), 'dispute:pastes/0:Osporavam: dora', 'and Dora''s');
SELECT is(pg_temp.add('nina', '{z1}', 'Osporavanje suradnice'), 'ZD403', 'and adds none');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'no read of a record writes the access log');
SELECT is((SELECT count(*) FROM evidence.event_dispute), 11::bigint, 'no reader added a record');

-- 5. Only ever added: the owner cannot change, remove or empty a record, and
-- a mistaken grant to the web role still reaches no row.
SELECT is(substr(pg_temp.ask_as('ductus_evidence', 'anon', s), 1, 5), 'ZD403', 'owner: ' || s)
FROM unnest(ARRAY[
  $$UPDATE evidence.event_dispute SET text = 'Izmijenjeno' RETURNING 1$$,
  $$UPDATE evidence.event_dispute SET kind = 'amendment' RETURNING 1$$,
  $$DELETE FROM evidence.event_dispute RETURNING 1$$,
  'TRUNCATE evidence.event_dispute']) s;
SELECT is(substr(pg_temp.ask('ana', s), 1, 5), '42501', 'web role: ' || split_part(s, E'\n', 1))
FROM unnest(ARRAY[
  'SELECT count(*)::text FROM evidence.event_dispute',
  $$INSERT INTO evidence.event_dispute (institution_id, assignment_id, student_id, kind, event_id, text)
    VALUES ({fak_a}, {z1}, {ana}, 'dispute', 'pastes/0', 'Izravno') RETURNING 1$$,
  $$UPDATE evidence.event_dispute SET text = 'Izmijenjeno' RETURNING 1$$,
  $$DELETE FROM evidence.event_dispute RETURNING 1$$]) s;
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence.event_dispute TO ductus_app;
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM evidence.event_dispute'), '0', 'mistaken grant: SELECT sees 0 rows');
SELECT is(pg_temp.ask('ana', $$WITH x AS (UPDATE evidence.event_dispute SET text = 'Izmijenjeno' RETURNING 1)
  SELECT count(*)::text FROM x$$), '0', 'mistaken grant: UPDATE touches 0 rows');
SELECT is(pg_temp.ask('ana', 'WITH x AS (DELETE FROM evidence.event_dispute RETURNING 1) SELECT count(*)::text FROM x'),
  '0', 'mistaken grant: DELETE touches 0 rows');
SELECT is(substr(pg_temp.ask('ana', $$INSERT INTO evidence.event_dispute (institution_id, assignment_id, student_id, kind, event_id, text)
  VALUES ({fak_a}, {z1}, {ana}, 'dispute', 'pastes/0', 'Izravno') RETURNING 1$$), 1, 5), '42501',
  'mistaken grant: INSERT refused by RLS');
REVOKE ALL ON evidence.event_dispute FROM ductus_app;
SELECT is((SELECT count(*) FROM evidence.event_dispute), 11::bigint, 'no record was changed, removed or added directly');

-- 6. A record never touches the work's evidence or its notes: adding one
-- writes no row elsewhere in the evidence schema.
CREATE TEMP TABLE evidence_rows AS
  SELECT c.relname::text AS rel,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM evidence.%I', c.relname), false, true, '')))[1]::text AS n
    FROM pg_class c WHERE c.relnamespace = 'evidence'::regnamespace AND c.relkind = 'r' AND c.relname <> 'event_dispute';
SELECT is(pg_temp.add('dora', '{z1}', 'Dopuna', 'amendment', 'gaps/0'), 'ok', 'Dora adds an amendment');
SELECT is_empty(
  $$ SELECT b.rel FROM evidence_rows b
      WHERE b.n IS DISTINCT FROM (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM evidence.%I', b.rel),
                                                                     false, true, '')))[1]::text $$,
  'no other evidence table changed: the receipt, the submission and the event stay as they were'
);

-- 7. A removed student neither adds nor reads more; her teacher still reads
-- what she wrote, as every read of her work through actor_role.
UPDATE institution.course_member SET member_to = greatest(now(), member_from)
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('ana');
SELECT is(pg_temp.add('ana', '{z1}', 'Kasno osporavanje'), 'ZD403', 'a removed student adds no record');
SELECT is(pg_temp.records('ana', '{z1}'), 'ZD403', 'nor reads her records on the course''s assignment');
SELECT is(pg_temp.records('vesna', '{z1}', '{ana}'), (SELECT v FROM ana_z1), 'the teacher still reads the records of a removed student');
SELECT is(pg_temp.records('ana', '{zm1}'), 'dispute:pastes/0:Osporavam: ana', 'the mentorship is untouched by leaving the course');

SELECT * FROM finish();
ROLLBACK;
