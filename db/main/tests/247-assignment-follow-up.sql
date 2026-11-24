-- SRV-NF4-POTVRDE-DORADE (Ductus#2055): app.assignment_follow_up gives, per
-- row of app.assignment_submissions, the UTC minute the notice was first read,
-- the minute and number of the latest acknowledged version, and of the
-- student's revision requests on the assignment the one with the latest
-- change (its state and five-minute window) with the number of open ones.
-- Personas of institution.inc. Added here: Vesna holds K1, G-A has Dora, G-B
-- has Ana and Marko as its teacher. Ana read the notice and acknowledged two
-- versions; she has an older open request and a later responded one. Dora
-- acknowledged version 1 and has an accepted request and a withdrawn one.
-- Tomo (fak_b, Z3) has an open request. Everything is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

INSERT INTO ref VALUES
 ('group_a', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa A') $$)),
 ('group_b', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa B') $$));
SELECT pg_temp.ask('vesna', $$ SELECT institution.set_course_holder({k1}, {vesna}) $$);
SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_teacher({group_b}, {marko}) $$);
SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_student({group_a}, {dora}) $$);
SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_student({group_b}, {ana}) $$);

INSERT INTO institution.notice_read (institution_id, assignment_id, student_id, read_at)
SELECT institution_id, id, pg_temp.id('ana'), timestamptz '2026-12-01 08:02:37.250+00'
  FROM institution.assignment WHERE id = pg_temp.id('z1');
UPDATE institution.notice_acknowledgment n
   SET acknowledged_at = v.at::timestamptz
  FROM (VALUES ('ana', 1, '2026-12-01 08:03:10+00'), ('ana', 2, '2026-12-03 11:59:59.999+00'),
               ('dora', 1, '2026-12-02 07:00:00+00')) AS v (who, version_no, at)
 WHERE n.assignment_id = pg_temp.id('z1') AND n.student_id = pg_temp.id(v.who) AND n.version_no = v.version_no;
UPDATE institution.notice_acknowledgment SET acknowledged_at = timestamptz '2026-12-02 15:30:30+00'
 WHERE assignment_id = pg_temp.id('z3') AND student_id = pg_temp.id('tomo');

