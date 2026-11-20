-- DAN-515, M2.6-P03 (contract on #1091, c.6591114645; D-204): a mentorship
-- exists only once the teacher a student asked approves the request. One
-- table of cases per function walks every class of input of the contract;
-- each class also checks that nothing else was written. Personas of
-- institution.inc and mentorship.inc; Ema is one more invented teacher of
-- fak-a, whose role is revoked below.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT no_plan();

INSERT INTO person VALUES ('ema', '00000000-0000-4000-8000-000000000111', pg_temp.id('fak_a'), 'fak-a');
INSERT INTO tok VALUES ('ema', repeat('K', 43));
INSERT INTO ref VALUES ('ema', '00000000-0000-4000-8000-000000000111');
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
VALUES (pg_temp.id('ema'), pg_temp.id('fak_a'), 'https://issuer.test', 'sub-ema', 'ema@fak-a.example');
INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
VALUES (sha256(convert_to(repeat('K', 43), 'UTF8')), pg_temp.id('ema'), pg_temp.id('fak_a'), now() + interval '1 hour');
INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
VALUES (pg_temp.id('fak_a'), pg_temp.id('ema'), 'teacher', pg_temp.id('iva'), now());

CREATE FUNCTION pg_temp.mentorships() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.mentorship $$;
CREATE FUNCTION pg_temp.events() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM audit.mentorship_event $$;
-- A uuid result reads as 'id'; errors and booleans as they are.
CREATE FUNCTION pg_temp.shape(p_result text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_result ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN 'id' ELSE p_result END
$$;

-- 1. The catalogue.
SELECT is(
  (SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || pg_get_function_result(p.oid)
          || CASE WHEN p.prosecdef THEN ' definer' ELSE '' END
          || CASE WHEN has_function_privilege('ductus_app', p.oid, 'EXECUTE') THEN ' app' ELSE '' END, ' | ' ORDER BY p.proname)
   FROM pg_proc p
   WHERE p.pronamespace = 'institution'::regnamespace
     AND p.proname IN ('request_mentorship', 'withdraw_mentorship_request', 'approve_mentorship_request',
                       'decline_mentorship_request', 'lock_teacher_role')),
  'approve_mentorship_request(p_request_id uuid) uuid definer app'
  ' | decline_mentorship_request(p_request_id uuid, p_reason text) boolean definer app'
  ' | lock_teacher_role(p_user_id uuid) uuid'
  ' | request_mentorship(p_teacher_id uuid, p_work_type text) uuid definer app'
  ' | withdraw_mentorship_request(p_request_id uuid) boolean definer app',
  'the four functions take no actor; the lock helper is not callable by ductus_app'
);
SELECT row_eq(
  $$ SELECT relowner::regrole::text, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'audit.mentorship_event'::regclass $$,
  ROW('ductus_identity'::text, true, true), 'the identity role owns mentorship_event and RLS is enabled and forced');
SELECT bag_eq(
  $$ SELECT polname::text, polroles::regrole[]::text FROM pg_policy WHERE polrelid = 'audit.mentorship_event'::regclass $$,
  $$ VALUES ('mentorship_event_owner', '{ductus_identity}') $$, 'the only policy on mentorship_event is the owner''s');
SELECT columns_are('audit', 'mentorship_event', ARRAY[
  'id', 'institution_id', 'request_id', 'student_id', 'teacher_id', 'kind', 'actor_id', 'mentorship_id', 'occurred_at',
  'reason'
], 'mentorship_event has exactly the listed columns');
SELECT is(
  (SELECT string_agg(pg_get_constraintdef(c.oid), ' | ' ORDER BY c.conname) FROM pg_constraint c
    WHERE c.conrelid = 'audit.mentorship_event'::regclass AND c.conname IN ('mentorship_event_kind_check', 'mentorship_event_reason_check')),
  'CHECK ((kind = ANY (ARRAY[''requested''::text, ''withdrawn''::text, ''approved''::text, ''declined''::text])))'
  ' | CHECK (((reason IS NULL) OR ((kind = ''declined''::text) AND ((char_length(reason) >= 1) AND (char_length(reason) <= 600)) AND (reason ~ ''[^[:space:]]''::text))))',
  'SRV-28: a declined event is a kind; only it carries a reason, of 1 to 600 characters, not blank');
SELECT is(
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
    WHERE c.conrelid = 'institution.mentorship_request'::regclass AND c.conname = 'mentorship_request_one_end_check'),
  'CHECK ((num_nonnulls(withdrawn_at, approved_at, declined_at) <= 1))',
  'SRV-28: a request ends at most once: withdrawn, approved or declined');
