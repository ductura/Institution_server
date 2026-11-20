-- SRV-1103: configured milestones and per-work deadlines, with invented fixtures.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid IN ('institution.work_milestone'::regclass, 'institution.work_milestone_deadline'::regclass);
SELECT ok(NOT has_table_privilege('ductus_app', name, 'SELECT,INSERT,UPDATE,DELETE'),
          'only RPC access to ' || name)
  FROM (VALUES ('institution.work_milestone'), ('institution.work_milestone_deadline')) AS t(name);
SELECT ok(NOT has_function_privilege('ductus_worker', name, 'EXECUTE'), 'worker cannot call ' || name)
  FROM (VALUES ('app.read_work_milestones(text)'), ('app.set_work_milestone_due(text,uuid,timestamptz)')) AS t(name);

SET LOCAL ROLE ductus_identity;
INSERT INTO institution.work_milestone (id, institution_id, assignment_id, position, title, description, due_at, state)
VALUES
  ('00000000-0000-4000-8000-000000000102', pg_temp.id('fak_a'), pg_temp.id('z1'), 2, 'Završna inačica', '', NULL, 'open'),
  ('00000000-0000-4000-8000-000000000101', pg_temp.id('fak_a'), pg_temp.id('z1'), 1, 'Nacrt', 'Nacrt za pregled',
   '2026-12-01T12:00:00Z', 'returned');
RESET ROLE;
SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
  VALUES ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
  VALUES ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), pg_temp.h('a'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
  VALUES ('doc-d', pg_temp.id('fak_a'), 0, pg_temp.id('dora'), pg_temp.h('a'));
RESET ROLE;

CREATE FUNCTION pg_temp.milestones(p_actor text, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT coalesce(string_agg(concat_ws('|', id, title, description, state, coalesce(
      to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), '-')), ';' ORDER BY n), 'empty')
      FROM app.read_work_milestones(%L) WITH ORDINALITY AS m(id, title, description, due_at, state, n)
  $q$, p_document))
$$;

CREATE FUNCTION pg_temp.change_due(p_actor text, p_document text DEFAULT 'doc-a',
                                   p_id uuid DEFAULT '00000000-0000-4000-8000-000000000101') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT concat_ws('|', id, title, description, state, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'))
      FROM app.set_work_milestone_due(%L, %L::uuid, '2026-12-03T15:30:00Z')
  $q$, p_document, p_id))
$$;

SELECT is(pg_temp.milestones(actor),
  '00000000-0000-4000-8000-000000000101|Nacrt|Nacrt za pregled|returned|2026-12-01 12:00;00000000-0000-4000-8000-000000000102|Završna inačica||open|-',
  actor || ' reads the configured milestones in workflow order')
  FROM (VALUES ('ana'), ('vesna')) AS t(actor);
SELECT is(pg_temp.milestones('tomo', 'doc-b'), 'empty', 'an unconfigured work has no milestones');
SELECT is(pg_temp.milestones('anon'), 'ZD401: not authenticated', 'reading requires a session');
SELECT is(pg_temp.milestones(actor), 'ZD404: not found', actor || ' cannot read another work')
  FROM (VALUES ('dora'), ('marko'), ('tomo'), ('petra')) AS t(actor);
SELECT is(pg_temp.change_due('ana'), 'ZD403: forbidden', 'the owner cannot change a deadline');
SELECT is(pg_temp.change_due(actor), 'ZD404: not found', actor || ' cannot change another work')
  FROM (VALUES ('dora'), ('marko'), ('petra')) AS t(actor);
SELECT is(pg_temp.change_due('vesna', 'doc-a', '00000000-0000-4000-8000-000000000199'),
  'ZD404: not found', 'a PATCH cannot create a workflow milestone');
SELECT is(pg_temp.change_due('petra', 'doc-b'), 'ZD404: not found',
  'a teacher cannot use the id of a milestone from another workflow');

SELECT is(pg_temp.change_due('vesna'),
  '00000000-0000-4000-8000-000000000101|Nacrt|Nacrt za pregled|returned|2026-12-03 15:30',
  'the teacher changes only the requested deadline and receives the updated milestone');
SELECT is(pg_temp.milestones(actor),
  '00000000-0000-4000-8000-000000000101|Nacrt|Nacrt za pregled|returned|2026-12-03 15:30;00000000-0000-4000-8000-000000000102|Završna inačica||open|-',
  actor || ' reads the changed deadline with the other milestone untouched')
  FROM (VALUES ('ana'), ('vesna')) AS t(actor);
SELECT is(pg_temp.milestones('dora', 'doc-d'),
  '00000000-0000-4000-8000-000000000101|Nacrt|Nacrt za pregled|returned|2026-12-01 12:00;00000000-0000-4000-8000-000000000102|Završna inačica||open|-',
  'another work on the assignment keeps its configured deadline');

SELECT is(pg_temp.call('ana', 'pkg-a', 'request-milestones', pg_temp.descriptor(), 0, repeat('a', 64),
  repeat('d', 64), repeat('b', 64)), 'reserved', 'fixture: commit a revision');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$),
  'requested', 'fixture: request submission');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
  (SELECT id FROM evidence.submission_request WHERE document_id = 'doc-a'), pg_temp.h('d'))),
  'recorded', 'fixture: record the submission');
SELECT is(pg_temp.change_due('vesna', 'doc-a', '00000000-0000-4000-8000-000000000102'),
  'ZD409: conflict', 'final submission disables a teacher deadline change');
SELECT is(pg_temp.milestones('vesna'), pg_temp.milestones('ana'), 'submitted deadlines are still shared');
SELECT is((SELECT count(*) FROM institution.work_milestone_deadline), 1::bigint,
  'refused updates created no deadlines');

SELECT * FROM finish();
ROLLBACK;
