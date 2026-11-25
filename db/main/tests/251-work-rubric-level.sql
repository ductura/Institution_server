-- SRV-V17-RUBRIC-LEVEL (Ductus#2055, val 17): the teacher's mark of a level per criterion of the
-- assignment's rubric, on a work (20261219270000). The personas and documents of the shared
-- fixture, all invented: Vesna teaches K1 and Ana's work doc-a belongs to its assignment z1;
-- Marko teaches K1 too in this test; Petra teaches K3 of fak-b where Tomo studies (doc-b).
-- The access matrix: only the author reads a row, and only while a teacher of the work; the
-- student of the work, another teacher of it, a stranger, an administrator and another
-- institution never do. Marks are bound to a rubric version; nothing touches the evidence schema
-- or the access log, and no number is computed from a mark.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

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

CREATE FUNCTION pg_temp.crit(p_id text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', p_id, 'title', 'Izmišljeni kriterij ' || p_id, 'levels', jsonb_build_array(
    jsonb_build_object('label', 'Niže', 'descriptor', ''),
    jsonb_build_object('label', 'Srednje', 'descriptor', ''),
    jsonb_build_object('label', 'Više', 'descriptor', '')))
$$;
CREATE FUNCTION pg_temp.marks(p_actor text, p_doc text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT string_agg(rubric_version || ':' || criterion_id || '=' || coalesce(level::text, '-') || '/' || coalesce(note, '-'), ' ') FROM collaboration.list_work_rubric(%L) $q$, p_doc))
$$;
CREATE FUNCTION pg_temp.mark(p_actor text, p_doc text, p_crit text, p_level text, p_note text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT rubric_version || ':' || criterion_id || '=' || coalesce(level::text, '-') || '/' || coalesce(note, '-') FROM collaboration.save_work_rubric_mark(%L, %L, %s::smallint, %L) $q$, p_doc, p_crit, coalesce(p_level, 'NULL'), p_note))
$$;

-- 1. Catalogue.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole, 'RLS is forced on work_rubric_level, owned by the identity role')
  FROM pg_class c WHERE c.oid = 'collaboration.work_rubric_level'::regclass;
SELECT bag_eq(
  $$ SELECT policyname::text, roles::text, cmd FROM pg_policies WHERE schemaname = 'collaboration' AND tablename = 'work_rubric_level' $$,
  $$ VALUES ('work_rubric_level_owner', '{ductus_identity}', 'ALL') $$,
  'the table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.work_rubric_level', p) $$,
  'no runtime role reads or writes a mark directly');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.list_work_rubric(text)'::regprocedure,
        'collaboration.save_work_rubric_mark(text,text,smallint,text)'::regprocedure,
        'collaboration.delete_work_rubric_levels(text,uuid)'::regprocedure,
        'collaboration.rubric_criterion_ids(uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the four functions are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.list_work_rubric(text)', 'collaboration.save_work_rubric_mark(text,text,smallint,text)',
        'collaboration.delete_work_rubric_levels(text,uuid)', 'collaboration.rubric_criterion_ids(uuid)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.list_work_rubric(text)'),
            ('ductus_app collaboration.save_work_rubric_mark(text,text,smallint,text)'),
            ('ductus_retention collaboration.delete_work_rubric_levels(text,uuid)') $$,
  'the web role reads and saves, the retention role alone deletes, the helper is for no runtime role');
SELECT is(pg_get_function_result('collaboration.list_work_rubric(text)'::regprocedure),
  'TABLE(rubric_version integer, criterion_id text, level smallint, note text)',
  'the listing names no person and no measure: only the caller''s own level and note');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'), 'the identity role keeps no CREATE on the schema');

