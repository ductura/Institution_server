-- SRV-V17-TEMPLATE-ADMIN: the work template of an institution, one per work type. Personas of
-- institution.inc and mentorship.inc, all invented: Iva administers fak-a; Ana is a student,
-- Marko a mentor and Vesna a teacher; Lea administers fak-b.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid = 'institution.work_template_version'::regclass;
SELECT ok(NOT has_table_privilege(r, 'institution.work_template_version', 'SELECT,INSERT,UPDATE,DELETE'), r || ' has only RPC access to the template')
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS t(r);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_work_template(text)', 'app.publish_work_template(text,integer,jsonb,jsonb,text)']) AS f;
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['institution.is_work_template_text(text,integer,integer)',
    'institution.is_work_template_title_page(jsonb)', 'institution.is_work_template_sections(jsonb)']) AS f;

CREATE FUNCTION pg_temp.publish(p_actor text, p_type text, p_expected int, p_page text, p_sections text, p_style text DEFAULT 'fpzg') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.publish_work_template(%L, %s, %L::jsonb, %L::jsonb, %L)::text',
    p_type, p_expected, p_page, p_sections, p_style))
$$;
CREATE FUNCTION pg_temp.versions(p_actor text, p_type text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(version || %L || title_page::text || %L || jsonb_array_length(sections) || %L || citation_style, %L ORDER BY version), %L) FROM app.read_work_template(%L)',
    ':', ':', ':', ',', 'none', p_type))
$$;

-- Nothing before there is a template.
SELECT is(pg_temp.versions('iva', 'seminar_paper'), 'none', 'no template at first');

