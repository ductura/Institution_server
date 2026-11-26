-- SRV-V16-POPIS-FAKULTET: the administrator reads the theses of the faculty.
-- Personas of mentorship.inc, all invented: ms1 Marko mentors Ana (master
-- thesis, she opens the work), ms2 Vesna mentored Dora (ended), ms3 Nina
-- mentors Boris; Iva is the administrator of fak-a, Lea of fak-b (no works).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- The reader is an RPC only; nothing new is a table.
SELECT ok(NOT has_function_privilege(r, 'app.read_thesis_overview(text,integer,boolean,timestamptz,uuid)', 'EXECUTE'),
  r || ' cannot call the overview')
  FROM (VALUES ('ductus_worker'), ('ductus_evidence'), ('public')) AS x(r);
SELECT ok(has_function_privilege('ductus_app', 'app.read_thesis_overview(text,integer,boolean,timestamptz,uuid)', 'EXECUTE'),
  'the web role calls the overview');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.proname = 'read_thesis_overview'
            AND (pg_get_functiondef(p.oid) ~* 'insert into|update |delete from')), 0, 'the overview writes nowhere');

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
VALUES (pg_temp.id('marko'), pg_temp.id('fak_a'), 'Marko', 'Izmišljenić'),
       (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljanić'),
       (pg_temp.id('ana'), pg_temp.id('fak_a'), 'Ana', 'Izmišljenka'),
       (pg_temp.id('dora'), pg_temp.id('fak_a'), 'Dora', 'Izmišljenka');

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 8),
  'opened', 'Ana opens her mentored work');

-- One line per work: student, mentor, stage, defence date, topic, committee size, document or not.
CREATE FUNCTION pg_temp.overview(p_actor text, p_stage text DEFAULT NULL, p_limit integer DEFAULT 50,
                                 p_set boolean DEFAULT false, p_def timestamptz DEFAULT NULL, p_id uuid DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT coalesce(string_agg(coalesce(student_given_name, '-') || '/' || coalesce(mentor_given_name, '-') || '/' || stage
             || '/' || coalesce(to_char(defense_at AT TIME ZONE 'UTC', 'MM-DD'), '-') || '/' || topic_state
             || '/' || committee_size || '/' || (document_id IS NOT NULL), ',' ORDER BY n), 'empty')
      FROM (SELECT x.*, row_number() OVER () AS n
              FROM app.read_thesis_overview(%L, %s, %L, %L, %L) x) y $q$, p_stage, p_limit, p_set, p_def, p_id))
$$;

-- Only the administrator reads; anyone else with a session is 403, no session 401.
SELECT is(pg_temp.overview(a), 'ZD403: forbidden', a || ' is no administrator')
  FROM (VALUES ('ana'), ('marko'), ('vesna'), ('dora'), ('petra')) AS t(a);
SELECT is(pg_temp.overview('anon'), 'ZD401: not authenticated', 'reading needs a session');

-- All three mentorships, works with no date in the order of the mentorship id.
SELECT is(pg_temp.overview('iva'),
  'Ana/Marko/none/-/none/0/true,Dora/Vesna/none/-/none/0/false,-/-/none/-/none/0/false', 'Iva reads every work of fak-a');
-- Another faculty sees nothing of it.
SELECT is(pg_temp.overview('lea'), 'empty', 'the administrator of fak-b sees no work of fak-a');

-- Topic, committee and stage show up.
SELECT is(pg_temp.ask('ana', format('SELECT state FROM app.set_work_thesis_topic(%L, %L, %L)', pg_temp.mdoc(), 'Izmišljena tema', 'Kratak opis.')),
  'proposed', 'Ana proposes a topic');
SELECT is(pg_temp.overview('iva', 'none', 1), 'Ana/Marko/none/-/proposed/0/true,Dora/Vesna/none/-/none/0/false', 'the topic is proposed');
SELECT is(pg_temp.ask('marko', format('SELECT state FROM app.decide_work_thesis_topic(%L, 1, %L, NULL)', pg_temp.mdoc(), 'approved')),
  'approved', 'Marko approves it');
SELECT is(pg_temp.ask('iva', format('SELECT jsonb_array_length(members) FROM app.set_work_thesis_committee(%L, %L::jsonb)', pg_temp.mdoc(),
  jsonb_build_array(jsonb_build_object('userId', pg_temp.id('vesna')::text, 'role', 'chair'),
                    jsonb_build_object('userId', pg_temp.id('marko')::text, 'role', 'member'))::text)), '2', 'Iva names two members');
SELECT is(pg_temp.ask('marko', format('SELECT stage FROM app.set_work_thesis_stage(%L, %L, %L::timestamptz)', pg_temp.mdoc(),
  'defense_scheduled', '2026-12-01T10:00:00Z')), 'defense_scheduled', 'Marko schedules the defence');