-- 2. No rubric yet: version 0 and the six default criteria, in order.
SELECT is(pg_temp.marks('vesna', 'doc-a'),
  '0:topic=-/- 0:structure=-/- 0:sources=-/- 0:method=-/- 0:language=-/- 0:formatting=-/-',
  'while no rubric is set the teacher reads the six default criteria at version 0, none marked');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'sources', '1', 'Dodati još jedan izvor.'), '0:sources=1/Dodati još jedan izvor.', 'a mark is saved against version 0');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'language', '0', NULL) , '0:language=0/-', 'level 0 is a level and not "none"');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'method', NULL, 'Samo bilješka.'), '0:method=-/Samo bilješka.', 'a note alone is saved');
SELECT is(pg_temp.mark('marko', 'doc-a', 'sources', '2', NULL), '0:sources=2/-', 'a second teacher of the work saves her own mark');

-- 3. Who may.
SELECT is(pg_temp.mark(a.name, 'doc-a', 'topic', '1', NULL), 'ZD403: forbidden', a.name || ' cannot mark Ana''s work')
  FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.marks(a.name, 'doc-a'), 'ZD403: forbidden', a.name || ' reads no mark on Ana''s work')
  FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.marks('vesna', 'doc-nema'), 'ZD403: forbidden', 'an unknown work reads as a forbidden one');
SELECT is(pg_temp.mark('tomo', 'doc-b', 'topic', '1', NULL), 'ZD403: forbidden', 'the student of a work never marks it');
SELECT matches(pg_temp.marks('anon', 'doc-a'), '^ZD401', 'reading needs a session');
SELECT matches(pg_temp.mark(t.name, 'doc-a', 'topic', '1', NULL), '^ZD401', 'saving with session ' || t.name || ' is not signed in')
  FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 4. Bad input.
SELECT is(pg_temp.mark('vesna', 'doc-a', 'ocjena', '1', NULL), 'ZD403: forbidden', 'a criterion that is not in the rubric reads like no relation (404)');
SELECT is(pg_temp.mark('vesna', 'doc-a', c.id, c.v, c.n), 'ZD422: invalid input', 'a save with ' || c.why || ' is refused')
  FROM (VALUES ('topic', '3', NULL, 'a level of 3'),
               ('topic', '-1', NULL, 'a level below 0'), ('topic', '1', '   ', 'a blank note'),
               ('topic', '1', repeat('a', 2001), 'a note over 2000 characters'),
               ('topic', '1', E'a‮b', 'a note with a bidirectional override')) AS c (id, v, n, why);

-- 5. Row scope and privacy between authors.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, owner_id, author_id, rubric_version, level, note
      FROM collaboration.work_rubric_level WHERE author_id = pg_temp.id('vesna') AND criterion_id = 'sources' $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 0, 1::smallint, 'Dodati još jedan izvor.'::text),
  'the row takes its scope from the document and its author from the session');
SELECT is(pg_temp.marks('vesna', 'doc-a'),
  '0:topic=-/- 0:structure=-/- 0:sources=1/Dodati još jedan izvor. 0:method=-/Samo bilješka. 0:language=0/- 0:formatting=-/-',
  'Vesna reads her own marks and not Marko''s');
SELECT is(pg_temp.ask('marko', $$ SELECT level FROM collaboration.list_work_rubric('doc-a') WHERE criterion_id = 'sources' $$), '2',
  'Marko reads his own mark of the same criterion');

-- 6. Clearing.
SELECT is(pg_temp.mark('vesna', 'doc-a', 'sources', NULL, NULL), '0:sources=-/-', 'a save of neither answers both null');
SELECT is((SELECT count(*) FROM collaboration.work_rubric_level WHERE author_id = pg_temp.id('vesna') AND criterion_id = 'sources'), 0::bigint, 'and removes the row');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'sources', NULL, NULL), '0:sources=-/-', 'clearing a mark that is not set is no error');
SELECT is((SELECT count(*) FROM collaboration.work_rubric_level WHERE author_id = pg_temp.id('marko')), 1::bigint, 'clearing Vesna''s mark leaves Marko''s alone');

