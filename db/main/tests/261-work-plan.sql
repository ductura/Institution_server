-- SRV-F4-PM2-R15 (Ductus#2059; plan M5.14b, D-234, D-250): the plan of a work
-- behind the panel "Struktura" (20261220210000): the question of the work, the
-- purpose of each chapter and the glossary, kept per work for the student who
-- owns it. Personas of institution.inc and evidence-acceptance.inc, all
-- invented: Ana writes doc-a in Vesna's course K1, Tomo writes doc-b in
-- another institution; Dora, Petra and Boris have no part in Ana's work.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- 1. Catalogue: owner, forced RLS, one owner policy, no direct privilege.
SELECT ok(c.relowner = 'ductus_identity'::regrole AND c.relrowsecurity AND c.relforcerowsecurity,
  'the identity role owns collaboration.work_plan and RLS is forced on it')
  FROM pg_class c WHERE c.oid = 'collaboration.work_plan'::regclass;
SELECT is((SELECT array_agg(p.policyname::text || ' ' || p.roles::text || ' ' || p.cmd)
             FROM pg_policies p WHERE p.schemaname = 'collaboration' AND p.tablename = 'work_plan'),
  ARRAY['work_plan_owner {ductus_identity} ALL'], 'the table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.work_plan', p) $$,
  'no runtime role reads or writes the table directly');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.get_work_plan(text)', 'collaboration.put_work_plan(text,text,jsonb,jsonb)',
        'collaboration.delete_work_plans(text,uuid)', 'collaboration.is_plan_line(text,integer)',
        'collaboration.is_plan_purposes(jsonb)', 'collaboration.is_plan_terms(jsonb)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.get_work_plan(text)'),
            ('ductus_app collaboration.put_work_plan(text,text,jsonb,jsonb)'),
            ('ductus_retention collaboration.delete_work_plans(text,uuid)') $$,
  'the web role calls the two RPCs, the retention role alone deletes, nobody calls the helpers');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.get_work_plan(text)'::regprocedure, 'collaboration.put_work_plan(text,text,jsonb,jsonb)'::regprocedure,
                      'collaboration.delete_work_plans(text,uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the RPCs are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

CREATE FUNCTION pg_temp.put(p_actor text, p_doc text, p_args text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT count(*) FROM collaboration.put_work_plan(%L, %s) $q$, p_doc, p_args))
$$;
CREATE FUNCTION pg_temp.get(p_actor text, p_doc text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT coalesce(question, '-') || '|' || jsonb_array_length(purposes) || '|' || jsonb_array_length(terms)
                                          FROM collaboration.get_work_plan(%L) $q$, p_doc))
$$;
-- 2. Nothing is kept until Ana writes a plan.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_plan('doc-a') $$), '0', 'no plan is kept until Ana writes one');

-- 3. The owner writes the whole plan and reads it back.
SELECT is(pg_temp.ask('ana', $$ SELECT question || '|' || jsonb_array_length(purposes) || '|' || jsonb_array_length(terms)
    FROM collaboration.put_work_plan('doc-a', 'Kako se izmišljeni primjer mijenja?',
      '[{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "purpose": "Uvesti pitanje."}, {"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322111", "purpose": "Opisati metodu."}]',
      '[{"term": "Primjer", "definition": "Izmišljeni pojam.", "kind": "term"}, {"term": "IP", "definition": "Izmišljena kratica.", "kind": "abbreviation"}]') $$),
  'Kako se izmišljeni primjer mijenja?|2|2', 'Ana writes the question, two purposes and two terms');
SELECT is(pg_temp.get('ana', 'doc-a'), 'Kako se izmišljeni primjer mijenja?|2|2', 'and reads them back');
SELECT is(pg_temp.ask('ana', $$ SELECT purposes->0->>'purpose' FROM collaboration.get_work_plan('doc-a') $$), 'Uvesti pitanje.', 'in the order she wrote them');
SELECT is(pg_temp.put('ana', 'doc-a', $$NULL, '[]', '[{"term": "Novi", "definition": "Izmišljeni novi pojam.", "kind": "term"}]'$$), '1',
  'a second write replaces the whole plan');
