-- SRV-ED35-KRITERIJI-STUDENT (Daniel 26. 11. 2026, Ductus#2058 c.7192734757):
-- the student reads the working criteria of her own work, each teacher
-- separately (20261220200000). The access matrix of the read: only the student
-- who owns the work; a teacher of the work, another student of the course, a
-- stranger, an administrator and another institution never do. The read writes
-- nothing in the evidence schema or the access log. Every person, document and
-- text below is invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Marko teaches K1 too, so a second teacher of the same work has criteria.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');
-- Vesna has a name pair, Marko none: the read answers his name as null.
INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
VALUES (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Horvat');

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

-- 1. Catalogue: a SECURITY DEFINER function of the identity role, the web role alone.
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid = 'collaboration.student_working_criteria(text)'::regprocedure
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the read is a SECURITY DEFINER function of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_function_privilege(r, 'collaboration.student_working_criteria(text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role calls the read');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT is(pg_get_function_arguments('collaboration.student_working_criteria(text)'::regprocedure),
  'p_document_id text', 'the read takes no person and no institution: they come from the session');

-- 2. No criterion set yet: the owner reads no teacher.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.student_working_criteria('doc-a') $$),
  '0', 'with no criterion set Ana reads no teacher');

SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.save_working_criterion('doc-a', 'sources', 1::smallint, 'Dodati još jedan izvor.') $$), '1', 'vesna saves a criterion');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.save_working_criterion('doc-a', 'language', 0::smallint, NULL) $$), '1', 'vesna saves a second criterion');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.save_working_criterion('doc-a', 'sources', 2::smallint, NULL) $$), '1', 'marko saves a criterion');
SELECT is(pg_temp.ask('petra', $$ SELECT count(*) FROM collaboration.save_working_criterion('doc-b', 'topic', 2::smallint, NULL) $$), '1', 'petra saves a criterion');
CREATE TEMP TABLE print_before AS SELECT pg_temp.schema_print('evidence') AS evidence, pg_temp.schema_print('audit') AS audit;

-- 3. The owner reads each teacher separately, six criteria each, in the fixed order.
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(coalesce(family_name, '-') || ' ' || criterion_id || '=' || coalesce(assessment::text, '-') || '/' || coalesce(note, '-'), ' ' ORDER BY o)
    FROM collaboration.student_working_criteria('doc-a') WITH ORDINALITY AS r (teacher_id, given_name, family_name, criterion_id, assessment, note, o) $$),
  'Horvat topic=-/- Horvat structure=-/- Horvat sources=1/Dodati još jedan izvor. Horvat method=-/- Horvat language=0/- Horvat formatting=-/- '
  || '- topic=-/- - structure=-/- - sources=2/- - method=-/- - language=-/- - formatting=-/-',
  'Ana reads Vesna''s and Marko''s criteria separately, named teachers first, never merged');
SELECT is(pg_temp.ask('ana', $$ SELECT count(DISTINCT teacher_id) || ':' || count(*) FROM collaboration.student_working_criteria('doc-a') $$),
  '2:12', 'two teachers, six criteria each');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(DISTINCT teacher_id::text, ',' ORDER BY teacher_id::text) FROM collaboration.student_working_criteria('doc-a') $$),
  (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(ARRAY[pg_temp.id('vesna'), pg_temp.id('marko')]) AS x),
  'the teachers are the authors of the rows');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(criterion_id || '=' || coalesce(assessment::text, '-') || '/' || coalesce(note, '-'), ' ' ORDER BY o)
    FROM collaboration.student_working_criteria('doc-a') WITH ORDINALITY AS r (teacher_id, given_name, family_name, criterion_id, assessment, note, o)
   WHERE family_name = 'Horvat' $$),
  pg_temp.ask('vesna', $$ SELECT string_agg(criterion_id || '=' || coalesce(assessment::text, '-') || '/' || coalesce(note, '-'), ' ' ORDER BY o)
    FROM collaboration.list_working_criteria('doc-a') WITH ORDINALITY AS r (criterion_id, assessment, note, o) $$),
  'Ana reads exactly the six criteria Vesna reads');
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM collaboration.student_working_criteria('doc-b') WHERE assessment = 2 $$),
  '1', 'Tomo reads Petra''s assessment on his own work');

-- 4. Nobody else reads them.
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.student_working_criteria('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no criterion on Ana''s work through the student read')
FROM (VALUES ('vesna'), ('marko'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.student_working_criteria('doc-b') $$), 'ZD403: forbidden',
  'Ana reads no criterion on a work of another institution');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.student_working_criteria('doc-nema') $$), 'ZD403: forbidden',
  'a missing document reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM collaboration.student_working_criteria('doc-a') $$), '^ZD401',
  'a read with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 5. Nothing written in the evidence schema or the access log.
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before),
  'the student read wrote nothing in the evidence schema');
SELECT is(pg_temp.schema_print('audit'), (SELECT audit FROM print_before),
  'the student read leaves no row in the access log');

-- 6. A cleared criterion and a removed teacher.
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.save_working_criterion('doc-a', 'sources', NULL, NULL) $$), '1', 'marko clears his one criterion');
SELECT is(pg_temp.ask('ana', $$ SELECT count(DISTINCT teacher_id) FROM collaboration.student_working_criteria('doc-a') $$),
  '1', 'a teacher who cleared every criterion no longer appears');

SELECT * FROM finish();
ROLLBACK;
