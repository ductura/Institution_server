-- SRV-1520: states of the milestones of one work (not_submitted, submitted,
-- revision_requested, approved) and their events. Personas of institution.inc and
-- mentorship.inc, all invented: Ana writes zm1 under her mentor Marko (ms1); Vesna
-- teaches the course of z1 (doc-a, Ana's work in a course), Petra another course.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid IN ('institution.work_milestone_progress'::regclass, 'institution.work_milestone_event'::regclass);
SELECT ok(NOT has_table_privilege('ductus_app', name, 'SELECT,INSERT,UPDATE,DELETE'), 'only RPC access to ' || name)
  FROM (VALUES ('institution.work_milestone_progress'), ('institution.work_milestone_event')) AS t(name);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_work_milestone_states(text)', 'app.submit_work_milestone(text,uuid)',
    'app.request_work_milestone_revision(text,uuid,text,timestamptz)', 'app.approve_work_milestone(text,uuid,text)',
    'app.change_work_milestone(text,uuid,text,timestamptz)', 'app.delete_work_milestone(text,uuid)']) AS f;

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 8),
  'opened', 'Ana opens her mentored work');

SET LOCAL ROLE ductus_identity;
INSERT INTO institution.work_milestone (id, institution_id, assignment_id, position, title)
VALUES ('00000000-0000-4000-8000-000000000201', pg_temp.id('fak_a'), pg_temp.id('zm1'), 1, 'Nacrt'),
       ('00000000-0000-4000-8000-000000000202', pg_temp.id('fak_a'), pg_temp.id('zm1'), 2, 'Poglavlje'),
       ('00000000-0000-4000-8000-000000000203', pg_temp.id('fak_a'), pg_temp.id('z1'), 1, 'Tečajna etapa');
RESET ROLE;

CREATE FUNCTION pg_temp.act(p_actor text, p_fn text, p_args text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, state, ever_submitted, submitted_revision, coalesce(revision_comment, %L), coalesce(approval_message, %L)) FROM app.%s(%L%s)',
    '|', '-', '-', p_fn, coalesce(p_doc, pg_temp.mdoc()), p_args))
$$;
CREATE FUNCTION pg_temp.states(p_actor text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(state || %L || ever_submitted, %L ORDER BY due_at NULLS LAST, title), %L) FROM app.read_work_milestone_states(%L)',
    ':', ',', 'empty', coalesce(p_doc, pg_temp.mdoc())))
$$;