SELECT is(
  (SELECT string_agg(pg_get_expr(i.indpred, i.indrelid), ' | ' ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'institution.mentorship_request'::regclass AND i.indpred IS NOT NULL),
  '((withdrawn_at IS NULL) AND (approved_at IS NULL) AND (declined_at IS NULL))'
  ' | ((withdrawn_at IS NULL) AND (approved_at IS NULL) AND (declined_at IS NULL))',
  'SRV-28: a declined request is not open in either partial index');
SELECT col_is_unique('audit', 'mentorship_event', ARRAY['request_id', 'kind'], 'one event per request and kind');
SELECT fk_ok('audit', 'mentorship_event', ARRAY['request_id', 'institution_id', 'student_id', 'teacher_id'],
             'institution', 'mentorship_request', ARRAY['id', 'institution_id', 'student_id', 'teacher_id'],
             'an event is bound to its request, its institution, student and teacher');
SELECT bag_eq(
  $$ SELECT tgname::text FROM pg_trigger WHERE tgrelid = 'audit.mentorship_event'::regclass AND NOT tgisinternal $$,
  $$ VALUES ('mentorship_event_append_only'), ('mentorship_event_no_truncate') $$, 'mentorship_event is append-only');
SELECT is_empty(
  $$ SELECT a.grantee::regrole::text FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'audit.mentorship_event'::regclass AND a.grantee <> c.relowner $$,
  'no role but the owner has any privilege on mentorship_event');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
     CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence',
                             'ductus_migrator']) AS r
     WHERE has_table_privilege(r, 'audit.mentorship_event', p) $$,
  'the access matrix of mentorship_event: no application role and not the migrator reads, writes or empties it');

-- 2. request_mentorship, one class per row, in this order.
CREATE TEMP TABLE request_case (n int PRIMARY KEY, actor text, teacher text, work_type text, expected text, note text);
INSERT INTO request_case VALUES
  (1, 'anon', 'vesna', 'bachelor_thesis', 'ZD401: not authenticated', 'no session'),
  (2, 'boris', 'nina', 'bachelor_thesis', 'ZD403: forbidden', 'teacher without a confirmed role'),
  (3, 'boris', 'petra', 'bachelor_thesis', 'ZD403: forbidden', 'teacher of another institution'),
  (4, 'boris', 'iva', 'bachelor_thesis', 'ZD403: forbidden', 'administrator, not a teacher'),
  (5, 'boris', 'dora', 'bachelor_thesis', 'ZD403: forbidden', 'a student'),
  (6, 'boris', 'nobody', 'bachelor_thesis', 'ZD403: forbidden', 'nobody'),
  (7, 'vesna', 'vesna', 'bachelor_thesis', 'ZD403: forbidden', 'oneself'),
  (8, 'boris', 'vesna', 'essay', 'ZD422: invalid input', 'not a thesis'),
  (9, 'boris', 'vesna', NULL, 'ZD422: invalid input', 'no work type'),
  (10, 'ana', 'vesna', 'master_thesis', 'ZD409: conflict', 'an open mentorship of the kind (ms1)'),
  (11, 'boris', 'vesna', 'bachelor_thesis', 'id', 'Boris asks Vesna'),
  (12, 'boris', 'marko', 'bachelor_thesis', 'ZD409: conflict', 'an open request of the kind'),
  (13, 'dora', 'vesna', 'master_thesis', 'id', 'Dora asks Vesna'),
  (14, 'dora', 'marko', 'specialist_thesis', 'id', 'Dora asks Marko'),
  (15, 'ana', 'ema', 'bachelor_thesis', 'id', 'Ana asks Ema'),
  (16, 'tomo', 'petra', 'doctoral_thesis', 'id', 'Tomo asks Petra (fak-b)');

