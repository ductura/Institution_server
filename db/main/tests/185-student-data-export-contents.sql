-- SRV-1308 (M10.5; D-271 MQ02): what the worker reads for the package of an
-- approved student data export. Two students of fak-a, Ana and Dora, each
-- submitted Z1, wrote a note and had their work opened by Vesna; Tomo of fak-b
-- submitted Z3. Ana's export reads only Ana's rows, only while it is approved,
-- and only the worker reads it. Every person, text and reference is invented
-- (fixtures/institution.inc and evidence-acceptance.inc).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE TEMP TABLE due AS
SELECT pg_temp.id('z1') AS z1, (SELECT due_at FROM institution.assignment_version
                                  WHERE assignment_id = pg_temp.id('z1') AND version_no = 2) AS z1_due,
       (SELECT due_at FROM institution.assignment_version
         WHERE assignment_id = pg_temp.id('z3') AND version_no = 1) AS z3_due;
GRANT SELECT ON due TO PUBLIC;

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), pg_temp.sha(repeat('d', 64)));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT r.doc, pg_temp.id(r.fak), r.revision, nullif(r.revision - 1, -1), pg_temp.id(r.who), pg_temp.sha(r.body)
  FROM (VALUES ('doc-a', 'fak_a', 1, 'ana', 'Izmišljeni predani tekst Ane.'),
               ('doc-b', 'fak_b', 1, 'tomo', 'Izmišljeni predani tekst Tome.'),
               ('doc-d', 'fak_a', 0, 'dora', repeat('d', 64)),
               ('doc-d', 'fak_a', 1, 'dora', 'Izmišljeni predani tekst Dore.')
  ) AS r (doc, fak, revision, who, body);
-- The checkpoint seals its own hash from the body (evidence.seal_document_checkpoint).
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body, content_hash, created_at)
SELECT r.doc, pg_temp.id(r.fak), 1, r.body, pg_temp.sha(r.body), now()
  FROM (VALUES ('doc-a', 'fak_a', 'Izmišljeni predani tekst Ane.'),
               ('doc-b', 'fak_b', 'Izmišljeni predani tekst Tome.'),
               ('doc-d', 'fak_a', 'Izmišljeni predani tekst Dore.')
  ) AS r (doc, fak, body);
INSERT INTO evidence.submission_request (
  id, institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
  revision, content_hash, requested_at
)
SELECT r.id::uuid, pg_temp.id(r.fak), pg_temp.id(r.z), r.version, r.project, r.doc, pg_temp.id(r.who),
       1, pg_temp.sha(r.body), r.at
  FROM due, LATERAL (VALUES
    ('00000000-0000-4000-8000-0000000001e1', 'fak_a', 'z1', 2, 'project-a', 'doc-a', 'ana', 'Izmišljeni predani tekst Ane.',
     due.z1_due - interval '1 day'),
    ('00000000-0000-4000-8000-0000000001e2', 'fak_a', 'z1', 2, 'project-d', 'doc-d', 'dora', 'Izmišljeni predani tekst Dore.',
     due.z1_due - interval '2 days'),
    ('00000000-0000-4000-8000-0000000001e3', 'fak_b', 'z3', 1, 'project-b', 'doc-b', 'tomo', 'Izmišljeni predani tekst Tome.',
     due.z3_due - interval '1 day')
  ) AS r (id, fak, z, version, project, doc, who, body, at);
INSERT INTO evidence.submission (
  submission_request_id, institution_id, principal_id, assignment_id, assignment_version, revision,
  artifact_hash, requested_at, due_at, recorded_at
)
SELECT q.id, q.institution_id, q.principal_id, q.assignment_id, q.assignment_version, q.revision,
       q.content_hash, q.requested_at, CASE WHEN q.assignment_id = due.z1 THEN due.z1_due ELSE due.z3_due END,
       q.requested_at + interval '2 seconds'
  FROM evidence.submission_request q, due
 WHERE q.id::text LIKE '00000000-0000-4000-8000-0000000001e%';
INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text) VALUES
  (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'Izmišljena bilješka Ane.'),
  (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), 'Izmišljena bilješka Dore.'),
  (pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'), 'Izmišljena bilješka Tome.');
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name) VALUES
  (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljena');
INSERT INTO audit.access_log (id, institution_id, document_id, assignment_id, owner_id, reader_id, reader_role,
                              surface, opened_at)
SELECT l.entry::uuid, pg_temp.id(l.fak), l.doc, pg_temp.id(l.assignment), pg_temp.id(l.owner),
       pg_temp.id(l.reader), 'teacher', l.surface, l.at::timestamptz
  FROM (VALUES
    ('00000000-0000-4000-8000-0000000001c1', 'fak_a', 'doc-a', 'z1', 'ana', 'vesna', 'live_view', '2026-10-19 12:00:00+00'),
    ('00000000-0000-4000-8000-0000000001c2', 'fak_a', 'doc-a', 'z1', 'ana', 'vesna', 'process_summary', '2026-10-20 08:00:00+00'),
    ('00000000-0000-4000-8000-0000000001c3', 'fak_a', 'doc-d', 'z1', 'dora', 'vesna', 'live_view', '2026-10-19 12:00:00+00')
  ) AS l (entry, fak, doc, assignment, owner, reader, surface, at);

-- The exports, written as the operator: Ana's approved, Dora's still
-- requested. Boris stands in for the clerk who requested, Iva approved.
INSERT INTO app.student_data_export (id, institution_id, student_id, status, requested_by, identity_check_ref,
                                     approved_by, approved_at, job_ref)
VALUES
  ('00000000-0000-4000-8000-0000000001f1', pg_temp.id('fak_a'), pg_temp.id('ana'), 'approved', pg_temp.id('boris'),
   'osobna iskaznica · Provjera 1/2026', pg_temp.id('iva'), now(), 'Posao 1/2026'),
  ('00000000-0000-4000-8000-0000000001f2', pg_temp.id('fak_a'), pg_temp.id('dora'), 'requested', pg_temp.id('boris'),
   'osobna iskaznica · Provjera 2/2026', NULL, NULL, NULL);

CREATE FUNCTION pg_temp.work(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_worker', 'anon', p_sql) $$;

-- 1. Catalogue: owners, SECURITY DEFINER, an empty search_path, and EXECUTE
-- only for the worker (the private subject step for the evidence role).
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' '
                     || p.prosecdef || ' ' || ('search_path=""' = ANY (p.proconfig)), ', '
                     ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.oid IN ('app.student_data_export_subject(uuid)'::regprocedure,
                    'app.worker_student_data_export_submissions(uuid)'::regprocedure,
                    'app.worker_student_data_export_notes(uuid)'::regprocedure,
                    'app.worker_student_data_export_access_log(uuid)'::regprocedure)),
  'app.student_data_export_subject(uuid) ductus_identity true true, '
  || 'app.worker_student_data_export_access_log(uuid) ductus_identity true true, '
  || 'app.worker_student_data_export_notes(uuid) ductus_evidence true true, '
  || 'app.worker_student_data_export_submissions(uuid) ductus_evidence true true',
  'owners of their tables, SECURITY DEFINER and an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || p.oid::regprocedure::text
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence', 'ductus_auth',
                         'ductus_test_stranger', 'public']) r
      CROSS JOIN pg_proc p
      WHERE p.oid IN ('app.student_data_export_subject(uuid)'::regprocedure,
                      'app.worker_student_data_export_submissions(uuid)'::regprocedure,
                      'app.worker_student_data_export_notes(uuid)'::regprocedure,
                      'app.worker_student_data_export_access_log(uuid)'::regprocedure)
        AND has_function_privilege(r, p.oid, 'EXECUTE') $$,
  ARRAY['ductus_worker app.worker_student_data_export_submissions(uuid)',
        'ductus_worker app.worker_student_data_export_notes(uuid)',
        'ductus_worker app.worker_student_data_export_access_log(uuid)',
        'ductus_evidence app.student_data_export_subject(uuid)',
        'ductus_evidence app.worker_student_data_export_submissions(uuid)',
        'ductus_evidence app.worker_student_data_export_notes(uuid)'],
  'the worker runs the three reads, the evidence role the private subject step and its own two reads, nobody else anything');

