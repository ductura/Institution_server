-- SRV-1409 / DAN-379: access to a thesis before and after submission.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT plan(30);

-- Marko mentors Ana. Vesna and Nina have no standard access to Ana's thesis.
UPDATE institution.institution_role
SET confirmed_at = now(), confirmed_by = pg_temp.id('iva')
WHERE user_id = pg_temp.id('nina') AND role = 'teacher';

-- One draft besides the submitted document, in the very same project.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
VALUES ('project-191', pg_temp.id('fak_a'), pg_temp.id('zm1'), pg_temp.id('ana'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision, current_content_hash)
VALUES ('thesis-191', pg_temp.id('fak_a'), 'project-191', pg_temp.id('ana'), 1, repeat('b', 64)),
       ('draft-191', pg_temp.id('fak_a'), 'project-191', pg_temp.id('ana'), 0, repeat('a', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('thesis-191', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64)),
       ('thesis-191', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('b', 64)),
       ('draft-191', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.work_grant'::regclass),
  'work_grant enables and forces RLS'
);
SELECT matches(pg_temp.ask('marko',
  $$ SELECT institution.grant_work_access({zm1}, {ana}, {vesna}, 'co_mentor', '{read_text}', NULL, now() + interval '1 day') $$),
  '^[0-9a-f-]{36}$', 'the mentor grants the co-mentor read_text');
INSERT INTO ref VALUES ('committee_grant', pg_temp.ask('marko',
  $$ SELECT institution.grant_work_access({zm1}, {ana}, {nina}, 'committee', '{read_text,comment}', NULL, now() + interval '1 day') $$));
SELECT matches((SELECT val FROM ref WHERE name = 'committee_grant'), '^[0-9a-f-]{36}$',
  'the mentor can appoint a committee member in advance');
SELECT is(pg_temp.ask('petra', $$ SELECT count(*) FROM institution.work_grant WHERE assignment_id = {zm1} $$),
  '0', 'another institution sees none of the grant rows');

CREATE FUNCTION pg_temp.read_matrix(p_phase text, p_committee text) RETURNS SETOF text
LANGUAGE sql AS $$
  SELECT is(pg_temp.ask(r.actor, r.query), r.expected, p_phase || ': ' || r.label)
  FROM (VALUES
    ('marko', $q$ SELECT institution.can('read', 'thesis-191')::text $q$, 'true', 'mentor reads'),
    ('vesna', $q$ SELECT institution.grant_can('read_text', 'thesis-191')::text $q$, 'true', 'co-mentor reads with a grant'),
    ('vesna', $q$ SELECT institution.grant_can('comment', 'thesis-191')::text $q$, 'false', 'co-mentor has only the granted action'),
    ('nina', $q$ SELECT institution.grant_can('read_text', 'thesis-191')::text $q$, p_committee, 'committee text'),
    ('nina', $q$ SELECT institution.grant_can('comment', 'thesis-191')::text $q$, p_committee, 'committee comments'),
    ('nina', $q$ SELECT institution.can('read', 'thesis-191')::text $q$, 'false', 'committee never opens the ordinary mentor path')
  ) AS r(actor, query, expected, label)
$$;

SELECT * FROM pg_temp.read_matrix('draft', 'false');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('thesis-191', 1) $$),
  'requested', 'student requests the submission');
INSERT INTO ref SELECT 'request_191', id::text FROM evidence.submission_request WHERE document_id = 'thesis-191';
SELECT is(pg_temp.ask('vesna',
  $$ SELECT outcome FROM app.record_submission({request_191}, repeat('b', 64)) $$),
  'unauthorized', 'the co-mentor cannot confirm the pending submission');
SELECT is(pg_temp.ask('nina',
  $$ SELECT outcome FROM app.record_submission({request_191}, repeat('b', 64)) $$),
  'unauthorized', 'the committee member cannot confirm the pending submission');
SELECT is(pg_temp.ask('nina', $$ SELECT institution.grant_can('read_text', 'thesis-191')::text $$),
  'false', 'a pending request does not unlock committee access');

SELECT is(pg_temp.ask('ana',
  $$ SELECT outcome FROM app.record_submission({request_191}, repeat('b', 64)) $$),
  'recorded', 'the student records the submission');
SELECT * FROM pg_temp.read_matrix('after submission', 'true');
SELECT is(pg_temp.ask('vesna',
  $$ SELECT outcome FROM app.record_submission({request_191}, repeat('b', 64)) $$),
  'unauthorized', 'the co-mentor cannot confirm a recorded submission either');
SELECT is(pg_temp.ask('nina',
  $$ SELECT outcome FROM app.record_submission({request_191}, repeat('b', 64)) $$),
  'unauthorized', 'the committee member still cannot confirm the submission');
SELECT is(pg_temp.ask('nina', $$ SELECT institution.grant_can('read_text', 'draft-191')::text $$),
  'false', 'the committee cannot read another document of the same thesis');
SELECT is(pg_temp.ask('iva', $$ SELECT institution.grant_can('read_text', 'thesis-191')::text $$),
  'false', 'a submission alone gives no read to an institution administrator');
SELECT is(pg_temp.ask('petra', $$ SELECT institution.grant_can('read_text', 'thesis-191')::text $$),
  'false', 'the submission gives no access to a teacher of another institution');
SELECT is(pg_temp.ask('anon', $$ SELECT institution.grant_can('read_text', 'thesis-191')::text $$),
  'false', 'the submission gives no access without a session');
SELECT is(pg_temp.ask('marko', $$ SELECT institution.revoke_work_access({committee_grant})::text $$),
  'true', 'the mentor revokes the committee grant');
SELECT is(pg_temp.ask('nina', $$ SELECT institution.grant_can('read_text', 'thesis-191')::text $$),
  'false', 'the next read is denied even though the submission remains');
SELECT is((SELECT count(*)::integer FROM evidence.submission WHERE submission_request_id = pg_temp.id('request_191')),
  1, 'only the student recorded a submission');

SELECT * FROM finish();
ROLLBACK;