SELECT is(pg_temp.get('ana', 'doc-a'), '-|0|1', 'with no question, no purpose and one term left');
SELECT is((SELECT count(*) FROM collaboration.work_plan WHERE document_id = 'doc-a'), 1::bigint, 'still one row per work');

-- 4. Nobody else reads or writes it: another student of the course, the teacher, a stranger,
-- another institution and a missing work are the same refusal.
SELECT is(pg_temp.get(a, 'doc-a'), 'ZD403: forbidden', a || ' reads nothing of Ana''s plan')
  FROM (VALUES ('vesna'), ('dora'), ('petra'), ('tomo'), ('boris')) AS t (a);
SELECT is(pg_temp.put(a, 'doc-a', $$'Tuđe pitanje', '[]', '[]'$$), 'ZD403: forbidden', a || ' cannot write on Ana''s plan')
  FROM (VALUES ('vesna'), ('dora'), ('petra'), ('tomo'), ('boris')) AS t (a);
SELECT is(pg_temp.get('ana', 'doc-b'), 'ZD403: forbidden', 'Ana cannot read the plan of another institution''s work');
SELECT is(pg_temp.get('ana', 'doc-nema'), 'ZD403: forbidden', 'a missing work reads as another''s');
SELECT is(pg_temp.put('ana', 'doc-nema', $$'Pitanje', '[]', '[]'$$), 'ZD403: forbidden', 'and cannot be written');
SELECT matches(pg_temp.get('anon', 'doc-a'), '^ZD401', 'reading a plan needs a session');
SELECT matches(pg_temp.put('anon', 'doc-a', $$'Pitanje', '[]', '[]'$$), '^ZD401', 'and so does writing one');
SELECT is(pg_temp.get('ana', 'doc-a'), '-|0|1', 'the refused writes changed nothing');

-- 5. A plan that is not allowed is refused whole and writes nothing.
SELECT is(pg_temp.put('ana', 'doc-a', b.args), 'ZD422: invalid input', 'a plan ' || b.why || ' is refused')
  FROM (VALUES
    ($$'  Pitanje s razmakom', '[]', '[]'$$, 'with a question that has a space at its end'),
    ($$'', '[]', '[]'$$, 'with an empty question'),
    ($$repeat('a', 301), '[]', '[]'$$, 'with a question over 300 characters'),
    ($$E'Dva\nretka', '[]', '[]'$$, 'with a question of two lines'),
    ($$NULL, '{}', '[]'$$, 'whose purposes are not an array'),
    ($$NULL, NULL, '[]'$$, 'with no purposes at all'),
    ($$NULL, '[]', NULL$$, 'with no terms at all'),
    ($$NULL, '[{"nodeId": "nije-uuid", "purpose": "Svrha."}]', '[]'$$, 'with a purpose at a malformed block'),
    ($$NULL, '[{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "purpose": ""}]', '[]'$$, 'with an empty purpose'),
    ($$NULL, '[{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "purpose": "Svrha.", "quote": "x"}]', '[]'$$, 'with a purpose that quotes the text'),
    ($$NULL, '[{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110"}]', '[]'$$, 'with a purpose missing its text'),
    ($$NULL, '[{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "purpose": "Jedna."}, {"nodeId": "1F0E2D3C-4B5A-4968-8776-655443322110", "purpose": "Druga."}]', '[]'$$, 'with two purposes of one block'),
    ($$NULL, '[]', '[{"term": "A", "definition": "B", "kind": "other"}]'$$, 'with a term of an unknown kind'),
    ($$NULL, '[]', '[{"term": "A", "definition": "B"}]'$$, 'with a term missing its kind'),
    ($$NULL, '[]', '[{"term": "Pojam", "definition": "Prva.", "kind": "term"}, {"term": "pojam", "definition": "Druga.", "kind": "term"}]'$$, 'with a term twice, case aside'),
    ($$NULL, '[]', '[{"term": "", "definition": "Prva.", "kind": "term"}]'$$, 'with an empty term'),
    ($$NULL, '[]', jsonb_build_array(jsonb_build_object('term', repeat('t', 81), 'definition', 'D.', 'kind', 'term'))$$, 'with a term over 80 characters'),
    ($$NULL, '[]', jsonb_build_array(jsonb_build_object('term', 'T', 'definition', repeat('d', 501), 'kind', 'term'))$$, 'with a definition over 500 characters'),
    ($$NULL, (SELECT jsonb_agg(jsonb_build_object('nodeId', gen_random_uuid(), 'purpose', 'S.')) FROM generate_series(1, 201)), '[]'$$, 'with 201 purposes'),
    ($$NULL, '[]', (SELECT jsonb_agg(jsonb_build_object('term', 't' || g, 'definition', 'D.', 'kind', 'term')) FROM generate_series(1, 201) g)$$, 'with 201 terms')
  ) AS b (args, why);
