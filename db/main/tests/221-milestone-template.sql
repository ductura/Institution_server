-- SRV-1521: the template of milestones of an institution, its application to a mentored
-- work and the plan of milestones of one work. Personas of institution.inc and
-- mentorship.inc, all invented: Iva administers fak-a; Ana writes zm1 under her mentor
-- Marko (ms1); Vesna teaches the course of z1; Lea administers fak-b.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid = 'institution.milestone_template_version'::regclass;
SELECT ok(NOT has_table_privilege(r, 'institution.milestone_template_version', 'SELECT,INSERT,UPDATE,DELETE'), r || ' has only RPC access to the template')
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS t(r);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_milestone_template()', 'app.publish_milestone_template(integer,boolean,jsonb)',
    'app.read_work_milestone_plan(text)', 'app.add_work_milestone(text,text,timestamptz,text)',
    'app.apply_milestone_template_to_work(text)']) AS f;
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_app'), ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['institution.apply_milestone_template(uuid,timestamptz)',
    'institution.assignment_apply_milestone_template()', 'institution.is_milestone_template_list(jsonb)']) AS f;

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 8),
  'opened', 'Ana opens her mentored work');

CREATE FUNCTION pg_temp.plan(p_actor text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(position || %L || title || %L || submits || %L || (due_at IS NOT NULL), %L ORDER BY position), %L) FROM app.read_work_milestone_plan(%L)',
    ':', ':', ':', ',', 'empty', coalesce(p_doc, pg_temp.mdoc())))
