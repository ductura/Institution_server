-- SRV-1315 (Ductus#2052; plan M7.8, R-08): the amendments and disputes of
-- SRV-1314 reached by the document id of a work (20261210140000). The student
-- who owns the work adds; the owner and the readers of the work read; a reader
-- who is not the owner, another student of the course, another institution, a
-- work that does not exist and an id that cannot be one all get ZD403, and a
-- refusal writes nothing. Every person, course and text below is invented
-- (fixtures/institution.inc); the documents are written as the evidence role
-- writes them (as 163).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(48);

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora')),
  ('project-t', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), repeat('d', 64)),
  ('doc-t', pg_temp.id('fak_b'), 'project-t', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-d', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('dora'), repeat('d', 64)),
  ('doc-t', pg_temp.id('fak_b'), 0, NULL, pg_temp.id('tomo'), repeat('c', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- 'ok' for an added record, else the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.add(p_actor text, p_work text, p_text text,
                            p_kind text DEFAULT 'dispute', p_event text DEFAULT 'pastes/0') RETURNS text
LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format('SELECT ''ok'' FROM app.add_work_event_dispute(%L, %L, %L, %L)',
                                            p_work, p_kind, p_event, p_text)), 1, 5)
$$;
-- The records by kind, then text (one transaction has one now()), joined with '|', or the SQLSTATE.
CREATE FUNCTION pg_temp.records(p_actor text, p_work text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT coalesce(string_agg(kind || '':'' || event_id || '':'' || text, ''|'' ORDER BY kind, text), ''-'') '
      'FROM app.work_event_disputes(%L)', p_work)) AS r) x
$$;

-- 1. Catalogue: owner, definer, empty search_path; only the web role executes.
SELECT is(
  (SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text
                     || ':' || coalesce('search_path=""' = ANY (p.proconfig), false)::text, ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
      AND p.proname IN ('add_work_event_dispute', 'work_event_disputes')),
  'add_work_event_dispute:ductus_identity:true:true,work_event_disputes:ductus_identity:true:true',
  'both belong to the identity role, definers with an empty search_path'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.add_work_event_dispute(text,text,text,text)', 'app.work_event_disputes(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only ductus_app and the owner execute them'
);

-- 2. Who adds: the owner of the work only.
SELECT is(pg_temp.add(c.actor, c.work, 'Osporavam: ' || c.actor), c.outcome,
  format('%s disputes an event of %s: %s', c.actor, c.work, c.outcome))
FROM (VALUES
  ('ana', 'doc-a', 'ok'), ('dora', 'doc-d', 'ok'), ('tomo', 'doc-t', 'ok'),
  ('dora', 'doc-a', 'ZD403'), ('ana', 'doc-d', 'ZD403'), ('vesna', 'doc-a', 'ZD403'), ('marko', 'doc-a', 'ZD403'),
  ('nina', 'doc-a', 'ZD403'), ('tomo', 'doc-a', 'ZD403'), ('petra', 'doc-t', 'ZD403'), ('ana', 'doc-t', 'ZD403'),
  ('ana', 'no-such-work', 'ZD403'), ('ana', '', 'ZD403'), ('ana', ' doc-a', 'ZD403'),
  ('anon', 'doc-a', 'ZD401'), ('expired', 'doc-a', 'ZD401'), ('closed', 'doc-a', 'ZD401')
) AS c (actor, work, outcome);
SELECT is((SELECT count(*) FROM evidence.event_dispute), 3::bigint, 'three records, one per accepted call');
SELECT results_eq(
  $$ SELECT p.name, d.assignment_id, d.institution_id FROM evidence.event_dispute d JOIN person p ON p.id = d.student_id
      ORDER BY p.name $$,
  $$ VALUES ('ana', pg_temp.id('z1'), pg_temp.id('fak_a')), ('dora', pg_temp.id('z1'), pg_temp.id('fak_a')),
            ('tomo', pg_temp.id('z3'), pg_temp.id('fak_b')) $$,
  'each record carries the owner and the assignment of the work'
);

-- 3. The input is checked before the work: a refusal of it says nothing of the work.
SELECT is(pg_temp.add('ana', 'doc-a', t.v, t.k, t.e), t.outcome, t.label)
FROM (VALUES
  ('', 'dispute', 'pastes/0', 'ZD422', 'an empty text'),
  (repeat('a', 1001), 'dispute', 'pastes/0', 'ZD422', '1001 characters'),
  ('Opis', 'note', 'pastes/0', 'ZD422', 'an unknown kind'),
  ('Opis', 'dispute', 'Pastes/0', 'ZD422', 'an event id in upper case'),
  ('Dopuna', 'amendment', 'sessions/1', 'ok', 'an amendment')
) AS t (v, k, e, outcome, label);
SELECT is(pg_temp.add('dora', 'doc-a', '', 'dispute', 'pastes/0'), 'ZD422', 'bad input of a work that is not hers is ZD422 as of her own');
SELECT is(pg_temp.add('ana', 'no-such-work', ''), 'ZD422', 'bad input of a work that does not exist is ZD422');

-- Readers: Marko teaches Ana's seminar group, Nina collaborates on the course (as 186).
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok', 'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok', 'fixture: Ana joins G1');
INSERT INTO identity.teacher_eligibility (user_id, institution_id) VALUES (pg_temp.id('nina'), pg_temp.id('fak_a'));
SELECT is(pg_temp.ask('iva', $$ SELECT 'ok' FROM institution.confirm_teacher_role({nina}) $$), 'ok', 'fixture: Iva confirms Nina');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
  VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('nina'), 'teacher');

-- 4. Who reads: the owner and the readers of the work; nobody else.
SELECT is(pg_temp.records('ana', 'doc-a'), 'amendment:sessions/1:Dopuna|dispute:pastes/0:Osporavam: ana', 'Ana reads the records of her work');
SELECT is(pg_temp.records(c.actor, 'doc-a'), (SELECT pg_temp.records('ana', 'doc-a')), c.actor || ' reads the records of Ana''s work')
FROM (VALUES ('vesna'), ('marko'), ('nina')) AS c (actor);
SELECT is(pg_temp.records(c.actor, c.work), c.outcome, format('%s reads the records of %s: %s', c.actor, c.work, c.outcome))
FROM (VALUES
  ('dora', 'doc-a', 'ZD403'), ('marko', 'doc-d', 'ZD403'), ('tomo', 'doc-a', 'ZD403'), ('iva', 'doc-a', 'ZD403'),
  ('vesna', 'doc-t', 'ZD403'), ('ana', 'doc-t', 'ZD403'), ('ana', 'no-such-work', 'ZD403'), ('ana', '', 'ZD403'),
  ('petra', 'doc-t', 'dispute:pastes/0:Osporavam: tomo'), ('anon', 'doc-a', 'ZD401'), ('expired', 'doc-a', 'ZD401')
) AS c (actor, work, outcome);

-- 5. A refusal wrote nothing, and a read writes nothing.
SELECT is((SELECT count(*) FROM evidence.event_dispute), 4::bigint, 'four records in all: the refusals and the reads wrote none');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'reading the records writes no row of the access log');

SELECT * FROM finish();
ROLLBACK;