-- 7. A rubric of the teacher's own: the marks follow the latest version, earlier ones stay stored.
SELECT is(pg_temp.ask('vesna', format($$ SELECT version FROM app.publish_assignment_rubric(%L::uuid, 0, %L::jsonb) $$,
  pg_temp.id('z1'), jsonb_build_array(pg_temp.crit('tema'), pg_temp.crit('ton'))::text)), '1', 'Vesna publishes rubric version 1');
SELECT is(pg_temp.marks('vesna', 'doc-a'), '1:tema=-/- 1:ton=-/-',
  'with a rubric the teacher reads its criteria in its order and none of the earlier marks');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'sources', '1', NULL), 'ZD403: forbidden', 'a default criterion that is not in version 1 reads like no relation');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'ton', '2', 'Ujednačen ton.'), '1:ton=2/Ujednačen ton.', 'a mark is saved against version 1');
SELECT is((SELECT count(*) FROM collaboration.work_rubric_level WHERE author_id = pg_temp.id('vesna') AND rubric_version = 0), 2::bigint,
  'the version-0 marks are kept as they were');
SELECT is(pg_temp.ask('vesna', format($$ SELECT version FROM app.publish_assignment_rubric(%L::uuid, 1, %L::jsonb) $$,
  pg_temp.id('z1'), jsonb_build_array(pg_temp.crit('tema'), pg_temp.crit('ton'))::text)), '2', 'Vesna publishes version 2 with the same ids');
SELECT is(pg_temp.marks('vesna', 'doc-a'), '2:tema=-/- 2:ton=-/-', 'a mark made against version 1 does not carry over to version 2');

-- 8. Nothing written in the evidence schema or the access log.
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before), 'no mark wrote anything in the evidence schema');
SELECT is(pg_temp.schema_print('audit'), (SELECT audit FROM print_before), 'reading and saving marks leaves no row in the access log');

-- 9. A teacher who leaves the course loses the marks at once; they stay for retention.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.marks('vesna', 'doc-a'), 'ZD403: forbidden', 'Vesna, no longer a teacher of K1, reads none of her marks');
SELECT is(pg_temp.mark('vesna', 'doc-a', 'ton', '1', NULL), 'ZD403: forbidden', 'nor saves one');
SELECT cmp_ok((SELECT count(*) FROM collaboration.work_rubric_level WHERE author_id = pg_temp.id('vesna')), '>', 0::bigint, 'her marks are still stored, for the retention rule');

-- 10. The marks go with the document, only through the retention role.
SELECT matches(pg_temp.ask('marko', $$ SELECT collaboration.delete_work_rubric_levels('doc-a', {fak_a}) $$), '^42501', 'the web role cannot call the retention delete');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_work_rubric_levels('doc-a', pg_temp.id('fak_b'));
RESET ROLE;
SELECT cmp_ok((SELECT count(*) FROM collaboration.work_rubric_level WHERE document_id = 'doc-a'), '>', 0::bigint, 'a delete with another institution leaves the marks alone');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_work_rubric_levels('doc-a', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.work_rubric_level WHERE document_id = 'doc-a'), 0::bigint, 'after the retention delete no mark of the document is left');

-- 11. The orphan sweep (20261217170000, extended by this migration) removes the marks of a work
-- whose document is gone, and leaves those of a work that exists.
INSERT INTO collaboration.work_rubric_level (institution_id, document_id, assignment_id, owner_id, author_id, rubric_version, criterion_id, level)
VALUES (pg_temp.id('fak_a'), 'doc-gone-rubric', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 0, 'topic', 1),
       (pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('marko'), 0, 'topic', 1);
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '1',
  'the sweep counts and removes the one mark of the gone work');
SELECT is((SELECT count(*) FROM collaboration.work_rubric_level WHERE document_id = 'doc-gone-rubric'), 0::bigint, 'nothing of the gone work is left');
SELECT is((SELECT count(*) FROM collaboration.work_rubric_level WHERE document_id = 'doc-a'), 1::bigint, 'the marks of a work that exists stay');

SELECT * FROM finish();
ROLLBACK;