SELECT is(pg_temp.overview('iva', 'defense_scheduled'), 'Ana/Marko/defense_scheduled/12-01/approved/2/true', 'the defence shows with topic and committee');
SELECT is(pg_temp.overview('iva', 'none'), 'Dora/Vesna/none/-/none/0/false,-/-/none/-/none/0/false', 'the stage filter keeps the others');
SELECT is(pg_temp.overview('iva', 'defended'), 'empty', 'no work is defended');

-- Paging by key: no work skipped, none repeated, the dated one first.
SELECT is(pg_temp.overview('iva', NULL, 1), 'Ana/Marko/defense_scheduled/12-01/approved/2/true,Dora/Vesna/none/-/none/0/false',
  'limit 1 returns one more row to tell there is a next page');
SELECT is(pg_temp.overview('iva', NULL, 1, true, '2026-12-01T10:00:00Z', pg_temp.id('ms1')),
  'Dora/Vesna/none/-/none/0/false,-/-/none/-/none/0/false', 'after the dated work');
SELECT is(pg_temp.overview('iva', NULL, 1, true, NULL, pg_temp.id('ms2')), '-/-/none/-/none/0/false', 'after the first undated work');
SELECT is(pg_temp.overview('iva', NULL, 1, true, NULL, pg_temp.id('ms3')), 'empty', 'after the last work');

-- The other two stages show too, and a date with microseconds is read to the
-- millisecond, so a key written from it never repeats the work it came from.
SELECT is(pg_temp.ask('marko', format('SELECT stage FROM app.set_work_thesis_stage(%L, %L, NULL)', pg_temp.mdoc(), 'submitted_to_office')),
  'submitted_to_office', 'Marko marks the work as handed to the office');
SELECT is(pg_temp.overview('iva', 'submitted_to_office'), 'Ana/Marko/submitted_to_office/-/approved/2/true', 'the stage submitted_to_office shows');
SELECT is(pg_temp.ask('marko', format('SELECT stage FROM app.set_work_thesis_stage(%L, %L, %L::timestamptz)', pg_temp.mdoc(),
  'defended', '2026-12-02T09:30:00Z')), 'defended', 'Marko marks the work as defended');
SELECT is(pg_temp.overview('iva', 'defended'), 'Ana/Marko/defended/12-02/approved/2/true', 'the stage defended shows');
SELECT is(pg_temp.overview('iva', 'defense_scheduled'), 'empty', 'and leaves defense_scheduled');
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', format(
  'WITH i AS (INSERT INTO institution.work_thesis_stage_event (institution_id, document_id, stage, defense_at, actor_id, actor_part) '
  'VALUES (%L, %L, %L, %L::timestamptz, %L, %L) RETURNING 1) SELECT count(*) FROM i',
  pg_temp.id('fak_a'), pg_temp.mdoc(), 'defended', '2026-12-03 10:00:00.123456+00', pg_temp.id('iva'), 'faculty')), '1', 'a stage with microseconds is written');
SELECT is(pg_temp.overview('iva', NULL, 1), 'Ana/Marko/defended/12-03/approved/2/true,Dora/Vesna/none/-/none/0/false', 'the date with microseconds shows to the day');
SELECT is(pg_temp.overview('iva', NULL, 1, true, '2026-12-03T10:00:00.123Z', pg_temp.id('ms1')),
  'Dora/Vesna/none/-/none/0/false,-/-/none/-/none/0/false', 'the key made of the millisecond date skips exactly that work');

-- Bad input is 422 and writes nothing.
SELECT is(pg_temp.overview('iva', s), 'ZD422: invalid input', 'stage ' || s) FROM (VALUES ('graded'), (''), ('DEFENDED')) AS t(s);
SELECT is(pg_temp.overview('iva', NULL, l), 'ZD422: invalid input', 'limit ' || l) FROM (VALUES (0), (201), (-1)) AS t(l);
SELECT is(pg_temp.ask('iva', 'SELECT count(*) FROM app.read_thesis_overview(NULL, 5, true, NULL, NULL)'), 'ZD422: invalid input',
  'a key with no id');
SELECT is(pg_temp.ask('iva', 'SELECT count(*) FROM app.read_thesis_overview(NULL, 5, NULL, NULL, NULL)'), 'ZD422: invalid input',
  'a missing flag');
SELECT is(pg_temp.ask('iva', 'SELECT count(*) FROM app.read_thesis_overview(NULL, NULL, false, NULL, NULL)'), 'ZD422: invalid input',
  'a missing limit');

SELECT * FROM finish();
ROLLBACK;