SELECT is(pg_temp.get('ana', 'doc-a'), '-|0|1', 'none of them changed the plan');
SELECT is(pg_temp.put('ana', 'doc-a', $$NULL, '[]', (SELECT jsonb_agg(jsonb_build_object('term', 't' || g, 'definition', 'D.', 'kind', 'term')) FROM generate_series(1, 200) g)$$), '1',
  'exactly 200 terms are allowed');

-- 6. A plan with nothing in it is deleted, never kept; deleting what is not there changes nothing.
SELECT is(pg_temp.put('ana', 'doc-a', $$NULL, '[]', '[]'$$), '0', 'an empty plan answers no row');
SELECT is((SELECT count(*) FROM collaboration.work_plan WHERE document_id = 'doc-a'), 0::bigint, 'and no row is kept');
SELECT is(pg_temp.put('ana', 'doc-a', $$NULL, '[]', '[]'$$), '0', 'writing an empty plan again changes nothing');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_plan('doc-a') $$), '0', 'and Ana reads nothing');

-- 7. The plan is not the document: no revision, segment or receipt moves.
SELECT is(pg_temp.put('ana', 'doc-a', $$'Pitanje rada?', '[]', '[]'$$), '1', 'Ana writes a question again');
SELECT is((SELECT count(*) FROM evidence.document_revision WHERE document_id = 'doc-a'), 1::bigint,
  'the revisions of the document are untouched');

-- 8. Retention: the plan goes with the work, and only the retention role deletes it.
SELECT is(pg_temp.ask('ana', format($$ SELECT collaboration.delete_work_plans('doc-a', %L::uuid) $$, pg_temp.id('fak_a'))), '42501: permission denied for function delete_work_plans',
  'the web role cannot delete a plan');
SELECT is(pg_temp.ask_as('ductus_retention', 'ana', format('SELECT ''done'' FROM (SELECT collaboration.delete_work_plans(%L, %L::uuid)) x', 'doc-b', pg_temp.id('fak_a'))), 'done',
  'the retention role deletes the plan of a work in another institution without effect');
SELECT is((SELECT count(*) FROM collaboration.work_plan WHERE document_id = 'doc-a'), 1::bigint, 'and the plan of Ana''s work stays');
SELECT is(pg_temp.ask_as('ductus_retention', 'ana', format('SELECT ''done'' FROM (SELECT collaboration.delete_work_plans(%L, %L::uuid)) x', 'doc-a', pg_temp.id('fak_a'))), 'done',
  'the retention role deletes the plan of the work');
SELECT is((SELECT count(*) FROM collaboration.work_plan WHERE document_id = 'doc-a'), 0::bigint, 'no plan of the work is left');

-- 9. The orphan sweep removes the plan of a work that no longer exists, and only that one.
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.work_plan (institution_id, document_id, owner_id, question)
VALUES (pg_temp.id('fak_a'), 'doc-gone', pg_temp.id('ana'), 'Pitanje izbrisanog rada?');
RESET ROLE;
SELECT is(pg_temp.put('ana', 'doc-a', $$'Pitanje rada?', '[]', '[]'$$), '1', 'Ana''s plan exists again');
SELECT is(pg_temp.ask_as('ductus_retention', 'ana', 'SELECT collaboration.purge_orphan_work_data()::text'), '1',
  'the sweep counts the one plan of a work that is gone');
SELECT is((SELECT count(*) FROM collaboration.work_plan WHERE document_id = 'doc-gone'), 0::bigint, 'and removes it');
SELECT is((SELECT count(*) FROM collaboration.work_plan WHERE document_id = 'doc-a'), 1::bigint, 'the plan of a work that exists stays');

SELECT * FROM finish();
ROLLBACK;