$$;
CREATE FUNCTION pg_temp.publish(p_actor text, p_expected int, p_final text, p_list text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.publish_milestone_template(%s, %s, %L::jsonb)::text', p_expected, p_final, p_list))
$$;

-- Nothing before there is a template.
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM app.read_milestone_template()'), '0', 'no template at first');
SELECT is(pg_temp.plan('ana'), 'empty', 'a work has no milestones without a template');

-- Who may read and replace it.
SELECT is(pg_temp.ask('anon', 'SELECT count(*)::text FROM app.read_milestone_template()'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.ask(a, 'SELECT count(*)::text FROM app.read_milestone_template()'), 'ZD403: forbidden', a || ' cannot read the template')
  FROM (VALUES ('ana'), ('marko'), ('vesna')) AS t(a);
SELECT is(pg_temp.publish('anon', 0, 'false', '[]'), 'ZD401: not authenticated', 'publishing needs a session');
SELECT is(pg_temp.publish(a, 0, 'false', '[]'), 'ZD403: forbidden', a || ' cannot publish')
  FROM (VALUES ('ana'), ('marko'), ('vesna')) AS t(a);

-- Invalid lists.
SELECT is(pg_temp.publish('iva', 0, 'false', l), 'ZD422: invalid input', what)
  FROM (VALUES
    ('{}', 'an object is not a list'),
    ('[{"title":"A"}]', 'submits is required'),
    ('[{"submits":"topic_text"}]', 'title is required'),
    ('[{"title":"  ","submits":"topic_text"}]', 'a blank title'),
    ('[{"title":"A","submits":"x"}]', 'an unknown submits'),
    ('[{"title":"A","submits":"topic_text","extra":1}]', 'an unknown key'),
    ('[{"title":"A","submits":"topic_text","relativeDue":0}]', 'relativeDue below 1'),
    ('[{"title":"A","submits":"topic_text","relativeDue":1.5}]', 'relativeDue not whole'),
    ('[{"title":"A","submits":"topic_text","relativeDue":"7"}]', 'relativeDue not a number'),
    ('[{"title":"A","submits":"topic_text","relativeDue":1096}]', 'relativeDue above 1095'),
    ('["A"]', 'an item that is not an object'),
    ((SELECT jsonb_agg(jsonb_build_object('title', 'E' || n, 'submits', 'topic_text'))::text FROM generate_series(1, 21) n), 'more than 20 milestones')
  ) AS t(l, what);
SELECT is(pg_temp.ask('iva', format('SELECT app.publish_milestone_template(0, NULL, %L::jsonb)::text', '[]')), 'ZD422: invalid input', 'the flag is not null');
SELECT is(pg_temp.publish('iva', 1, 'false', '[]'), 'ZD409: conflict', 'the expected version must be the latest');
SELECT is(pg_temp.publish('iva', -1, 'false', '[]'), 'ZD422: invalid input', 'the expected version is not negative');

-- Publish, read, replace.
SELECT is(pg_temp.publish('iva', 0, 'false',
  '[{"title":"Tema i nacrt","submits":"topic_text","relativeDue":14},{"title":"Prvo poglavlje","submits":"current_version"}]'),
  '1', 'the first version');
SELECT is(pg_temp.publish('iva', 0, 'false', '[]'), 'ZD409: conflict', 'a stale expected version is a conflict');
SELECT is(pg_temp.ask('iva', format('SELECT version || %L || require_final_stage_approval || %L || jsonb_array_length(milestones) FROM app.read_milestone_template()', '|', '|')),
  '1|false|2', 'Iva reads the version');
SELECT is(pg_temp.ask('lea', 'SELECT count(*)::text FROM app.read_milestone_template()'), '0', 'the administrator of another institution reads none of Iva''s versions');
SELECT is(pg_temp.ask('lea', 'SELECT app.publish_milestone_template(0, true, ''[]''::jsonb)::text'), '1', 'and has a chain of its own');
SELECT is(pg_temp.ask('iva', format('SELECT string_agg(version::text, %L ORDER BY version) FROM app.read_milestone_template()', ',')), '1', 'and Iva does not see it');
SELECT is((SELECT count(*)::int FROM institution.milestone_template_version), 2, 'two versions in all, one per institution');
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', stmt), 'ZD409: milestone template version is immutable', what)
  FROM (VALUES ('UPDATE institution.milestone_template_version SET require_final_stage_approval = true', 'a version cannot be updated'),
               ('DELETE FROM institution.milestone_template_version', 'a version cannot be deleted'),
               ('TRUNCATE institution.milestone_template_version', 'a version cannot be truncated')) AS t(stmt, what);

-- A published template does not change a work that already exists.
SELECT is(pg_temp.plan('ana'), 'empty', 'Ana''s work is as it was');

-- A new mentorship assignment gets the template; a course assignment does not.
SET LOCAL ROLE ductus_identity;
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
INSERT INTO institution.mentorship (id, institution_id, mentor_id, student_id, work_type, started_at)
SELECT '00000000-0000-4000-8000-0000000fe0a1', s.institution_id, pg_temp.id('marko'), s.id, 'master_thesis', now()
  FROM person s WHERE s.name = 'dora';
INSERT INTO institution.assignment (id, mentorship_id, institution_id, current_version, created_by)
SELECT '00000000-0000-4000-8000-0000000fe001', m.id, m.institution_id, 1, m.mentor_id
  FROM institution.mentorship m WHERE m.id = '00000000-0000-4000-8000-0000000fe0a1';
INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
SELECT '00000000-0000-4000-8000-0000000fe001', 1, v.title, v.instructions, v.work_type, v.opens_at, v.due_at, v.ai_policy, v.ai_purposes, v.evidence_profile, v.import_allowed, v.created_by
  FROM institution.assignment_version v WHERE v.assignment_id = pg_temp.id('zm1') AND v.version_no = 1;
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
RESET ROLE;
SELECT is((SELECT string_agg(position || ':' || title || ':' || submits || ':' || (due_at IS NOT NULL), ',' ORDER BY position)
             FROM institution.work_milestone WHERE assignment_id = '00000000-0000-4000-8000-0000000fe001'),
  '1:Tema i nacrt:topic_text:true,2:Prvo poglavlje:current_version:false', 'a new mentorship assignment gets the template');
SELECT is((SELECT count(*)::int FROM institution.work_milestone WHERE assignment_id = pg_temp.id('z1')), 0, 'a course assignment gets none');

-- The mentor adds a milestone and applies the template again.
SELECT is(pg_temp.plan('ana'), 'empty', 'the plan of Ana''s work is still empty');
SELECT is(pg_temp.ask('ana', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), 'X', 'topic_text')), 'ZD403: forbidden', 'the student cannot add');
SELECT is(pg_temp.ask('dora', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), 'X', 'topic_text')), 'ZD404: not found', 'a stranger has no part');
SELECT is(pg_temp.ask('vesna', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), 'X', 'topic_text')), 'ZD404: not found', 'a teacher of another course has no part');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), '  ', 'topic_text')), 'ZD422: invalid input', 'a blank title');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), 'X', 'other')), 'ZD422: invalid input', 'an unknown submits');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, NULL)', pg_temp.mdoc(), 'X')), 'ZD422: invalid input', 'submits is required');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, %L, %L)', pg_temp.mdoc(), 'Uvod', '2026-12-30T10:00:00Z', 'topic_text')), '1', 'the mentor adds a milestone');
SELECT is(pg_temp.plan('ana'), '1:Uvod:topic_text:true', 'the student sees the plan the mentor sees');
SELECT is(pg_temp.plan('marko'), '1:Uvod:topic_text:true', 'the mentor reads it');
SELECT is(pg_temp.plan('dora'), 'ZD404: not found', 'a stranger reads nothing');
SELECT is(pg_temp.plan('anon'), 'ZD401: not authenticated', 'reading the plan needs a session');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), 'Poglavlje', 'current_version')), '2', 'and another');
SELECT is(pg_temp.ask('ana', format('SELECT count(*)::text FROM app.apply_milestone_template_to_work(%L)', pg_temp.mdoc())), 'ZD403: forbidden', 'the student cannot apply the template');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.apply_milestone_template_to_work(%L)', pg_temp.mdoc())), '2', 'the mentor applies the template again');
SELECT is(pg_temp.plan('ana'), '1:Tema i nacrt:topic_text:true,2:Prvo poglavlje:current_version:false', 'the work has the milestones of the template');

-- Once a milestone was submitted, the template is not applied again; adding stays possible.
SELECT is(pg_temp.ask('ana', format('SELECT state FROM app.submit_work_milestone(%L, (SELECT id FROM app.read_work_milestone_plan(%L) WHERE position = 1))', pg_temp.mdoc(), pg_temp.mdoc())),
  'submitted', 'Ana submits the first milestone');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.apply_milestone_template_to_work(%L)', pg_temp.mdoc())), 'ZD409: conflict', 'no template again after a submission');
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM app.add_work_milestone(%L, %L, NULL, %L)', pg_temp.mdoc(), 'Zaključak', 'current_version')), '3', 'a milestone can still be added');

SELECT * FROM finish();
ROLLBACK;