CREATE TEMP TABLE request_result (n int PRIMARY KEY, result text, events_before bigint, events_after bigint);
DO $$
DECLARE
  c record;
  v_before bigint;
  v_result text;
BEGIN
  FOR c IN SELECT * FROM request_case ORDER BY n LOOP
    v_before := pg_temp.events();
    v_result := pg_temp.ask(c.actor, format('SELECT institution.request_mentorship(%s, %L)',
                                           quote_literal(pg_temp.id(c.teacher)::text) || '::uuid', c.work_type));
    INSERT INTO request_result VALUES (c.n, v_result, v_before, pg_temp.events());
  END LOOP;
END
$$;
SELECT is(pg_temp.shape(r.result), c.expected, format('request %s: %s', c.n, c.note))
FROM request_case c JOIN request_result r USING (n) ORDER BY n;
SELECT is(r.events_after - r.events_before, CASE WHEN c.expected = 'id' THEN 1::bigint ELSE 0 END,
          format('request %s: %s', c.n, CASE WHEN c.expected = 'id' THEN 'one event' ELSE 'no event' END))
FROM request_case c JOIN request_result r USING (n) ORDER BY n;
INSERT INTO ref VALUES
  ('rb', (SELECT result FROM request_result WHERE n = 11)), ('rd', (SELECT result FROM request_result WHERE n = 13)),
  ('rs', (SELECT result FROM request_result WHERE n = 14)), ('re', (SELECT result FROM request_result WHERE n = 15)),
  ('rt', (SELECT result FROM request_result WHERE n = 16));
SELECT is(pg_temp.mentorships(), 3::bigint, 'a request creates no mentorship');

-- 3. Who reads which request. The student reads the own; the teacher the open
-- ones made to them; the administrator and anyone else none.
CREATE FUNCTION pg_temp.sees(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT coalesce(string_agg(z.name, ' ' ORDER BY z.name), '-')
    FROM institution.mentorship_request r JOIN ref z ON z.val = r.id::text $q$)
$$;
SELECT is(pg_temp.sees(v.actor), v.expected, 'reads before approval: ' || v.actor)
FROM (VALUES ('boris', 'rb'), ('dora', 'rd rs'), ('vesna', 'rb rd'), ('marko', 'rs'), ('ema', 're'),
             ('iva', '-'), ('ana', 're'), ('nina', '-'), ('petra', 'rt'), ('lea', '-')) AS v (actor, expected);
SELECT is(pg_temp.ask('vesna', 'SELECT count(*) FROM audit.mentorship_event'),
          '42501: permission denied for schema audit', 'ductus_app reads no event');
SELECT is(pg_temp.ask('boris', $$ INSERT INTO institution.mentorship_request (institution_id, student_id, teacher_id, work_type)
                                  VALUES ({fak_a}, {boris}, {vesna}, 'doctoral_thesis') RETURNING 'written' $$),
          '42501: permission denied for table mentorship_request', 'the student writes a request only through the function');

-- 4. Changes of state before the approvals. Iva revokes Ema's role; another
-- mentorship of Dora's specialist thesis is opened by the operator, so its
-- request can no longer be approved.
SELECT is(pg_temp.ask('iva', $$ SELECT institution.revoke_teacher_role({ema})::text $$), 'true', 'Iva revokes Ema''s role');
INSERT INTO institution.mentorship (institution_id, mentor_id, student_id, work_type)
VALUES (pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.id('dora'), 'specialist_thesis');
SELECT is(pg_temp.sees('ema'), '-', 'a revoked teacher reads no request made to them');

-- 5. withdraw_mentorship_request, in this order.
CREATE TEMP TABLE withdraw_case (n int PRIMARY KEY, actor text, request text, expected text, note text);
INSERT INTO withdraw_case VALUES
  (1, 'anon', 'rd', 'ZD401: not authenticated', 'no session'),
  (2, 'vesna', 'rd', 'ZD403: forbidden', 'the teacher asked'),
  (3, 'iva', 'rd', 'ZD403: forbidden', 'administrator'),
  (4, 'boris', 'rd', 'ZD403: forbidden', 'another student'),
  (5, 'dora', 'nobody', 'ZD403: forbidden', 'no such request'),
  (6, 'dora', 'rd', 'true', 'the own open request'),
  (7, 'dora', 'rd', 'false', 'withdrawn again');
