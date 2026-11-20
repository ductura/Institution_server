-- SRV-1106 (Val 11, Ductus#2051; E§3.5 mentor2 "Poruke", PO-22): the short
-- messages next to a work (20261121130000). The access matrix: the student of
-- the work and the teachers of its assignment write and read the same
-- conversation in the order of writing; another student, a stranger, an
-- administrator, a teacher of another course, a teacher who has not been
-- confirmed and another institution never do. A blank message writes
-- nothing; nothing touches the document, its hash chain or the access log;
-- the messages go with the document. Every person, document and text below is
-- invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Marko teaches K1 too, from before Ana's work, so a second teacher of the
-- same work is there to read the same conversation.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');

CREATE FUNCTION pg_temp.schema_print(p_schema text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  t text;
  part text;
  acc text := '';
BEGIN
  FOR t IN SELECT relname FROM pg_class WHERE relnamespace = p_schema::regnamespace AND relkind IN ('r', 'p') ORDER BY relname LOOP
    EXECUTE format('SELECT string_agg(row_to_json(x)::text, ''|'' ORDER BY row_to_json(x)::text) FROM %I.%I x', p_schema, t) INTO part;
    acc := acc || t || ':' || coalesce(part, '') || ';';
  END LOOP;
  RETURN md5(acc);
END
$$;
CREATE TEMP TABLE print_before AS SELECT pg_temp.schema_print('evidence') AS evidence, pg_temp.schema_print('audit') AS audit;

-- 1. Catalogue: owner, forced RLS, one owner policy, no direct privilege.
SELECT bag_eq(
  $$ SELECT relname::text FROM pg_class WHERE relnamespace = 'collaboration'::regnamespace AND relkind = 'r'
      AND relname = 'work_message'
      AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('work_message') $$,
  'the identity role owns the table and RLS is forced on it');
SELECT bag_eq(
  $$ SELECT tablename::text, policyname::text, roles::text, cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename = 'work_message' $$,
  $$ VALUES ('work_message', 'work_message_owner', '{ductus_identity}', 'ALL') $$,
  'the table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.work_message', p) $$,
  'no runtime role reads or writes a message directly');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.create_work_message(text,text)'::regprocedure,
        'collaboration.list_work_messages(text)'::regprocedure, 'collaboration.delete_work_messages(text,uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the three functions are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.create_work_message(text,text)', 'collaboration.list_work_messages(text)',
        'collaboration.delete_work_messages(text,uuid)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.create_work_message(text,text)'),
            ('ductus_app collaboration.list_work_messages(text)'),
            ('ductus_retention collaboration.delete_work_messages(text,uuid)') $$,
  'the web role writes and reads, the retention role alone deletes a document''s messages');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT is(pg_get_function_arguments('collaboration.create_work_message(text,text)'::regprocedure),
  'p_document_id text, p_body text',
  'a message takes no author, role, owner, institution or time: they come from the session and the document');

-- 2. Writing: the student of the work and the teachers of its assignment.
INSERT INTO ref SELECT 'm1', pg_temp.ask('ana', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Dobar dan, mogu li dobiti dodatni rok?') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'm1'), '^[0-9a-f-]{36}$', 'Ana writes to the conversation of her own work');
SELECT is(pg_temp.ask('ana', $$ SELECT sender_role FROM collaboration.create_work_message('doc-a', 'Hvala unaprijed.') $$), 'student',
  'a message of the student carries the role student');
INSERT INTO ref SELECT 'm3', pg_temp.ask('vesna', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Dobar dan, dogovoreno do petka.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'm3'), '^[0-9a-f-]{36}$', 'Vesna, the teacher of K1, answers on Ana''s work');
SELECT is(pg_temp.ask('marko', $$ SELECT sender_role FROM collaboration.create_work_message('doc-a', 'Pridružujem se razgovoru.') $$), 'teacher',
  'a second teacher of the same work writes too, as a teacher');
SELECT matches(pg_temp.ask('petra', $$ SELECT message_id FROM collaboration.create_work_message('doc-b', 'Poruka uz rad iz K3.') $$), '^[0-9a-f-]{36}$',
  'the teacher of K3 writes on Tomo''s work, in the other institution');
SELECT is(pg_temp.ask(a.name, $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Tekst.') $$), 'ZD403: forbidden',
  a.name || ' cannot write to the conversation of Ana''s work')
FROM (VALUES ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT message_id FROM collaboration.create_work_message('doc-nema', 'Tekst.') $$), 'ZD403: forbidden',
  'a missing work reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Tekst.') $$), '^ZD401',
  'a message with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- A blank or malformed message writes nothing.
SELECT is(pg_temp.ask('ana', format($$ SELECT message_id FROM collaboration.create_work_message('doc-a', %L) $$, b.body)), 'ZD422: invalid input',
  'a message ' || b.why || ' is refused')
FROM (VALUES (NULL, 'missing'), ('', 'empty'), ('   ', 'of blanks only'), (repeat('a', 2001), 'over 2000 characters'),
             (E'a‮b', 'with a bidirectional override')) AS b (body, why);
SELECT is((SELECT count(*) FROM collaboration.work_message WHERE document_id = 'doc-a'), 4::bigint,
  'the refused messages wrote no row: the four above are all there is');