-- Who may read and publish.
SELECT is(pg_temp.versions('anon', 'seminar_paper'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.versions(a, 'seminar_paper'), 'ZD403: forbidden', a || ' cannot read the template')
  FROM (VALUES ('ana'), ('marko'), ('vesna')) AS t(a);
SELECT is(pg_temp.publish('anon', 'seminar_paper', 0, '[]', '[]'), 'ZD401: not authenticated', 'publishing needs a session');
SELECT is(pg_temp.publish(a, 'seminar_paper', 0, '[]', '[]'), 'ZD403: forbidden', a || ' cannot publish')
  FROM (VALUES ('ana'), ('marko'), ('vesna')) AS t(a);

-- Invalid input.
SELECT is(pg_temp.publish('iva', ty, 0, pg, sec, st), 'ZD422: invalid input', what)
  FROM (VALUES
    ('thesis', '[]', '[]', 'fpzg', 'a work type outside the set'),
    ('seminar_paper', '{}', '[]', 'fpzg', 'a title page that is not a list'),
    ('seminar_paper', '["title","title"]', '[]', 'fpzg', 'a repeated title page field'),
    ('seminar_paper', '["isbn"]', '[]', 'fpzg', 'an unknown title page field'),
    ('seminar_paper', '[1]', '[]', 'fpzg', 'a title page field that is not a string'),
    ('seminar_paper', '["title","author","mentor","course","date","title"]', '[]', 'fpzg', 'more than five title page fields'),
    ('seminar_paper', '[]', '{}', 'fpzg', 'sections that are not a list'),
    ('seminar_paper', '[]', '["Uvod"]', 'fpzg', 'a section that is not an object'),
    ('seminar_paper', '[]', '[{"title":"Uvod"}]', 'fpzg', 'a section without a hint'),
    ('seminar_paper', '[]', '[{"hint":"x"}]', 'fpzg', 'a section without a title'),
    ('seminar_paper', '[]', '[{"title":"  ","hint":""}]', 'fpzg', 'a blank section title'),
    ('seminar_paper', '[]', '[{"title":"Uvod","hint":"","extra":1}]', 'fpzg', 'an unknown section key'),
    ('seminar_paper', '[]', '[{"title":"Uvod","hint":1}]', 'fpzg', 'a hint that is not a string'),
    ('seminar_paper', '[]', '[{"title":"U\tvod","hint":""}]', 'fpzg', 'a control character in a title'),
    ('seminar_paper', '[]', jsonb_build_array(jsonb_build_object('title', repeat('a', 121), 'hint', ''))::text, 'fpzg', 'a title of 121 characters'),
    ('seminar_paper', '[]', jsonb_build_array(jsonb_build_object('title', 'Uvod', 'hint', repeat('a', 401)))::text, 'fpzg', 'a hint of 401 characters'),
    ('seminar_paper', '[]', (SELECT jsonb_agg(jsonb_build_object('title', 'S' || n, 'hint', ''))::text FROM generate_series(1, 31) n), 'fpzg', 'more than 30 sections'),
    ('seminar_paper', '[]', '[]', 'apa', 'a citation style the institution does not have')
  ) AS t(ty, pg, sec, st, what);
SELECT is(pg_temp.ask('iva', format('SELECT app.publish_work_template(NULL, 0, %L::jsonb, %L::jsonb, %L)::text', '[]', '[]', 'fpzg')), 'ZD422: invalid input', 'the work type is not null');
SELECT is(pg_temp.ask('iva', format('SELECT app.publish_work_template(%L, 0, NULL, %L::jsonb, %L)::text', 'essay', '[]', 'fpzg')), 'ZD422: invalid input', 'the title page is not null');
SELECT is(pg_temp.publish('iva', 'essay', -1, '[]', '[]'), 'ZD422: invalid input', 'the expected version is not negative');
SELECT is(pg_temp.publish('iva', 'essay', 1, '[]', '[]'), 'ZD409: conflict', 'the expected version must be the latest');
-- The bounds themselves are fine.
SELECT is(pg_temp.publish('iva', 'short_paper', 0, '["title","author","mentor","course","date"]',
  (SELECT jsonb_agg(jsonb_build_object('title', repeat('č', 120), 'hint', repeat('š', 400)))::text FROM generate_series(1, 30)), 'fpzg'),
  '1', 'five fields, thirty sections, the longest title and hint');

-- Publish, read, replace: versions are per work type.
SELECT is(pg_temp.publish('iva', 'seminar_paper', 0, '["title","author"]', '[{"title":"Uvod","hint":""}]'), '1', 'the first version of seminar_paper');
SELECT is(pg_temp.publish('iva', 'seminar_paper', 0, '[]', '[]'), 'ZD409: conflict', 'a stale expected version is a conflict');
SELECT is(pg_temp.publish('iva', 'seminar_paper', 1, '["title","author","mentor"]', '[{"title":"Uvod","hint":"Pitanje rada."},{"title":"Zaključak","hint":""}]'), '2', 'the second version');
SELECT is(pg_temp.publish('iva', 'essay', 0, '[]', '[]'), '1', 'another work type has its own chain');
SELECT is(pg_temp.versions('iva', 'seminar_paper'),
  '1:["title", "author"]:1:fpzg,2:["title", "author", "mentor"]:2:fpzg', 'Iva reads both versions in order');
SELECT is(pg_temp.versions('iva', 'essay'), '1:[]:0:fpzg', 'and the other work type apart');
SELECT is(pg_temp.versions('iva', 'master_thesis'), 'none', 'a work type without a version has none');
SELECT is(pg_temp.versions('iva', 'nonsense'), 'ZD422: invalid input', 'reading an unknown work type is invalid');

-- Another institution neither sees nor disturbs it.
SELECT is(pg_temp.versions('lea', 'seminar_paper'), 'none', 'the administrator of another institution reads none of Iva''s versions');
SELECT is(pg_temp.publish('lea', 'seminar_paper', 0, '["title"]', '[]'), '1', 'and has a chain of its own');
SELECT is(pg_temp.versions('iva', 'seminar_paper'),
  '1:["title", "author"]:1:fpzg,2:["title", "author", "mentor"]:2:fpzg', 'and Iva does not see it');
SELECT is((SELECT count(*)::int FROM institution.work_template_version), 5, 'five versions in all');

-- A version never changes and never goes, for every role.
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', stmt), 'ZD409: work template version is immutable', what)
  FROM (VALUES ('UPDATE institution.work_template_version SET citation_style = ''fpzg''', 'a version cannot be updated'),
               ('DELETE FROM institution.work_template_version', 'a version cannot be deleted'),
               ('TRUNCATE institution.work_template_version', 'a version cannot be truncated')) AS t(stmt, what);
-- The app role has no table access: only the RPCs.
SELECT is(pg_temp.ask_as('ductus_app', 'iva', 'SELECT count(*)::text FROM institution.work_template_version'),
  '42501: permission denied for table work_template_version', 'the app role cannot read the table');

SELECT * FROM finish();
ROLLBACK;