CREATE TEMP TABLE withdraw_result (n int PRIMARY KEY, result text, events bigint);
DO $$
DECLARE
  c record;
  v_before bigint;
BEGIN
  FOR c IN SELECT * FROM withdraw_case ORDER BY n LOOP
    v_before := pg_temp.events();
    INSERT INTO withdraw_result VALUES (c.n,
      pg_temp.ask(c.actor, format('SELECT institution.withdraw_mentorship_request(%L::uuid)::text', pg_temp.id(c.request))),
      pg_temp.events() - v_before);
  END LOOP;
END
$$;
SELECT is(r.result, c.expected, format('withdraw %s: %s', c.n, c.note)) FROM withdraw_case c JOIN withdraw_result r USING (n) ORDER BY n;
SELECT is(r.events, CASE WHEN c.expected = 'true' THEN 1::bigint ELSE 0 END, format('withdraw %s: events written', c.n))
FROM withdraw_case c JOIN withdraw_result r USING (n) ORDER BY n;

-- 6. approve_mentorship_request, in this order: everyone but Vesna fails on
-- Boris's request before she approves it, twice.
CREATE TEMP TABLE approve_case (n int PRIMARY KEY, actor text, request text, expected text, mentorships int, events int, note text);
INSERT INTO approve_case VALUES
  (1, 'anon', 'rb', 'ZD401: not authenticated', 0, 0, 'no session'),
  (2, 'marko', 'rb', 'ZD403: forbidden', 0, 0, 'another teacher of the institution'),
  (3, 'nina', 'rb', 'ZD403: forbidden', 0, 0, 'teacher without a confirmed role'),
  (4, 'petra', 'rb', 'ZD403: forbidden', 0, 0, 'teacher of another institution'),
  (5, 'iva', 'rb', 'ZD403: forbidden', 0, 0, 'administrator'),
  (6, 'boris', 'rb', 'ZD403: forbidden', 0, 0, 'the student who asked'),
  (7, 'dora', 'rb', 'ZD403: forbidden', 0, 0, 'another student'),
  (8, 'vesna', 'nobody', 'ZD403: forbidden', 0, 0, 'no such request'),
  (9, 'vesna', 'rt', 'ZD403: forbidden', 0, 0, 'someone else''s request in another institution'),
  (10, 'vesna', 'rs', 'ZD403: forbidden', 0, 0, 'someone else''s request in the institution'),
  (11, 'ema', 're', 'ZD403: forbidden', 0, 0, 'the teacher asked, with the role revoked'),
  (12, 'vesna', 'rd', 'ZD409: conflict', 0, 0, 'a withdrawn request'),
  (13, 'marko', 'rs', 'ZD409: conflict', 0, 0, 'the student already has an open mentorship of the kind'),
  (14, 'vesna', 'rb', 'id', 1, 1, 'the teacher asked, with the role confirmed'),
  (15, 'vesna', 'rb', 'id', 0, 0, 'approved again'),
  (16, 'petra', 'rt', 'id', 1, 1, 'the teacher asked in fak-b');
CREATE TEMP TABLE approve_result (n int PRIMARY KEY, result text, mentorships bigint, events bigint);
DO $$
DECLARE
  c record;
  v_m bigint;
  v_e bigint;
BEGIN
  FOR c IN SELECT * FROM approve_case ORDER BY n LOOP
    v_m := pg_temp.mentorships();
    v_e := pg_temp.events();
    INSERT INTO approve_result VALUES (c.n,
      pg_temp.ask(c.actor, format('SELECT institution.approve_mentorship_request(%L::uuid)', pg_temp.id(c.request))),
      pg_temp.mentorships() - v_m, pg_temp.events() - v_e);
  END LOOP;