-- Revision requests, directly as the owner of the tables (245 does the same).
CREATE SEQUENCE pg_temp.seq START 9007199254740200;
CREATE TEMP TABLE req (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO req
SELECT v.name, gen_random_uuid()
  FROM (VALUES ('ana_open'), ('ana_responded'), ('dora_accepted'), ('dora_withdrawn'), ('tomo_open')) AS v (name);
INSERT INTO collaboration.revision_request
  (id, institution_id, assignment_id, owner_id, document_id, anchor, state, version, row_seq, created_by, created_at)
SELECT r.id, a.institution_id, a.id, pg_temp.id(v.owner), v.doc,
       '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}',
       v.state, 1, nextval('pg_temp.seq'), pg_temp.id(v.teacher), v.opened::timestamptz
  FROM (VALUES
    ('ana_open', 'ana', 'z1', 'doc-a', 'open', 'vesna', '2026-12-05 10:00:00+00'),
    ('ana_responded', 'ana', 'z1', 'doc-a', 'responded', 'vesna', '2026-12-06 09:00:00+00'),
    ('dora_accepted', 'dora', 'z1', 'doc-d', 'accepted', 'vesna', '2026-12-04 08:00:00+00'),
    ('dora_withdrawn', 'dora', 'z1', 'doc-d', 'withdrawn', 'vesna', '2026-12-04 07:00:00+00'),
    ('tomo_open', 'tomo', 'z3', 'doc-b', 'open', 'petra', '2026-12-07 09:00:00+00')
  ) AS v (name, owner, assignment, doc, state, teacher, opened)
  JOIN req r ON r.name = v.name
  JOIN institution.assignment a ON a.id = pg_temp.id(v.assignment);
INSERT INTO collaboration.revision_request_version
  (request_id, institution_id, version, instruction, requested_revision, opened_by, opened_at,
   closed_as, closed_by, closed_at, accepted_revision)
SELECT q.id, q.institution_id, 1, 'Dopuni izvor.', 0, q.created_by, q.created_at,
       c.closed_as, CASE WHEN c.closed_as IS NOT NULL THEN q.created_by END, c.closed_at::timestamptz,
       CASE WHEN c.closed_as = 'accepted' THEN 0 END
  FROM collaboration.revision_request q
  JOIN req r ON r.id = q.id
  LEFT JOIN (VALUES ('dora_accepted', 'accepted', '2026-12-04 09:44:59+00'),
                    ('dora_withdrawn', 'withdrawn', '2026-12-04 09:45:00+00')) AS c (name, closed_as, closed_at)
    ON c.name = r.name;
INSERT INTO collaboration.revision_response
  (request_id, institution_id, version, kind, explanation, response_revision, author_id, created_at)
SELECT q.id, q.institution_id, 1, 'done', 'Dopunjeno.', 0, q.owner_id, v.at::timestamptz
  FROM (VALUES ('ana_responded', '2026-12-06 09:17:42+00'), ('dora_accepted', '2026-12-04 09:30:00+00')) AS v (name, at)
  JOIN req r ON r.name = v.name
  JOIN collaboration.revision_request q ON q.id = r.id;

CREATE TEMP TABLE logged AS SELECT count(*) AS n FROM audit.access_log;
GRANT SELECT ON logged TO PUBLIC;

-- The rows as "name:read/ack/vN/state@window/oN" in the function's own order,
-- or "none"; "-" for null, times as UTC "MM-DD HH24:MI". Names replace ids.
CREATE FUNCTION pg_temp.follow(p_actor text, p_assignment text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_result text;
  r record;
BEGIN
  v_result := pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(string_agg(f.student_id::text || ':'
                 || coalesce(to_char(f.notice_read_minute AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-') || '/'
                 || coalesce(to_char(f.notice_acknowledged_minute AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-') || '/v'
                 || coalesce(f.notice_version_no::text, '-') || '/'
                 || coalesce(f.revision_state, '-') || '@'
                 || coalesce(to_char(f.revision_changed_window AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-') || '/o'
                 || f.open_revision_count, ' ' ORDER BY f.n), 'none')
          FROM app.assignment_follow_up(%s) WITH ORDINALITY AS f (student_id, notice_read_minute,
               notice_acknowledged_minute, notice_version_no, revision_state, revision_changed_window,
               open_revision_count, n) $q$,
    coalesce(quote_literal(pg_temp.id(p_assignment)::text), 'NULL')));
  FOR r IN SELECT name, id FROM person LOOP
    v_result := replace(v_result, r.id::text, r.name);
  END LOOP;
  RETURN v_result;
END
$$;

-- Catalogue.
SELECT is(
  (SELECT format('%s %s %s %s', pg_get_userbyid(proowner), prosecdef::text, provolatile, ('search_path=""' = ANY(proconfig))::text)
     FROM pg_proc WHERE oid = 'app.assignment_follow_up(uuid)'::regprocedure),
  'ductus_identity true s true', 'the follow-up is the identity role''s, SECURITY DEFINER, STABLE, empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                'ductus_evidence', 'ductus_test_stranger']) AS r
     WHERE has_function_privilege(r, 'app.assignment_follow_up(uuid)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role executes the follow-up');
SELECT is(pg_get_function_result('app.assignment_follow_up(uuid)'::regprocedure),
  'TABLE(student_id uuid, notice_read_minute timestamp with time zone, notice_acknowledged_minute timestamp with time zone, notice_version_no integer, revision_state text, revision_changed_window timestamp with time zone, open_revision_count integer)',
  'the follow-up returns these seven columns: no text of a request, no document, no other person');
SELECT is((SELECT proargnames[1:pronargs]::text FROM pg_proc WHERE oid = 'app.assignment_follow_up(uuid)'::regprocedure),
  '{p_assignment_id}', 'the follow-up takes only the assignment');
SELECT matches(pg_temp.ask_as('ductus_test_stranger', 'vesna', $$ SELECT count(*) FROM app.assignment_follow_up({z1}) $$),
  '^42501:.*$', 'an unrelated role cannot call the follow-up');

-- What the teacher sees.
SELECT is(pg_temp.follow('vesna', 'z1'),
  'ana:12-01 08:02/12-03 11:59/v2/responded@12-06 09:15/o1 '
  || 'dora:-/12-02 07:00/v1/withdrawn@12-04 09:45/o0',
  'the holder: first read and latest acknowledged version in minutes; the request with the latest change in its five-minute window, and the open count');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(f.student_id::text, ' ' ORDER BY n)
                                    FROM app.assignment_follow_up({z1}) WITH ORDINALITY AS f (student_id, a, b, c, d, e, g, n) $$),
  pg_temp.ask('vesna', $$ SELECT string_agg(s.student_id::text, ' ' ORDER BY n)
                            FROM app.assignment_submissions({z1}) WITH ORDINALITY AS s (student_id, a, b, c, d, n) $$),
  'the same students in the same order as app.assignment_submissions');
SELECT is(pg_temp.follow('marko', 'z1'), 'ana:12-01 08:02/12-03 11:59/v2/responded@12-06 09:15/o1',
  'the collaborator of G-B: Ana only, Dora is absent');
SELECT is(pg_temp.follow('petra', 'z3'), 'tomo:-/12-02 15:30/v1/open@12-07 09:00/o1',
  'another institution''s teacher: the own course, the own students'' requests only');

-- Precision does not depend on the session time zone.
SET LOCAL TimeZone TO 'America/St_Johns';
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.assignment_follow_up({z1}) f
                                  WHERE f.notice_read_minute <> date_trunc('minute', f.notice_read_minute, 'UTC')
                                     OR f.notice_acknowledged_minute <> date_trunc('minute', f.notice_acknowledged_minute, 'UTC')
                                     OR extract(epoch FROM f.revision_changed_window)::bigint % 300 <> 0 $$),
  '0', 'every minute is whole and every window starts on a five-minute UTC boundary');
SELECT is(pg_temp.follow('vesna', 'z1'),
  'ana:12-01 08:02/12-03 11:59/v2/responded@12-06 09:15/o1 '
  || 'dora:-/12-02 07:00/v1/withdrawn@12-04 09:45/o0',
  'the same answer in a session at UTC-03:30');
RESET TimeZone;

-- Someone else's is the same as nonexistent.
SELECT is(pg_temp.follow(a.who, a.z), 'none', a.why)
  FROM (VALUES ('petra', 'z1', 'a teacher of another institution gets nothing'),
               ('vesna', 'z3', 'another institution''s assignment is the same nothing'),
               ('ana', 'z1', 'a student of the course gets nothing, not even her own row'),
               ('dora', 'z1', 'another student of the course gets nothing'),
               ('tomo', 'z3', 'a student asking for the own assignment gets nothing'),
               ('iva', 'z1', 'the administrator gets nothing'),
               ('boris', 'z1', 'a person of the institution outside the course gets nothing'),
               ('vesna', 'nobody', 'an assignment that does not exist is the same nothing'),
               ('vesna', 'no-such-name', 'no assignment is the same nothing')) AS a (who, z, why);
SELECT matches(pg_temp.follow(t, 'z1'), '^ZD401:', 'no valid session is ZD401: ' || t)
  FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t;

-- Reopening Ana's responded request: it is open again and counts as open.
UPDATE collaboration.revision_request SET state = 'reopened'
 WHERE id = (SELECT id FROM req WHERE name = 'ana_responded');
SELECT is(pg_temp.follow('marko', 'z1'), 'ana:12-01 08:02/12-03 11:59/v2/open@12-06 09:15/o2',
  'a reopened request reads as open and adds to the open count');

SELECT is((SELECT count(*) FROM audit.access_log), (SELECT n FROM logged),
  'the follow-up opens no work: no access log row');

SELECT * FROM finish();
ROLLBACK;