-- 2. The web role, with any session, reads nothing.
SELECT is(pg_temp.ask(a, format('SELECT count(*)::text FROM app.%s(%L)', f, '00000000-0000-4000-8000-0000000001f1')),
  '42501: permission denied for function ' || f, a || ' cannot run ' || f)
  FROM unnest(ARRAY['ana', 'iva', 'vesna']) a
 CROSS JOIN unnest(ARRAY['worker_student_data_export_submissions', 'worker_student_data_export_notes',
                         'worker_student_data_export_access_log']) f;

-- 3 (acceptance). Ana's approved export reads Ana's rows and nobody else's.
SELECT is(pg_temp.work($$ SELECT string_agg(s.body || '|' || s.revision || '|' || (s.receipt_payload IS NULL)::text, ';')
                            FROM app.worker_student_data_export_submissions('00000000-0000-4000-8000-0000000001f1') s $$),
  'Izmišljeni predani tekst Ane.|1|true', 'the submissions are Ana''s one, with its exact text and no receipt yet');
SELECT is(pg_temp.work($$ SELECT string_agg(n.text, ';' ORDER BY n.created_at)
                            FROM app.worker_student_data_export_notes('00000000-0000-4000-8000-0000000001f1') n $$),
  'Izmišljena bilješka Ane.', 'the notes are Ana''s');
SELECT is(pg_temp.work($$ SELECT string_agg(l.surface || '@' || l.opened_at::date::text || '@' || l.reader_given_name,
                                             ';' ORDER BY l.opened_at)
                            FROM app.worker_student_data_export_access_log('00000000-0000-4000-8000-0000000001f1') l $$),
  'live_view@2026-10-19@Vesna;process_summary@2026-10-20@Vesna', 'the access log is of Ana''s work only');
SELECT is(pg_temp.work($$ SELECT count(*)::text FROM (
    SELECT s.body FROM app.worker_student_data_export_submissions('00000000-0000-4000-8000-0000000001f1') s
     WHERE s.body LIKE '%Dore%' OR s.body LIKE '%Tome%'
    UNION ALL SELECT n.text FROM app.worker_student_data_export_notes('00000000-0000-4000-8000-0000000001f1') n
     WHERE n.text LIKE '%Dore%' OR n.text LIKE '%Tome%') x $$),
  '0', 'nothing of Dora or Tomo reaches Ana''s export');

-- 4. Only an approved export reads anything: Dora's requested one, an unknown
-- id and no id read nothing.
SELECT is(pg_temp.work(format($$ SELECT (SELECT count(*) FROM app.worker_student_data_export_submissions(%1$s))
                                      + (SELECT count(*) FROM app.worker_student_data_export_notes(%1$s))
                                      + (SELECT count(*) FROM app.worker_student_data_export_access_log(%1$s)) $$,
                              e.id)) || '', '0', e.label || ' reads nothing')
  FROM (VALUES ('''00000000-0000-4000-8000-0000000001f2''::uuid', 'a requested export'),
               ('''00000000-0000-4000-8000-0000000001ff''::uuid', 'an unknown export'),
               ('NULL::uuid', 'no export')) AS e (id, label);

-- 5. A ready export reads nothing either: the job ends at ready.
SELECT is(pg_temp.work($$ SELECT app.worker_mark_student_data_export_ready('00000000-0000-4000-8000-0000000001f1',
                                   sha256('izmisljeni-token-185'::bytea)) IS NOT NULL $$),
  'true', 'the worker marks Ana''s export ready');
SELECT is(pg_temp.work($$ SELECT count(*)::text FROM app.worker_student_data_export_submissions('00000000-0000-4000-8000-0000000001f1') $$),
  '0', 'a ready export reads no submission');
SELECT is(pg_temp.work($$ SELECT count(*)::text FROM app.worker_student_data_export_notes('00000000-0000-4000-8000-0000000001f1') $$),
  '0', 'a ready export reads no note');

-- 6. A withdrawn submission stays out of the package; covered by the
-- function's own evidence.submission_withdrawn check (205-submission-withdrawal.sql
-- tests the predicate).
SELECT ok(pg_get_functiondef('app.worker_student_data_export_submissions(uuid)'::regprocedure)
            LIKE '%NOT evidence.submission_withdrawn(s.id)%',
  'the submissions read leaves a withdrawn submission out');

SELECT * FROM finish();
ROLLBACK;