-- The row: scope from the document, author and role from the session.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body
      FROM collaboration.work_message WHERE id = pg_temp.id('m3') $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'teacher'::text, 'Dobar dan, dogovoreno do petka.'::text),
  'the message takes its scope from the document and its author and role from the session');

-- 3. Reading: the same conversation, in the order of writing, for everyone with the relation.
SELECT is(pg_temp.ask(a.name, $$ SELECT string_agg(sender_role || ':' || body, ' / ' ORDER BY ord) FROM collaboration.list_work_messages('doc-a') WITH ORDINALITY AS l (message_id, sender_role, body, created_at, ord) $$),
  'student:Dobar dan, mogu li dobiti dodatni rok? / student:Hvala unaprijed. / teacher:Dobar dan, dogovoreno do petka. / teacher:Pridružujem se razgovoru.',
  a.name || ' reads the same four messages in the order of writing')
FROM (VALUES ('ana'), ('vesna'), ('marko')) AS a (name);
SELECT is(pg_temp.ask('petra', $$ SELECT string_agg(body, ' / ') FROM collaboration.list_work_messages('doc-b') $$),
  'Poruka uz rad iz K3.', 'the other institution has a conversation of its own');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_work_messages('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads nothing of the conversation on Ana''s work')
FROM (VALUES ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM collaboration.list_work_messages('doc-b') $$), '1',
  'Tomo reads the conversation of his own work');
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM collaboration.list_work_messages('doc-a') $$), '^ZD401',
  'reading needs a session');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_work_messages('doc-nema') $$), 'ZD403: forbidden',
  'a missing work reads as a forbidden one');
-- Several messages written in one statement time keep their order.
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.work_message (institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body, created_at)
SELECT pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('ana'), 'student', 'Isti trenutak ' || g, '2026-11-21T10:00:00Z'
FROM generate_series(1, 5) g;
RESET ROLE;
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(body, ',' ORDER BY ord) FROM collaboration.list_work_messages('doc-a') WITH ORDINALITY AS l (message_id, sender_role, body, created_at, ord) WHERE body LIKE 'Isti trenutak%' $$),
  'Isti trenutak 1,Isti trenutak 2,Isti trenutak 3,Isti trenutak 4,Isti trenutak 5',
  'messages with the same instant keep the order of writing on every reading');

-- The student and the author are the same only for a student's message.
CREATE FUNCTION pg_temp.student_message_by_teacher() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_fak uuid := pg_temp.id('fak_a');
  v_z uuid := pg_temp.id('z1');
  v_ana uuid := pg_temp.id('ana');
  v_vesna uuid := pg_temp.id('vesna');
BEGIN
  SET LOCAL ROLE ductus_identity;
  INSERT INTO collaboration.work_message (institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body)
  VALUES (v_fak, 'doc-a', v_z, v_ana, v_vesna, 'student', 'Tekst.');
  RESET ROLE;
  RETURN 'written';
EXCEPTION WHEN check_violation THEN
  RESET ROLE;
  RETURN 'check_violation';
END
$f$;
SELECT is(pg_temp.student_message_by_teacher(), 'check_violation', 'a message of the student is written by the owner of the work');

-- 4. Bound: 1000 messages of one work.
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.work_message (institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body)
SELECT pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('ana'), 'student', 'Poruka ' || g
FROM generate_series(1, 999 - (SELECT count(*) FROM collaboration.work_message WHERE document_id = 'doc-a')) g;
RESET ROLE;
SELECT matches(pg_temp.ask('ana', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Tisućita.') $$), '^[0-9a-f-]{36}$',
  'the 1000th message of a work is written');
SELECT is(pg_temp.ask('vesna', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Previše.') $$), 'ZD422: invalid input',
  'the 1001st is refused');

-- 5. Nothing written in the evidence schema or the access log.
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before),
  'no message wrote anything in the evidence schema: the hash chain of the work is untouched');
SELECT is(pg_temp.schema_print('audit'), (SELECT audit FROM print_before),
  'reading and writing messages leaves no row in the access log');

-- 6. A teacher who leaves the course loses the conversation at once; it stays for retention.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_work_messages('doc-a') $$), 'ZD403: forbidden',
  'Vesna, no longer a teacher of K1, reads nothing');
SELECT is(pg_temp.ask('vesna', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Tekst.') $$), 'ZD403: forbidden',
  'nor writes');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) > 0 FROM collaboration.list_work_messages('doc-a') $$), 'true',
  'a teacher who stays still reads it');

-- 7. The messages go with the document, only through the retention role.
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.delete_work_messages('doc-a', {fak_a}) $$), '^42501',
  'the web role cannot call the retention delete');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_work_messages('doc-b', pg_temp.id('fak_a'));
SELECT collaboration.delete_work_messages('doc-nema', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.work_message WHERE document_id = 'doc-b'), 1::bigint,
  'a delete with another institution leaves the other document''s message alone');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_work_messages('doc-a', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.work_message WHERE document_id = 'doc-a'), 0::bigint,
  'after the retention delete no message of the document is left');

SELECT * FROM finish();
ROLLBACK;
