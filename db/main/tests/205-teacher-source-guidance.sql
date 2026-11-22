-- SRV-1605 (Ductus#2052; WEB-2133): the guidance of a teacher on sources
-- (20261213100500): the recommendation of a source on a work, the required
-- literature of a course, the request for a proof of a source with a deadline,
-- the mark that the literature of a work was reviewed, and the proofs a teacher
-- reads. The access matrix: only the holder of the course (and the mentor of a
-- mentorship work) writes; a collaborator and every other reader only read; the
-- student of the work sees the recommendations, the required literature and the
-- requests of the own work; everybody else gets ZD403, no session ZD401. No
-- table is reachable but through the RPCs. All people are the invented ones of
-- the shared fixture: Vesna holds K1, Marko is a second teacher of K1 (a
-- collaborator), Ana and Dora are its students, Marko mentors Ana's thesis.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
-- evidence-acceptance.inc leaves every constraint IMMEDIATE; mentorship.inc writes
-- an assignment before its first version, so defer that key for the fixture.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

CREATE FUNCTION pg_temp.rec(p_n integer, p_title text DEFAULT 'Izmišljena knjiga') RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', '00000000-0000-4000-8000-00000000' || lpad(p_n::text, 4, '0'),
    'type', 'book', 'authors', jsonb_build_array(jsonb_build_object('kind', 'person', 'family', 'Horvat', 'given', 'Ivan')),
    'year', 2020, 'title', p_title, 'place', 'Zagreb', 'publisher', 'Izmišljeni izdavač')::text
$$;
CREATE FUNCTION pg_temp.sid(p_n integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-4000-8000-00000000' || lpad(p_n::text, 4, '0') $$;

-- Setup: Vesna holds K1; Marko is another teacher of K1.
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.set_course_holder({k1}, {vesna}) $$), 'ok', 'setup: Vesna holds K1');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');

-- 1. Catalogue.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'institution' AND p.tablename = t.rel) = 1,
  'institution.' || t.rel || ': forced RLS, the identity owner and no privilege for another role')
FROM (VALUES ('course_required_source'), ('source_proof_request'), ('work_literature_seen')) AS t (rel)
JOIN pg_class c ON c.oid = ('institution.' || t.rel)::regclass;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.teacher_source_guidance(text)', 'app.teacher_source_recommend(text,jsonb,text,text,text,boolean)',
       'app.teacher_source_unrecommend(text,uuid)', 'app.teacher_proof_request_put(text,uuid,text,timestamp with time zone)',
       'app.teacher_proof_request_close(text,uuid)', 'app.teacher_literature_seen_put(text)', 'app.student_proof_requests(uuid)',
       'app.course_literature_read(uuid)', 'app.course_literature_put(uuid,jsonb,text,text,boolean)',
       'app.course_literature_delete(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
             AND rolname <> 'ductus_identity' UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.guidance_work_role(uuid,uuid)', 'institution.guidance_course_role(uuid)',
       'institution.guidance_work_of(text,boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the relation checks are the owner''s alone');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_identity', 'institution', 'CREATE'),
  'after the migration no role keeps CREATE on the schemas');

-- 2. Reading the guidance of a work: readers read, the owner and others do not.
SELECT is(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-a')->>'canWrite' $$), 'true', 'the holder reads and may write');
SELECT is(pg_temp.ask('marko', $$ SELECT app.teacher_source_guidance('doc-a')->>'canWrite' $$), 'false', 'a collaborator reads and may not write');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-a')->>'sources' $$), '[]', 'a work with no sources has none');
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.teacher_source_guidance('doc-a') $$), '^ZD403', a.name || ' does not read the guidance of Ana''s work')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('nina'), ('iva'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-nema') $$), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-b') $$), '^ZD403', 'another institution''s document: ZD403');
SELECT matches(pg_temp.ask(t.name, $$ SELECT app.teacher_source_guidance('doc-a') $$), '^ZD401', 'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 3. s2Rec / s2RecDel: the recommendation of a source on the work.
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, 'recommended')->>'requirement' $q$, pg_temp.rec(1))),
  'recommended', 'the holder recommends a source');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, 'required', '10.1000/izmisljeno-1')->>'requirement' $q$, pg_temp.rec(1))),
  'required', 'the same id again changes it');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.work_sources({z1}, {ana}) $$), '1', 'and it is still one source');
