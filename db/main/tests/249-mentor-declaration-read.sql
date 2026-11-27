-- SRV-IZJAVA-MENTOR (owner decision of 25. 11. 2026): the mentor of a
-- student's work reads the declaration bound to its live submission, through
-- the mentorship only. Personas of institution.inc and mentorship.inc: Ana
-- writes zm1 under Marko (ms1, open) and studies in Vesna's course K1. Every
-- person, key, document and text below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
-- As in 038: mentorship.inc writes an assignment before its first version.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

CREATE FUNCTION pg_temp.val(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT val FROM ref WHERE name = p_name $$;
CREATE FUNCTION pg_temp.statement_form() RETURNS text LANGUAGE sql AS $$
  SELECT '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}'
$$;
CREATE FUNCTION pg_temp.statement_body() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'baseVersion', 0, 'revision', 1, 'confirm', true,
    'form', jsonb_build_object('formId','test-izjava','formVersion',1,
      'formSha256',pg_temp.sha(pg_temp.statement_form())),
    'ownWork', '{"confirmed":true}'::jsonb,
    'humanHelp', '{"received":false,"entries":[]}'::jsonb,
    'ai', '{"use":"not_used","attachments":[],"declaredTools":[],"externalAttachmentIds":[]}'::jsonb)
$$;
-- The state of a read of the declaration of p_assignment, or the error.
CREATE FUNCTION pg_temp.read(p_actor text, p_assignment text, p_student text DEFAULT 'ana') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT concat_ws(%L, state, coalesce(declaration_sha256, %L)) FROM app.teacher_declaration(%L::uuid, %L::uuid)',
    ' ', '-', pg_temp.id(p_assignment), pg_temp.id(p_student)))
$$;
CREATE FUNCTION pg_temp.logged() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(concat_ws(':', u.name, l.reader_role, a.name), ' ' ORDER BY u.name, a.name), '-')
    FROM audit.access_log l
    JOIN ref u ON u.val = l.reader_id::text
    JOIN ref a ON a.val = l.assignment_id::text
   WHERE l.surface = 'declaration'
$$;

-- 1. Ana opens the mentored work; before a submission there is nothing.
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))),
  'opened', 'fixture: Ana opens her mentored work');
INSERT INTO ref SELECT 'doc_m1', d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
 WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1');
INSERT INTO ref SELECT 'pkg_m1', id FROM evidence.package WHERE document_id = pg_temp.val('doc_m1');
SELECT is(pg_temp.read('marko', 'zm1'), 'none -', 'the mentor reads none before a submission');
SELECT is(pg_temp.logged(), '-', 'and nothing is logged');

-- 2. Ana writes, confirms her declaration and submits.
SELECT is(pg_temp.call('ana', pg_temp.val('pkg_m1'), 'm-request-1',
    pg_temp.descriptor(p_package => pg_temp.val('pkg_m1'), p_document => pg_temp.val('doc_m1'), p_segment => 'segment-m-1'),
    0, evidence.revision_zero_document_v2(), repeat('d', 64), repeat('b', 64)),
  'reserved', 'fixture: Ana commits revision 1');
INSERT INTO ref SELECT 'saved', pg_temp.ask('ana', format('SELECT declaration.save_statement(%L, %L::jsonb, %L)',
  pg_temp.id('zm1'), pg_temp.statement_body(), pg_temp.statement_form()));
SELECT is((SELECT val::jsonb #>> '{statement,state}' FROM ref WHERE name = 'saved'), 'confirmed',
  'fixture: Ana confirms her declaration');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.request_submission(%L, 1)', pg_temp.val('doc_m1'))),
  'requested', 'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
    (SELECT id FROM evidence.submission_request WHERE document_id = pg_temp.val('doc_m1')), pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');

-- 3. The mentor reads exactly the bound declaration; the read is logged as his.
SELECT is(pg_temp.read('marko', 'zm1'),
  'bound ' || (SELECT val::jsonb #>> '{statement,declarationSha256}' FROM ref WHERE name = 'saved'),
  'the mentor of the work reads the bound declaration');
SELECT is(pg_temp.logged(), 'marko:mentor:zm1', 'the read is logged as the mentor''s, on the declaration surface');
-- Ana bound no answer (INT-32, SRV-IZJAVA-ODGOVOR-NULL): the answer is null, not an object of nulls.
-- The read logs one more opening; it is rolled back so the log checks below stay as they are.
SAVEPOINT answer_read;
SELECT is(pg_temp.ask('marko', format(
    'SELECT coalesce(answer::text, %L) FROM app.teacher_declaration_answer(%L::uuid, %L::uuid)',
    'NULL', pg_temp.id('zm1'), pg_temp.id('ana'))),
  'NULL', 'the mentor reads no bound answer as null');
ROLLBACK TO SAVEPOINT answer_read;

-- 4. Nobody else reads it through the mentorship, and nothing more is logged.
SELECT matches(pg_temp.read(a.name, 'zm1'), '^ZD40[13]', a.name || ' does not read Ana''s mentored declaration')
FROM (VALUES ('vesna'), ('dora'), ('ana'), ('nina'), ('iva'), ('petra'), ('anon')) AS a (name);
SELECT matches(pg_temp.read('marko', 'zm1', 'dora'), '^ZD403', 'the mentor reads no other student''s work');
SELECT matches(pg_temp.read('marko', 'z1'), '^ZD403', 'the mentor reads nothing of Ana''s course');
SELECT is(pg_temp.logged(), 'marko:mentor:zm1', 'the refusals wrote nothing');

-- 5. The mentor's teacher role revoked closes the read at once.
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('marko');
SELECT matches(pg_temp.read('marko', 'zm1'), '^ZD403', 'a revoked mentor reads nothing');
SELECT is(pg_temp.logged(), 'marko:mentor:zm1', 'and nothing is logged');

SELECT * FROM finish();
ROLLBACK;