SELECT is(pg_temp.states(a), 'not_submitted:false,not_submitted:false', a || ' reads fresh milestones') FROM (VALUES ('ana'), ('marko')) AS t(a);
SELECT is(pg_temp.states('anon'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.states(a), 'ZD404: not found', a || ' has no part in the work') FROM (VALUES ('dora'), ('petra'), ('tomo'), ('vesna')) AS t(a);

-- Who may do what.
SELECT is(pg_temp.act('marko', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid'), 'ZD403: forbidden', 'the mentor cannot submit');
SELECT is(pg_temp.act('dora', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid'), 'ZD404: not found', 'a stranger cannot submit');
SELECT is(pg_temp.act('ana', 'request_work_milestone_revision', ', ''00000000-0000-4000-8000-000000000201''::uuid, ''x'', NULL'), 'ZD403: forbidden', 'the student cannot ask for a revision');
SELECT is(pg_temp.act('ana', 'approve_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid, NULL'), 'ZD403: forbidden', 'the student cannot approve');
SELECT is(pg_temp.act('marko', 'approve_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid, NULL'), 'ZD409: conflict', 'nothing to approve before the submission');
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000299''::uuid'), 'ZD404: not found', 'unknown milestone');
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000203''::uuid'), 'ZD404: not found', 'a milestone of another assignment');

-- Submit, ask for a revision, submit again, approve.
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid'), 'submitted|t|0|-|-', 'Ana submits at the current revision');
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid'), 'ZD409: conflict', 'a submitted milestone cannot be submitted again');
SELECT is(pg_temp.act('marko', 'request_work_milestone_revision', ', ''00000000-0000-4000-8000-000000000201''::uuid, ''   '', NULL'), 'ZD422: invalid input', 'the comment is required');
SELECT is(pg_temp.act('marko', 'request_work_milestone_revision', ', ''00000000-0000-4000-8000-000000000201''::uuid, NULL, NULL'), 'ZD422: invalid input', 'the comment is not null');
SELECT is(pg_temp.act('marko', 'request_work_milestone_revision', ', ''00000000-0000-4000-8000-000000000201''::uuid, ''Dopuni uvod'', ''2026-12-20T10:00:00Z'''),
  'revision_requested|t|0|Dopuni uvod|-', 'the mentor asks for a revision');
SELECT is(pg_temp.states('ana'), 'revision_requested:true,not_submitted:false', 'the student sees the same');
SELECT is(pg_temp.act('marko', 'approve_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid, NULL'), 'ZD409: conflict', 'a milestone under revision cannot be approved');
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid'), 'submitted|t|0|-|-', 'Ana submits again');
SELECT is(pg_temp.act('marko', 'approve_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid, ''Dobro'''), 'approved|t|0|-|Dobro', 'the mentor approves');
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000201''::uuid'), 'ZD409: conflict', 'an approved milestone cannot be submitted');
SELECT is(pg_temp.act('marko', 'request_work_milestone_revision', ', ''00000000-0000-4000-8000-000000000201''::uuid, ''Opet'', NULL'), 'ZD409: conflict', 'an approved milestone takes no revision request');

-- The events.
SELECT is((SELECT count(*)::int FROM institution.work_milestone_event WHERE milestone_id = '00000000-0000-4000-8000-000000000201'),
  4, 'four events: two submissions, one revision request, one approval');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', stmt), 'ZD409: conflict', what)
  FROM (VALUES ('UPDATE institution.work_milestone_event SET note = ''x''', 'events cannot be updated'),
               ('DELETE FROM institution.work_milestone_event', 'events cannot be deleted'),
               ('TRUNCATE institution.work_milestone_event', 'events cannot be truncated')) AS t(stmt, what);

-- Change and delete.
SELECT is(pg_temp.ask('marko', format('SELECT title || %L || state FROM app.change_work_milestone(%L, %L::uuid, %L, NULL)', '|', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000201', 'Prvi nacrt')),
  'Prvi nacrt|approved', 'the mentor renames a submitted milestone');
SELECT is(pg_temp.ask('marko', format('SELECT to_char(due_at AT TIME ZONE %L, %L) FROM app.change_work_milestone(%L, %L::uuid, NULL, %L)', 'UTC', 'YYYY-MM-DD', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000201', '2026-12-31T10:00:00Z')),
  '2026-12-31', 'and changes its deadline');
SELECT is(pg_temp.ask('marko', format('SELECT 1 FROM app.change_work_milestone(%L, %L::uuid, NULL, NULL)', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000201')), 'ZD422: invalid input', 'nothing to change');
SELECT is(pg_temp.ask('ana', format('SELECT 1 FROM app.change_work_milestone(%L, %L::uuid, %L, NULL)', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000201', 'X')), 'ZD403: forbidden', 'the student cannot change');
SELECT is(pg_temp.ask('marko', format('SELECT app.delete_work_milestone(%L, %L::uuid)::text', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000201')), 'ZD409: conflict', 'a submitted milestone cannot be deleted');
SELECT is(pg_temp.ask('ana', format('SELECT app.delete_work_milestone(%L, %L::uuid)::text', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000202')), 'ZD403: forbidden', 'the student cannot delete');
SELECT is(pg_temp.ask('marko', format('SELECT app.delete_work_milestone(%L, %L::uuid)::text', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000202')), '', 'the mentor deletes a milestone never submitted');
SELECT is(pg_temp.states('ana'), 'approved:true', 'one milestone is left');

-- A course teacher is no mentor: no transition, no rename.
SELECT is(pg_temp.ask('vesna', format('SELECT 1 FROM app.approve_work_milestone(%L, %L::uuid, NULL)', 'doc-a', '00000000-0000-4000-8000-000000000203')), 'ZD403: forbidden', 'a course teacher cannot approve');
SELECT is(pg_temp.ask('vesna', format('SELECT 1 FROM app.change_work_milestone(%L, %L::uuid, %L, NULL)', 'doc-a', '00000000-0000-4000-8000-000000000203', 'Nova')), 'ZD409: conflict', 'a course assignment keeps its title');
SELECT is(pg_temp.ask('vesna', format('SELECT 1 FROM app.delete_work_milestone(%L, %L::uuid)', 'doc-a', '00000000-0000-4000-8000-000000000203')), 'ZD403: forbidden', 'a course teacher cannot delete');
SELECT is(pg_temp.act('ana', 'submit_work_milestone', ', ''00000000-0000-4000-8000-000000000203''::uuid', 'doc-a'), 'submitted|t|0|-|-', 'a student submits a course milestone');

SELECT * FROM finish();
ROLLBACK;