SELECT matches(pg_temp.ask(a.name, format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, 'recommended') $q$, pg_temp.rec(2))), '^ZD403',
  a.name || ' does not recommend a source')
FROM (VALUES ('marko'), ('ana'), ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('anon', format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, 'recommended') $q$, pg_temp.rec(2))), '^ZD401', 'no session writes nothing');
SELECT matches(pg_temp.ask('vesna', v.statement), '^ZD422', v.what)
FROM (VALUES
  ('a requirement outside the list', format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, 'optional') $q$, pg_temp.rec(2))),
  ('a null requirement', format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, NULL) $q$, pg_temp.rec(2))),
  ('a record that is not an object', $$ SELECT app.teacher_source_recommend('doc-a', '[]'::jsonb, 'recommended') $$),
  ('a record with no title', $$ SELECT app.teacher_source_recommend('doc-a', '{"id":"00000000-0000-4000-8000-000000000002","type":"book"}'::jsonb, 'recommended') $$),
  ('a DOI in capitals', format($q$ SELECT app.teacher_source_recommend('doc-a', %L::jsonb, 'recommended', '10.1000/ABC') $q$, pg_temp.rec(2)))
) AS v (what, statement);
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(requirement, ',') FROM institution.work_sources({z1}, NULL) $$), 'required',
  'the student of the work sees the recommendation (the work source list)');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-a')->'sources'->0->>'proofCount' $$), '0', 'the guidance counts the proofs of a source');
SELECT is(pg_temp.ask('marko', $$ SELECT app.teacher_source_guidance('doc-a')->'sources'->0->>'requirement' $$), 'required', 'a collaborator reads it');

-- 4. s2Req / s2ReqDel: the request for a proof, with an instruction and a deadline.
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Priložite stranicu 14.', now() + interval '7 days')->>'closedAt' $q$, pg_temp.sid(1))),
  NULL, 'the holder sets a request (open: closedAt is null)');
SELECT is((SELECT count(*) FROM institution.source_proof_request), 1::bigint, 'one request exists');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Priložite stranicu 15.', now() + interval '9 days')->>'instruction' $q$, pg_temp.sid(1))),
  'Priložite stranicu 15.', 'setting it again changes the open request');
SELECT is((SELECT count(*) FROM institution.source_proof_request), 1::bigint, 'and it is still one');
SELECT matches(pg_temp.ask(a.name, format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Upute.', now() + interval '7 days') $q$, pg_temp.sid(1))), '^ZD403',
  a.name || ' does not set a request')
FROM (VALUES ('marko'), ('ana'), ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('vesna', v.statement), '^ZD422', v.what)
FROM (VALUES
  ('a deadline in the past', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Upute.', now() - interval '1 day') $q$, pg_temp.sid(1))),
  ('no deadline', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Upute.', NULL) $q$, pg_temp.sid(1))),
  ('an empty instruction', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, '', now() + interval '1 day') $q$, pg_temp.sid(1))),
  ('an instruction with a control character', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Up' || chr(7) || 'ute', now() + interval '1 day') $q$, pg_temp.sid(1))),
  ('an instruction of 1001 characters', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, repeat('a', 1001), now() + interval '1 day') $q$, pg_temp.sid(1)))
) AS v (what, statement);
SELECT matches(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Upute.', now() + interval '1 day') $q$, pg_temp.sid(77))), '^ZD403',
  'a source that is not in the work: ZD403');