END
$$;
SELECT is(pg_temp.shape(r.result), c.expected, format('approve %s: %s', c.n, c.note))
FROM approve_case c JOIN approve_result r USING (n) ORDER BY n;
SELECT is(r.mentorships, c.mentorships::bigint, format('approve %s: mentorships created', c.n))
FROM approve_case c JOIN approve_result r USING (n) ORDER BY n;
SELECT is(r.events, c.events::bigint, format('approve %s: events written', c.n))
FROM approve_case c JOIN approve_result r USING (n) ORDER BY n;
SELECT is((SELECT result FROM approve_result WHERE n = 15), (SELECT result FROM approve_result WHERE n = 14),
          'approving again returns the same mentorship');
SELECT is(pg_temp.ask('boris', format('SELECT institution.withdraw_mentorship_request(%L::uuid)::text', pg_temp.id('rb'))),
          'ZD409: conflict', 'an approved request cannot be withdrawn');

-- 7. What the approval wrote.
SELECT row_eq(
  format($$ SELECT m.institution_id, m.mentor_id, m.student_id, m.work_type, m.confirmed_by, m.ended_at IS NULL
            FROM institution.mentorship m WHERE m.id = %L $$, (SELECT result FROM approve_result WHERE n = 14)),
  ROW(pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.id('boris'), 'bachelor_thesis'::text, pg_temp.id('vesna'), true),
  'the mentorship has Vesna as mentor and as the one who confirmed it, and is open'
);
SELECT row_eq(
  format($$ SELECT r.approved_at IS NOT NULL, r.mentorship_id::text FROM institution.mentorship_request r WHERE r.id = %L $$,
         pg_temp.id('rb')),
  ROW(true, (SELECT result FROM approve_result WHERE n = 14)), 'the request points to its mentorship'
);
SELECT bag_eq(
  $$ SELECT z.name AS request, e.kind, a.name AS actor, (e.mentorship_id IS NOT NULL) AS linked
     FROM audit.mentorship_event e JOIN ref z ON z.val = e.request_id::text JOIN person a ON a.id = e.actor_id $$,
  $$ VALUES ('rb', 'requested', 'boris', false), ('rd', 'requested', 'dora', false), ('rs', 'requested', 'dora', false),
            ('re', 'requested', 'ana', false), ('rt', 'requested', 'tomo', false), ('rd', 'withdrawn', 'dora', false),
            ('rb', 'approved', 'vesna', true), ('rt', 'approved', 'petra', true) $$,
  'the trail: every request, the one withdrawal and the two approvals, each with its actor'
);
SELECT is(pg_temp.ask('boris', $$ SELECT string_agg(p.name, ' ' ORDER BY p.name) FROM institution.mentorship m
                                  JOIN person p ON p.id = m.mentor_id $$),
          'nina vesna', 'Boris reads the new mentorship');
SELECT is(pg_temp.sees('vesna'), '-', 'an approved request is no longer open for the teacher');

-- 7b. SRV-28: decline_mentorship_request. Three new open requests: Dora asks
-- Vesna again for her master's thesis (rd2, the withdrawn rd does not block
-- it), Ana asks Vesna for a doctoral thesis (ra), Boris asks Marko for a
-- specialist thesis (rbm). The reason is invented text.
INSERT INTO ref VALUES
  ('rd2', pg_temp.ask('dora', $$ SELECT institution.request_mentorship({vesna}, 'master_thesis') $$)),
  ('ra', pg_temp.ask('ana', $$ SELECT institution.request_mentorship({vesna}, 'doctoral_thesis') $$)),
  ('rbm', pg_temp.ask('boris', $$ SELECT institution.request_mentorship({marko}, 'specialist_thesis') $$));
SELECT is_empty($$ SELECT name || ': ' || val FROM ref WHERE name IN ('rd2', 'ra', 'rbm') AND val !~ '^[0-9a-f-]{36}$' $$,
  'the three requests to decline are made through the function');
