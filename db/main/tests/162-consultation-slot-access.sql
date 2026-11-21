-- SRV-1104 (Ductus#2051; Val 11, N-12, PO-22): the consultation slots of a
-- work. The student asks for a time, the teacher of the work confirms it or
-- answers with another time, the student accepts that time. Access comes from
-- the relation to the work; a stranger, another institution's person and a
-- person of the wrong role are refused. Every person, course and document
-- below is invented (fixtures/institution.inc; the documents are those of 157).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), repeat('c', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- 1. Catalogue: the table, its RLS and who may call what.
SELECT table_owner_is('institution', 'consultation_slot', 'ductus_identity', 'the owner role owns the slots');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.consultation_slot'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'institution' AND tablename = 'consultation_slot' $$,
  ARRAY['consultation_slot_owner ALL to ductus_identity'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may use ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_app')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.consultation_slots(text)',
                             'institution.request_consultation_slot(text,timestamptz)',
                             'institution.act_on_consultation_slot(text,uuid,text,timestamptz)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role and the owner execute the RPCs');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'public']) r
      WHERE has_table_privilege(r, 'institution.consultation_slot', 'SELECT,INSERT,UPDATE,DELETE') $$,
  'the web role has no privilege on the table');

-- 2. The student asks for a time (requested); nobody else may.
INSERT INTO ref SELECT 's1', pg_temp.ask('ana',
  $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '3 days') $$);
SELECT matches((SELECT val FROM ref WHERE name = 's1'), '^[0-9a-f-]{36}$', 'Ana asks for a consultation slot on her work');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.consultation_slots('doc-a') WHERE id = {s1} $$),
  'requested', 'the new slot is requested');
SELECT is(pg_temp.ask(a.name, $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '3 days') $$),
  'ZD403: forbidden', a.name || ' cannot ask for a slot on Ana''s work')
FROM (VALUES ('vesna'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-nema', now() + interval '3 days') $$),
  'ZD403: forbidden', 'a missing work reads as a forbidden one');
SELECT is(pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-b', now() + interval '3 days') $$),
  'ZD403: forbidden', 'a work of another institution reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '3 days') $$),
  '^ZD401', 'asking with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() - interval '1 day') $$),
  'ZD422: invalid input', 'a time in the past is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '2 years') $$),
  'ZD422: invalid input', 'a time more than a year ahead is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', NULL) $$),
  'ZD422: invalid input', 'no time is refused');

-- 3. Reading: the student of the work and the teacher of its assignment.
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM institution.consultation_slots('doc-a') $$), '1',
  a.name || ' reads the slots of Ana''s work')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM institution.consultation_slots('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no slot of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM institution.consultation_slots('doc-a') $$), '^ZD401',
  'no session reads no slot');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.consultation_slots('doc-b') $$), 'ZD403: forbidden',
  'a teacher reads no slot of another institution''s work');

-- 4. A person of the wrong role: the student cannot confirm or counter, the
-- teacher cannot accept.
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm') $$),
  'ZD403: forbidden', 'the student cannot confirm her own request');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'counter', now() + interval '4 days') $$),
  'ZD403: forbidden', 'the student cannot counter');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'accept') $$),
  'ZD403: forbidden', 'the teacher cannot accept');
SELECT is(pg_temp.ask(a.name, $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm') $$),
  'ZD403: forbidden', a.name || ' cannot confirm a slot of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-b', {s1}, 'confirm') $$),
  'ZD403: forbidden', 'a slot named through another work reads as none');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'confirm') $$),
  'ZD403: forbidden', 'an unknown slot reads as a forbidden one');
SELECT matches(pg_temp.ask('anon', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm') $$), '^ZD401',
  'no session acts on no slot');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'cancel') $$),
  'ZD422: invalid input', 'an unknown action is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'counter') $$),
  'ZD422: invalid input', 'a counter proposal needs a time');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm', now() + interval '4 days') $$),
  'ZD422: invalid input', 'a confirmation takes no time');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'counter', now() - interval '1 day') $$),
  'ZD422: invalid input', 'a counter proposal in the past is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.consultation_slots('doc-a') WHERE id = {s1} $$), 'requested',
  'nothing above moved the slot');

-- 5. The teacher counters, the student accepts.
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'accept') $$),
  'ZD403: forbidden', 'a requested slot has no counter proposal to accept (and the teacher does not accept)');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'accept') $$),
  'ZD409: not allowed', 'the student cannot accept a slot nobody countered');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'counter', now() + interval '5 days') $$),
  'countered', 'the teacher answers with another time');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm') $$),
  'ZD409: not allowed', 'a countered slot is not confirmed by the teacher');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'counter', now() + interval '6 days') $$),
  'ZD409: not allowed', 'a countered slot is not countered again');
SELECT is(pg_temp.ask('ana', $$ SELECT (starts_at > now() + interval '4 days')::text FROM institution.consultation_slots('doc-a') WHERE id = {s1} $$),
  'true', 'the student reads the teacher''s time');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'accept') $$),
  'confirmed', 'the student accepts the proposed time');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'accept') $$),
  'ZD409: not allowed', 'a confirmed slot is not accepted again');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm') $$),
  'ZD409: not allowed', 'a confirmed slot is not confirmed again');

-- 6. The teacher confirms a requested time as it is.
INSERT INTO ref SELECT 's2', pg_temp.ask('ana',
  $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '7 days') $$);
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s2}, 'confirm') $$),
  'confirmed', 'the teacher confirms the requested time');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(state, ',' ORDER BY starts_at) FROM institution.consultation_slots('doc-a') $$),
  'confirmed,confirmed', 'both slots are listed by time');

-- 7. The bound: at most 20 slots not yet confirmed.
DO $$
BEGIN
  FOR i IN 1..20 LOOP
    PERFORM pg_temp.ask('ana', format($q$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '%s hours') $q$, 100 + i));
  END LOOP;
END $$;
SELECT is(pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '200 hours') $$),
  'ZD422: invalid input', 'a work holds at most 20 slots not yet confirmed');

-- 8. The row.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, student_id FROM institution.consultation_slot WHERE id = pg_temp.id('s1') $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana')),
  'the slot takes its scope from the work and the student from the session');

SELECT * FROM finish();
ROLLBACK;