SELECT is(pg_temp.ask('ana', $$ SELECT jsonb_array_length(app.student_proof_requests({z1})->'proofRequests') $$), '1', 'the student of the work sees the request');
SELECT is(pg_temp.ask('dora', $$ SELECT jsonb_array_length(app.student_proof_requests({z1})->'proofRequests') $$), '0',
  'another student sees none of Ana''s: their own work has none');
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.student_proof_requests({z1}) $$), '^ZD403', a.name || ' is no student of the work')
FROM (VALUES ('vesna'), ('marko'), ('boris'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT app.student_proof_requests({z1}) $$), '^ZD401', 'no session: ZD401');
SELECT throws_ok(format($q$ INSERT INTO institution.source_proof_request (institution_id, assignment_id, student_id, source_id, instruction, due_at, requested_by)
    VALUES (%L, %L, %L, %L, 'Drugi.', now() + interval '1 day', %L) $q$, pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.sid(1), pg_temp.id('vesna')),
  '23505', NULL, 'a source has at most one open request');
SELECT matches(pg_temp.ask('marko', format($q$ SELECT app.teacher_proof_request_close('doc-a', %L) $q$, pg_temp.sid(1))), '^ZD403', 'a collaborator does not close a request');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_close('doc-a', %L) $q$, pg_temp.sid(1))), 'true', 'the holder closes it');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_close('doc-a', %L) $q$, pg_temp.sid(1))), 'false', 'closing it again changes nothing');
SELECT is((SELECT count(*) FROM institution.source_proof_request WHERE closed_at IS NOT NULL AND closed_by = pg_temp.id('vesna')), 1::bigint,
  'the closed request stays, with who closed it');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Nova molba.', now() + interval '3 days')->>'closedAt' $q$, pg_temp.sid(1))),
  NULL, 'after closing a new request can be set');
SELECT is((SELECT count(*) FROM institution.source_proof_request), 2::bigint, 'and the history keeps both');

-- 5. The proofs a teacher reads (20261121130000): Ana attaches a proof to the source.
SELECT is(pg_temp.ask('ana', format($q$ SELECT count(*) FROM institution.add_source_proof({z1}, %L, '14', 'Bilješka.', '\xffd8ffd9'::bytea) $q$, pg_temp.sid(1))),
  '1', 'the student attaches a proof to the recommended source');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT count(*) FROM institution.source_proofs({z1}, %L, {ana}) $q$, pg_temp.sid(1))), '1', 'the holder reads the proofs');
SELECT is(pg_temp.ask('marko', format($q$ SELECT count(*) FROM institution.source_proofs({z1}, %L, {ana}) $q$, pg_temp.sid(1))), '1', 'a collaborator reads them');
SELECT matches(pg_temp.ask('dora', format($q$ SELECT count(*) FROM institution.source_proofs({z1}, %L, {ana}) $q$, pg_temp.sid(1))), '^ZD403', 'another student does not');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-a')->'sources'->0->>'proofCount' $$), '1', 'the guidance counts the proof');

-- 6. litSeen: the mark that the literature of the work was reviewed.
SELECT is(pg_temp.ask('vesna', $$ SELECT app.teacher_source_guidance('doc-a')->>'literatureSeenAt' $$), NULL, 'no mark yet');
SELECT matches(pg_temp.ask('vesna', $$ SELECT app.teacher_literature_seen_put('doc-a') $$), '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$', 'the holder marks the literature as reviewed');
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.teacher_literature_seen_put('doc-a') $$), '^ZD403', a.name || ' does not mark it')
FROM (VALUES ('marko'), ('ana'), ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT app.teacher_literature_seen_put('doc-a') $$), '^ZD401', 'no session: ZD401');
SELECT matches(pg_temp.ask('marko', $$ SELECT app.teacher_source_guidance('doc-a')->>'literatureSeenAt' $$), '^\d{4}-', 'a collaborator reads the mark');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.teacher_literature_seen_put('doc-a') IS NOT NULL $$), 'true', 'a later mark replaces the earlier one');
SELECT is((SELECT count(*) FROM institution.work_literature_seen), 1::bigint, 'one row per work');

