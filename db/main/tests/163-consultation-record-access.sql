-- SRV-1105 (wave 11, N-12, D-47, PO-22): the shared consultation record and
-- its additions (20261121103000). The teacher of the work and the student who
-- owns it read the same record; since SRV-MENTOR-1 (decision (1) of 23 Nov
-- 2026, MK-5) only the teacher of the work writes it, the student reads. The
-- teacher of another course, a
-- student of another work and another institution read a missing work. Every
-- person, course and text below is invented; the documents are those of 050.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- One document of Ana on Z1 (fak-a) and one of Tomo on Z3 (fak-b), with a
-- revision, a package and a segment each, as the evidence role writes them.
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
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-a', pg_temp.id('fak_a'), 2, 1, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, NULL, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 1, 0, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 2, 1, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 3, 2, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 4, 3, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 5, 4, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 6, 5, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 7, 6, pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.package (
  id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id, max_payload_bytes
) VALUES
  ('pkg-a', pg_temp.id('fak_a'), '00000000-0000-4000-8000-0000000000d1', 'doc-a', 'project-a', pg_temp.id('ana'), 'standard-v1', 2097152);
INSERT INTO evidence.segment (
  id, evidence_package_id, institution_id, document_id, principal_id, session_id, sequence_from, sequence_to,
  event_count, descriptor, segment_hash, payload_bytes, storage_ref, accepted_at
) VALUES
  ('segment-a', 'pkg-a', pg_temp.id('fak_a'), 'doc-a', pg_temp.id('ana'), 'synthetic-session-a', 1, 1, 1,
   jsonb_build_object('segmentHash', repeat('b', 64), 'payloadBytes', 123), repeat('b', 64), 123,
   'synthetic://pkg-a/segment-a', now());
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- Catalogue: the tables have forced RLS, the web role no right on them, and
-- only the web role executes the three functions.
SELECT bag_eq($$ SELECT c.relname::text FROM pg_class c
    WHERE c.relnamespace = 'collaboration'::regnamespace AND c.relname LIKE 'consultation\_%' AND c.relkind = 'r'
      AND c.relrowsecurity AND c.relforcerowsecurity $$,
  $$ VALUES ('consultation_record'), ('consultation_addition'), ('consultation_task'), ('consultation_task_mark') $$,
  'the record tables and the task tables of 232 have forced row level security');
SELECT is((SELECT count(*)::integer FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence'])
    AS r, unnest(ARRAY['collaboration.consultation_record', 'collaboration.consultation_addition']) AS t
    WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE')), 0, 'no role but the identity role has a right on the tables');
SELECT bag_eq($$ SELECT f::text FROM unnest(ARRAY['collaboration.list_consultation_records(text)',
      'collaboration.create_consultation_record(text,date,bigint,text,text)',
      'collaboration.add_consultation_addition(text,uuid,text)']) AS f
    WHERE has_function_privilege('ductus_app', f::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('ductus_worker', f::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('ductus_evidence', f::regprocedure, 'EXECUTE') $$,
  $$ VALUES ('collaboration.list_consultation_records(text)'),
            ('collaboration.create_consultation_record(text,date,bigint,text,text)'),
            ('collaboration.add_consultation_addition(text,uuid,text)') $$,
  'only the web role executes the consultation functions');

-- Creating: the teacher of the work only (SRV-MENTOR-1); the owning student reads.
INSERT INTO ref SELECT 'r1', pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, 'Struktura rada', 'Dodati zaključak do petka.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'r1'), '^[0-9a-f-]{36}$', 'the teacher records a consultation on Ana''s work');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-25', 2, 'Izvori', '') $$), 'ZD403: forbidden',
  'Ana cannot record a consultation on her own work: the mentor writes the record');
INSERT INTO ref SELECT 'r2', pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-25', 2, 'Izvori', '') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'r2'), '^[0-9a-f-]{36}$', 'the teacher records a second one, with an empty agreement');
SELECT is(pg_temp.ask(a.name, $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, 'Tema', 'Dogovor.') $$), 'ZD403: forbidden',
  a.name || ' cannot record a consultation on Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris'), ('nina')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-b', '2026-11-18', 7, 'Tema', 'Dogovor.') $$), 'ZD403: forbidden',
  'a teacher cannot record on a work of another institution');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-nema', '2026-11-18', 1, 'Tema', 'Dogovor.') $$), 'ZD403: forbidden',
  'a missing work reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, 'Tema', 'Dogovor.') $$), '^ZD401',
  'a record with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- Input: an empty or blank topic, a revision that is not this work's, a bad text.
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, '', 'x') $$), 'ZD422: invalid input', 'an empty topic is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, '   ', 'x') $$), 'ZD422: invalid input', 'a blank topic is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, NULL, 'x') $$), 'ZD422: invalid input', 'a missing topic is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, 'x', NULL) $$), 'ZD422: invalid input', 'a missing agreement is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', NULL, 1, 'x', 'x') $$), 'ZD422: invalid input', 'a missing date is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 7, 'x', 'x') $$), 'ZD422: invalid input',
  'a revision of another work (doc-b has 7) is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 9, 'x', 'x') $$), 'ZD422: invalid input', 'a revision the work does not have is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 0, 'x', 'x') $$), 'ZD422: invalid input', 'revision 0 is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, repeat('a', 201), 'x') $$), 'ZD422: invalid input', 'a topic over 200 characters is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, E'a‮b', 'x') $$), 'ZD422: invalid input', 'a bidirectional override is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-18', 1, 'x', E'a\u0007b') $$), 'ZD422: invalid input', 'a control character is refused');

