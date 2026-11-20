-- SRV-1107 (wave 11, Ductus#2051): the six criteria of the mentor's rubric as
-- the teacher's working note (20261121140000, B-9). The access matrix of the
-- table: only the author reads a row, and only while a teacher of the work; the
-- student of the work, another teacher of the same work, a stranger, an
-- administrator and another institution never do. Nothing here touches the
-- document, its hash chain or the access log, and the rows go with the document.
-- Every person, document and text below is invented; the documents are those of
-- the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Marko teaches K1 too, so a second teacher of the same work is there to be refused.
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
      AND relname = 'teacher_working_criterion'
      AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('teacher_working_criterion') $$,
  'the identity role owns the table and RLS is forced on it');
SELECT bag_eq(
  $$ SELECT policyname::text, roles::text, cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename = 'teacher_working_criterion' $$,
  $$ VALUES ('teacher_working_criterion_owner', '{ductus_identity}', 'ALL') $$,
  'the table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.teacher_working_criterion', p) $$,
  'no runtime role reads or writes a criterion directly');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.list_working_criteria(text)'::regprocedure,
        'collaboration.save_working_criterion(text,text,smallint,text)'::regprocedure,
        'collaboration.delete_working_criteria(text,uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the three functions are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.list_working_criteria(text)',
        'collaboration.save_working_criterion(text,text,smallint,text)',
        'collaboration.delete_working_criteria(text,uuid)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.list_working_criteria(text)'),
            ('ductus_app collaboration.save_working_criterion(text,text,smallint,text)'),
            ('ductus_retention collaboration.delete_working_criteria(text,uuid)') $$,
  'the web role reads and saves, the retention role alone deletes a document''s criteria');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT is(pg_get_function_arguments('collaboration.save_working_criterion(text,text,smallint,text)'::regprocedure),
  'p_document_id text, p_criterion_id text, p_assessment smallint, p_note text',
  'a save takes no author, owner, institution or time: they come from the session and the document');
SELECT is(pg_get_function_result('collaboration.list_working_criteria(text)'::regprocedure),
  'TABLE(criterion_id text, assessment smallint, note text)',
  'the listing names no person and no measure: only the caller''s own assessment and note');

-- 2. Reading: six criteria, all empty at first, in the fixed order.
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(criterion_id, ',') FROM collaboration.list_working_criteria('doc-a') $$),
  'topic,structure,sources,method,language,formatting', 'the teacher of K1 reads the six criteria of Ana''s work in order');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_working_criteria('doc-a') WHERE assessment IS NULL AND note IS NULL $$),
  '6', 'none is set at first');

-- 3. Saving: the teacher of the work alone.
SELECT is(pg_temp.ask('vesna', $$ SELECT assessment || ':' || coalesce(note, '-') FROM collaboration.save_working_criterion('doc-a', 'sources', 1::smallint, 'Dodati još jedan izvor.') $$),
  '1:Dodati još jedan izvor.', 'Vesna saves an assessment with a note');
SELECT is(pg_temp.ask('vesna', $$ SELECT assessment || ':' || coalesce(note, '-') FROM collaboration.save_working_criterion('doc-a', 'language', 0::smallint, NULL) $$),
  '0:-', 'the lowest assessment, 0, is an assessment and not "none"');
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(assessment::text, '-') || ':' || note FROM collaboration.save_working_criterion('doc-a', 'method', NULL, 'Samo bilješka.') $$),
  '-:Samo bilješka.', 'a note alone is saved');
SELECT is(pg_temp.ask('marko', $$ SELECT assessment FROM collaboration.save_working_criterion('doc-a', 'sources', 2::smallint, NULL) $$),
  '2', 'a second teacher of the same work saves her own');
SELECT is(pg_temp.ask('petra', $$ SELECT assessment FROM collaboration.save_working_criterion('doc-b', 'topic', 2::smallint, NULL) $$),
  '2', 'the teacher of K3 saves one on Tomo''s document');
SELECT is(pg_temp.ask(a.name, $$ SELECT assessment FROM collaboration.save_working_criterion('doc-a', 'topic', 1::smallint, NULL) $$), 'ZD403: forbidden',
  a.name || ' cannot save a criterion on Ana''s document')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT assessment FROM collaboration.save_working_criterion('doc-nema', 'topic', 1::smallint, NULL) $$), 'ZD403: forbidden',
  'a missing document reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT assessment FROM collaboration.save_working_criterion('doc-a', 'topic', 1::smallint, NULL) $$), '^ZD401',
  'a save with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('vesna', format($$ SELECT assessment FROM collaboration.save_working_criterion('doc-a', %L, %L::smallint, %L) $$, c.id, c.v, c.n)),
  'ZD422: invalid input', 'a save with ' || c.why || ' is refused')