CREATE TEMP TABLE decline_case (n int PRIMARY KEY, actor text, request text, reason text, expected text, events int, note text);
INSERT INTO decline_case VALUES
  (1, 'anon', 'rd2', NULL, 'ZD401: not authenticated', 0, 'no session'),
  (2, 'marko', 'rd2', NULL, 'ZD403: forbidden', 0, 'another teacher of the institution'),
  (3, 'nina', 'rd2', NULL, 'ZD403: forbidden', 0, 'teacher without a confirmed role'),
  (4, 'petra', 'rd2', NULL, 'ZD403: forbidden', 0, 'teacher of another institution'),
  (5, 'iva', 'rd2', NULL, 'ZD403: forbidden', 0, 'administrator'),
  (6, 'dora', 'rd2', NULL, 'ZD403: forbidden', 0, 'the student who asked'),
  (7, 'boris', 'rd2', NULL, 'ZD403: forbidden', 0, 'another student'),
  (8, 'vesna', 'nobody', NULL, 'ZD403: forbidden', 0, 'no such request'),
  (9, 'vesna', 'rs', NULL, 'ZD403: forbidden', 0, 'someone else''s request in the institution'),
  (10, 'vesna', 'rt', NULL, 'ZD403: forbidden', 0, 'someone else''s request in another institution'),
  (11, 'ema', 're', NULL, 'ZD403: forbidden', 0, 'the teacher asked, with the role revoked'),
  (12, 'vesna', 'rd2', repeat('a', 601), 'ZD422: invalid input', 0, 'a reason of 601 characters'),
  (13, 'vesna', 'rd2', '', 'ZD422: invalid input', 0, 'an empty reason'),
  (14, 'vesna', 'rd2', E' \t\n', 'ZD422: invalid input', 0, 'a blank reason'),
  (15, 'vesna', 'rb', NULL, 'ZD409: conflict', 0, 'an approved request'),
  (16, 'vesna', 'rd', NULL, 'ZD409: conflict', 0, 'a withdrawn request'),
  (17, 'vesna', 'rd2', 'Kvota mentorstava za ovu godinu je popunjena.', 'true', 1, 'the teacher asked, with a reason'),
  (18, 'vesna', 'rd2', 'Drugi razlog.', 'false', 0, 'declined again: nothing is written'),
  (19, 'vesna', 'ra', repeat('b', 600), 'true', 1, 'a reason of 600 characters'),
  (20, 'marko', 'rbm', NULL, 'true', 1, 'the teacher asked, without a reason');
CREATE TEMP TABLE decline_result (n int PRIMARY KEY, result text, mentorships bigint, events bigint);
DO $$
DECLARE
  c record;
  v_m bigint;
  v_e bigint;
BEGIN
  FOR c IN SELECT * FROM decline_case ORDER BY n LOOP
    v_m := pg_temp.mentorships();
    v_e := pg_temp.events();
    INSERT INTO decline_result VALUES (c.n,
      pg_temp.ask(c.actor, format('SELECT institution.decline_mentorship_request(%L::uuid, %L)::text',
                                  pg_temp.id(c.request), c.reason)),
      pg_temp.mentorships() - v_m, pg_temp.events() - v_e);
  END LOOP;
END
$$;
SELECT is(r.result, c.expected, format('decline %s: %s', c.n, c.note))
FROM decline_case c JOIN decline_result r USING (n) ORDER BY n;
SELECT is(r.events, c.events::bigint, format('decline %s: events written', c.n))
FROM decline_case c JOIN decline_result r USING (n) ORDER BY n;
SELECT is((SELECT sum(mentorships) FROM decline_result), 0::numeric, 'declining creates no mentorship');

-- What the declines wrote, and what a declined request still allows.
SELECT bag_eq(
  $$ SELECT z.name AS request, a.name AS actor, e.reason
     FROM audit.mentorship_event e JOIN ref z ON z.val = e.request_id::text JOIN person a ON a.id = e.actor_id
     WHERE e.kind = 'declined' $$,
  $$ VALUES ('rd2', 'vesna', 'Kvota mentorstava za ovu godinu je popunjena.'), ('ra', 'vesna', repeat('b', 600)),
            ('rbm', 'marko', NULL) $$,
  'one declined event per request, with the teacher as actor and the first reason only');
SELECT is(
  (SELECT string_agg(z.name, ' ' ORDER BY z.name) FROM institution.mentorship_request r JOIN ref z ON z.val = r.id::text
    WHERE r.declined_at IS NOT NULL AND r.withdrawn_at IS NULL AND r.approved_at IS NULL AND r.mentorship_id IS NULL),
  'ra rbm rd2', 'the three requests are declined and nothing else');