-- 7. Removing a source removes its requests (no cascades).
SELECT matches(pg_temp.ask('marko', format($q$ SELECT app.teacher_source_unrecommend('doc-a', %L) $q$, pg_temp.sid(1))), '^ZD403', 'a collaborator does not remove it');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_source_unrecommend('doc-a', %L) $q$, pg_temp.sid(1))), 'true', 'the holder removes the recommendation');
SELECT is((SELECT count(*) FROM institution.source_proof_request), 0::bigint, 'with its requests');
SELECT is((SELECT count(*) FROM institution.source_proof), 0::bigint, 'and its proofs');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_source_unrecommend('doc-a', %L) $q$, pg_temp.sid(1))), 'false', 'removing it again changes nothing');
-- A request on a source of the student: the student may remove the source.
SELECT is(pg_temp.ask('ana', format($q$ SELECT count(*) FROM institution.save_work_source({z1}, %L::jsonb) $q$, pg_temp.rec(9))), '1', 'Ana adds an own source');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.teacher_proof_request_put('doc-a', %L, 'Priložite izvadak.', now() + interval '2 days')->>'sourceId' $q$, pg_temp.sid(9))),
  pg_temp.sid(9), 'the holder asks for a proof of the student''s own source');
SELECT is(pg_temp.ask('ana', format($q$ SELECT institution.delete_work_source({z1}, %L) $q$, pg_temp.sid(9))), 'true', 'Ana removes the source');
SELECT is((SELECT count(*) FROM institution.source_proof_request), 0::bigint, 'and the request goes with it');

-- 8. s2ObNew / s2ObDel: the required literature of a course.
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, '10.1000/izmisljeno-2', '9780306406157')->>'id' $q$, pg_temp.rec(21))),
  pg_temp.sid(21), 'the holder adds a required source');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, '10.1000/izmisljeno-2', '9780306406157')->>'id' $q$, pg_temp.rec(21, 'Izmijenjeni naslov'))),
  pg_temp.sid(21), 'the same id again changes it');
SELECT is((SELECT count(*) FROM institution.course_required_source), 1::bigint, 'and it is still one');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb)->>'doi' $q$, pg_temp.rec(22))), NULL, 'a source with no DOI is allowed');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb)->>'doi' $q$, pg_temp.rec(23))), NULL, 'and so are two of them');
SELECT matches(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, '10.1000/izmisljeno-2') $q$, pg_temp.rec(24))), '^ZD409',
  'the same DOI under another id: ZD409');
SELECT matches(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, NULL, '9780306406157') $q$, pg_temp.rec(24))), '^ZD409',
  'the same ISBN under another id: ZD409');
SELECT throws_ok(format($q$ INSERT INTO institution.course_required_source (institution_id, course_id, id, record, doi, added_by)
    VALUES (%L, %L, %L, %L::jsonb, '10.1000/izmisljeno-2', %L) $q$, pg_temp.id('fak_a'), pg_temp.id('k1'), pg_temp.sid(25), pg_temp.rec(25), pg_temp.id('vesna')),
  '23505', NULL, 'the table holds a DOI once per course');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, '10.1000/izmisljeno-2')->>'id' $q$, pg_temp.rec(21))), pg_temp.sid(21),
  'the source itself may keep its DOI');
SELECT matches(pg_temp.ask('vesna', v.statement), '^ZD422', v.what)
FROM (VALUES
  ('a record that is not an object', $$ SELECT app.course_literature_put({k1}, '[]'::jsonb) $$),
  ('a record with no title', $$ SELECT app.course_literature_put({k1}, '{"id":"00000000-0000-4000-8000-000000000026","type":"book"}'::jsonb) $$),
  ('an ISBN that is not digits', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, NULL, 'abc') $q$, pg_temp.rec(26))),
  ('a null undated flag', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb, NULL, NULL, NULL) $q$, pg_temp.rec(26)))
) AS v (what, statement);
SELECT matches(pg_temp.ask(a.name, format($q$ SELECT app.course_literature_put({k1}, %L::jsonb) $q$, pg_temp.rec(27))), '^ZD403', a.name || ' does not add a required source')
FROM (VALUES ('marko'), ('ana'), ('dora'), ('boris'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k3}, %L::jsonb) $q$, pg_temp.rec(27))), '^ZD403', 'the holder of K1 does not write in K3');
SELECT matches(pg_temp.ask('anon', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb) $q$, pg_temp.rec(27))), '^ZD401', 'no session writes nothing');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.course_literature_read({k1})->>'canWrite' $$), 'true', 'the holder reads and may write');
SELECT is(pg_temp.ask('marko', $$ SELECT jsonb_array_length(app.course_literature_read({k1})->'sources') $$), '3', 'a collaborator reads the three sources');
SELECT is(pg_temp.ask('marko', $$ SELECT app.course_literature_read({k1})->>'canWrite' $$), 'false', 'and may not write');
SELECT is(pg_temp.ask(s.name, $$ SELECT jsonb_array_length(app.course_literature_read({k1})->'sources') || '/' || (app.course_literature_read({k1})->>'canWrite') $$), '3/false',
  'the student ' || s.name || ' of the course sees the required literature')