-- Additions: the teacher only (SRV-MENTOR-1); the same list for both; other works and strangers see nothing.
INSERT INTO ref SELECT 'a1', pg_temp.ask('vesna', $$ SELECT addition_id FROM collaboration.add_consultation_addition('doc-a', {r1}, 'Rok je pomaknut na ponedjeljak.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'a1'), '^[0-9a-f-]{36}$', 'the teacher adds to a record');
SELECT is(pg_temp.ask('ana', $$ SELECT addition_id FROM collaboration.add_consultation_addition('doc-a', {r1}, 'Razumijem, hvala.') $$), 'ZD403: forbidden',
  'Ana cannot add to the record of her work');
INSERT INTO ref SELECT 'a2', pg_temp.ask('vesna', $$ SELECT addition_id FROM collaboration.add_consultation_addition('doc-a', {r1}, 'Dopuna: popis izvora.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'a2'), '^[0-9a-f-]{36}$', 'the teacher adds again to the same record');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_addition('doc-a', {r1}, '') $$), 'ZD422: invalid input', 'an empty addition is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_addition('doc-a', {r1}, '  ') $$), 'ZD422: invalid input', 'a blank addition is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_addition('doc-a', {r1}, NULL) $$), 'ZD422: invalid input', 'a missing addition is refused');
SELECT is(pg_temp.ask(a.name, $$ SELECT collaboration.add_consultation_addition('doc-a', {r1}, 'Tekst.') $$), 'ZD403: forbidden',
  a.name || ' cannot add to a record of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris'), ('nina')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_addition('doc-b', {r1}, 'Tekst.') $$), 'ZD403: forbidden',
  'a record is not reachable through another work');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_addition('doc-a', gen_random_uuid(), 'Tekst.') $$), 'ZD403: forbidden',
  'an unknown record reads as a forbidden one');
SELECT matches(pg_temp.ask('anon', $$ SELECT collaboration.add_consultation_addition('doc-a', {r1}, 'Tekst.') $$), '^ZD401', 'an addition without a session is not signed in');

-- Reading: the student sees the teacher's addition as the teacher does; the order is the meeting date, then the addition.
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(format('%s|%s|%s|%s', held_on, revision, topic, coalesce(addition_body, '-')), ';' ORDER BY held_on, addition_minute, addition_body)
    FROM collaboration.list_consultation_records('doc-a') $$),
  pg_temp.ask('vesna', $$ SELECT string_agg(format('%s|%s|%s|%s', held_on, revision, topic, coalesce(addition_body, '-')), ';' ORDER BY held_on, addition_minute, addition_body)
    FROM collaboration.list_consultation_records('doc-a') $$),
  'the student and the teacher read the same records and additions');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_consultation_records('doc-a') WHERE addition_body = 'Rok je pomaknut na ponedjeljak.' $$), '1',
  'Ana reads the teacher''s addition');
SELECT is(pg_temp.ask('ana', $$ SELECT count(DISTINCT record_id) FROM collaboration.list_consultation_records('doc-a') $$), '2', 'two records on the work');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_consultation_records('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no record of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('petra'), ('tomo'), ('boris'), ('nina')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_consultation_records('doc-b') $$), 'ZD403: forbidden', 'a teacher reads nothing of another institution''s work');
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM collaboration.list_consultation_records('doc-b') $$), '0', 'the owner of a work with no record reads an empty list');
SELECT matches(pg_temp.ask('expired', $$ SELECT count(*) FROM collaboration.list_consultation_records('doc-a') $$), '^ZD401', 'a list without a live session is not signed in');

-- The row: scope from the document, author from the session; the time is a whole minute in the list.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, owner_id, created_by, revision FROM collaboration.consultation_record WHERE id = pg_temp.id('r1') $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 1::bigint),
  'the record takes its scope from the work and its author from the session');
SELECT is((SELECT author_id FROM collaboration.consultation_addition WHERE id = pg_temp.id('a2')), pg_temp.id('vesna'), 'an addition takes its author from the session');
SELECT is(pg_temp.ask('ana', $$ SELECT bool_and(extract(second FROM addition_minute) = 0) FROM collaboration.list_consultation_records('doc-a') WHERE addition_minute IS NOT NULL $$), 'true',
  'an addition time is a whole minute');

-- The tables refuse what the functions would: a direct row with a bad text or a record of nobody.
SELECT throws_ok($$ INSERT INTO collaboration.consultation_record (institution_id, document_id, assignment_id, owner_id, held_on, revision, topic, agreement, created_by)
    VALUES (pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), '2026-11-18', 1, '', '', pg_temp.id('vesna')) $$,
  '23514', NULL, 'the table refuses an empty topic');
SELECT throws_ok($$ INSERT INTO collaboration.consultation_addition (record_id, institution_id, body, author_id)
    VALUES (pg_temp.id('r1'), pg_temp.id('fak_b'), 'x', pg_temp.id('vesna')) $$,
  '23503', NULL, 'an addition cannot name another institution than its record');
-- The web role cannot touch the tables directly.

SELECT * FROM finish();
ROLLBACK;