FROM (VALUES ('ocjena', '1', NULL, 'an unknown criterion'), ('topic', '3', NULL, 'an assessment of 3'),
             ('topic', '-1', NULL, 'an assessment below 0'), ('topic', '1', '   ', 'a blank note'),
             ('topic', '1', repeat('a', 2001), 'a note over 2000 characters'),
             ('topic', '1', E'a‮b', 'a note with a bidirectional override')) AS c (id, v, n, why);

-- The row: scope from the document, author from the session.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, owner_id, author_id, assessment, note
      FROM collaboration.teacher_working_criterion WHERE author_id = pg_temp.id('vesna') AND criterion_id = 'sources' $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 1::smallint, 'Dodati još jedan izvor.'::text),
  'the row takes its scope from the document and its author from the session');

-- 4. Reading back: the author alone, while a teacher of the work.
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(criterion_id || '=' || coalesce(assessment::text, '-') || '/' || coalesce(note, '-'), ' ' ORDER BY criterion_id) FROM collaboration.list_working_criteria('doc-a') $$),
  'formatting=-/- language=0/- method=-/Samo bilješka. sources=1/Dodati još jedan izvor. structure=-/- topic=-/-',
  'Vesna reads her three set criteria and not Marko''s');
SELECT is(pg_temp.ask('marko', $$ SELECT assessment FROM collaboration.list_working_criteria('doc-a') WHERE criterion_id = 'sources' $$), '2',
  'Marko reads his own assessment of the same criterion');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_working_criteria('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no criterion on Ana''s document')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM collaboration.list_working_criteria('doc-a') $$), '^ZD401',
  'reading criteria needs a session');
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM collaboration.list_working_criteria('doc-b') $$), 'ZD403: forbidden',
  'the student of a work never reads the criteria on it');
SELECT is(pg_temp.ask('petra', $$ SELECT count(*) FROM collaboration.list_working_criteria('doc-b') WHERE assessment IS NOT NULL $$), '1',
  'the teacher of K3 reads her one assessment on Tomo''s document');

-- 5. Replacing and clearing: a save replaces both values, a save of neither removes the row.
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(assessment::text, '-') || ':' || coalesce(note, '-') FROM collaboration.save_working_criterion('doc-a', 'sources', 2::smallint, NULL) $$),
  '2:-', 'a save replaces the note too: the null clears it');
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(assessment::text, '-') || ':' || coalesce(note, '-') FROM collaboration.save_working_criterion('doc-a', 'sources', NULL, NULL) $$),
  '-:-', 'a save of neither answers both null');
SELECT is((SELECT count(*) FROM collaboration.teacher_working_criterion WHERE author_id = pg_temp.id('vesna') AND criterion_id = 'sources'), 0::bigint,
  'and removes the row');
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(assessment::text, '-') FROM collaboration.save_working_criterion('doc-a', 'sources', NULL, NULL) $$), '-',
  'clearing a criterion that is not set is no error');
SELECT is((SELECT count(*) FROM collaboration.teacher_working_criterion WHERE author_id = pg_temp.id('marko')), 1::bigint,
  'clearing Vesna''s criterion leaves Marko''s alone');

-- 6. Nothing written in the evidence schema or the access log (D-266, PRODUCT §5 rule 17).
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before),
  'no criterion wrote anything in the evidence schema: the hash chain of the work is untouched');
SELECT is(pg_temp.schema_print('audit'), (SELECT audit FROM print_before),
  'reading and saving criteria leaves no row in the access log');

-- 7. A teacher who leaves the course loses the criteria at once; they stay for retention.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_working_criteria('doc-a') $$), 'ZD403: forbidden',
  'Vesna, no longer a teacher of K1, reads none of her criteria');
SELECT is(pg_temp.ask('vesna', $$ SELECT assessment FROM collaboration.save_working_criterion('doc-a', 'topic', 1::smallint, NULL) $$), 'ZD403: forbidden',
  'nor saves one');
SELECT is((SELECT count(*) FROM collaboration.teacher_working_criterion WHERE author_id = pg_temp.id('vesna')), 2::bigint,
  'her criteria are still stored, for the retention rule');

-- 8. The criteria go with the document, only through the retention role.
SELECT matches(pg_temp.ask('marko', $$ SELECT collaboration.delete_working_criteria('doc-a', {fak_a}) $$), '^42501',
  'the web role cannot call the retention delete');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_working_criteria('doc-b', pg_temp.id('fak_b'));
SELECT collaboration.delete_working_criteria('doc-a', pg_temp.id('fak_b'));
SELECT collaboration.delete_working_criteria('doc-nema', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.teacher_working_criterion WHERE document_id = 'doc-b'), 0::bigint,
  'after the retention delete no criterion of the document is left');
SELECT is((SELECT count(*) FROM collaboration.teacher_working_criterion WHERE document_id = 'doc-a'), 3::bigint,
  'a delete with another institution leaves the other document''s criteria alone');

SELECT * FROM finish();
ROLLBACK;