SELECT is(pg_temp.ask('vesna', format('SELECT institution.approve_mentorship_request(%L::uuid)', pg_temp.id('rd2'))),
  'ZD409: conflict', 'a declined request cannot be approved');
SELECT is(pg_temp.ask('dora', format('SELECT institution.withdraw_mentorship_request(%L::uuid)::text', pg_temp.id('rd2'))),
  'ZD409: conflict', 'a declined request cannot be withdrawn');
SELECT is(pg_temp.sees('vesna'), '-', 'a declined request is no longer open for the teacher');
SELECT is(pg_temp.sees('dora'), 'rd rd2 rs', 'the student still reads the own declined request');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*)::text FROM institution.mentorship_request WHERE declined_at IS NOT NULL $$),
  '1', 'and sees that it was declined, but not the reason, which is only in the trail');
INSERT INTO ref VALUES ('rd3', pg_temp.ask('dora', $$ SELECT institution.request_mentorship({vesna}, 'master_thesis') $$));
SELECT matches((SELECT val FROM ref WHERE name = 'rd3'), '^[0-9a-f-]{36}$', 'a declined request does not block a new one');
SELECT is(pg_temp.sees('vesna'), 'rd3', 'the new request is open for the teacher');
SELECT throws_ok(
  format($$ INSERT INTO audit.mentorship_event (institution_id, request_id, student_id, teacher_id, kind, actor_id, reason, occurred_at)
            VALUES (%L, %L, %L, %L, 'withdrawn', %L, 'Razlog.', now()) $$,
         pg_temp.id('fak_a'), pg_temp.id('rd3'), pg_temp.id('dora'), pg_temp.id('vesna'), pg_temp.id('dora')),
  '23514', NULL, 'only a declined event carries a reason');

-- 8. The trail cannot be changed.
SELECT throws_ok($$ UPDATE audit.mentorship_event SET kind = 'withdrawn' $$, NULL, NULL, 'an event is not updated');
SELECT throws_ok($$ DELETE FROM audit.mentorship_event $$, NULL, NULL, 'an event is not deleted');
SELECT throws_ok($$ TRUNCATE audit.mentorship_event CASCADE $$, NULL, NULL, 'the events are not truncated');

-- 9. Forced RLS is the protection, not only the missing grants: with a
-- mistaken grant the student, the teacher and the administrator still read,
-- write, change and delete no event.
GRANT USAGE ON SCHEMA audit TO ductus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit.mentorship_event TO ductus_app;
SELECT is(pg_temp.ask(v.actor, 'SELECT count(*)::text FROM audit.mentorship_event'), '0',
          'with a mistaken grant ' || v.actor || ' reads no event')
FROM (VALUES ('boris'), ('vesna'), ('iva')) AS v (actor);
SELECT is(left(pg_temp.ask(v.actor, $$ INSERT INTO audit.mentorship_event
            (institution_id, request_id, student_id, teacher_id, kind, actor_id, occurred_at)
            VALUES ({fak_a}, {rb}, {boris}, {vesna}, 'withdrawn', {boris}, now()) RETURNING 'written' $$), 6),
          '42501:', 'with a mistaken grant ' || v.actor || ' writes no event')
FROM (VALUES ('boris'), ('vesna'), ('iva')) AS v (actor);
SELECT is(pg_temp.ask(v.actor, $$ UPDATE audit.mentorship_event SET actor_id = {iva} RETURNING 'changed' $$), NULL,
          'with a mistaken grant ' || v.actor || ' changes no event')
FROM (VALUES ('boris'), ('vesna'), ('iva')) AS v (actor);
SELECT is(pg_temp.ask(v.actor, $$ DELETE FROM audit.mentorship_event RETURNING 'deleted' $$), NULL,
          'with a mistaken grant ' || v.actor || ' deletes no event')
FROM (VALUES ('boris'), ('vesna'), ('iva')) AS v (actor);
REVOKE SELECT, INSERT, UPDATE, DELETE ON audit.mentorship_event FROM ductus_app;
REVOKE USAGE ON SCHEMA audit FROM ductus_app;
SELECT is(pg_temp.events(), 15::bigint, 'the trail is unchanged');

SELECT * FROM finish();
ROLLBACK;