FROM (VALUES ('ana'), ('dora')) AS s (name);
SELECT matches(pg_temp.ask(a.name, $$ SELECT app.course_literature_read({k1}) $$), '^ZD403', a.name || ' does not read the literature of K1')
FROM (VALUES ('boris'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask('ana', $$ SELECT app.course_literature_read({k3}) $$), '^ZD403', 'a student of K1 does not read K3');
SELECT matches(pg_temp.ask('anon', $$ SELECT app.course_literature_read({k1}) $$), '^ZD401', 'no session: ZD401');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.course_literature_read({k1})->'sources'->0->>'title' $$), NULL, 'a source is a record, not a flat row');
SELECT matches(pg_temp.ask('marko', format($q$ SELECT app.course_literature_delete({k1}, %L) $q$, pg_temp.sid(21))), '^ZD403', 'a collaborator does not remove one');
SELECT matches(pg_temp.ask('ana', format($q$ SELECT app.course_literature_delete({k1}, %L) $q$, pg_temp.sid(21))), '^ZD403', 'a student does not remove one');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_delete({k1}, %L) $q$, pg_temp.sid(21))), 'true', 'the holder removes one');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_delete({k1}, %L) $q$, pg_temp.sid(21))), 'false', 'removing it again changes nothing');
SELECT is((SELECT count(*) FROM institution.course_required_source), 2::bigint, 'two remain');

-- 9. The bound: a course holds at most 200 required sources.
INSERT INTO institution.course_required_source (institution_id, course_id, id, record, added_by)
SELECT pg_temp.id('fak_a'), pg_temp.id('k1'), pg_temp.sid(n)::uuid, pg_temp.rec(n)::jsonb, pg_temp.id('vesna')
FROM generate_series(100, 297) AS n;
SELECT is((SELECT count(*) FROM institution.course_required_source), 200::bigint, 'the course is at its bound');
SELECT matches(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb) $q$, pg_temp.rec(28))), '^ZD422', 'one more is refused');
SELECT is(pg_temp.ask('vesna', format($q$ SELECT app.course_literature_put({k1}, %L::jsonb)->>'id' $q$, pg_temp.rec(100, 'Izmijenjeno'))), pg_temp.sid(100),
  'but a source already there can still be changed');

-- 10. The mentor of a mentorship work writes, a collaborator reads (the relation behind the RPCs).
SELECT is(pg_temp.ask_as('ductus_identity', 'marko', $$ SELECT institution.guidance_work_role({zm1}, {ana}) $$), 'writer', 'the mentor of Ana''s thesis may write');
SELECT is(pg_temp.ask_as('ductus_identity', 'vesna', $$ SELECT institution.guidance_work_role({z1}, {ana}) $$), 'writer', 'the holder of K1 may write on Ana''s work');
SELECT is(pg_temp.ask_as('ductus_identity', 'marko', $$ SELECT institution.guidance_work_role({z1}, {ana}) $$), 'reader', 'a collaborator of K1 only reads');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ SELECT institution.guidance_work_role({z1}, {ana}) $$), NULL, 'the student of the work has no teacher relation');
SELECT is(pg_temp.ask_as('ductus_identity', 'petra', $$ SELECT institution.guidance_work_role({z1}, {ana}) $$), NULL, 'another institution''s teacher has none');
SELECT is(pg_temp.ask_as('ductus_identity', 'vesna', $$ SELECT institution.guidance_work_role({zm1}, {ana}) $$), NULL, 'a teacher of K1 has none on a mentorship work of another mentor');

SELECT * FROM finish();
ROLLBACK;
