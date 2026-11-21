-- SRV-1906 (plan P-D6): the operator's pilot numbers. Only counts and two
-- durations, never an identifier; a count from 1 to 4, or one derivable from
-- the published ones, is NULL; shown counts are rounded down to a multiple
-- of five; the numbers end at the cutoff. Rows are
-- invented and written with foreign keys off (session_replication_role), so
-- only the counted columns matter. Personas of institution.inc.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- Privileges: the application calls only pilot_metrics(); the raw counts are
-- for the identity owner, the cutoff variant for nobody but its owner.
SELECT ok(p.prosecdef AND 'search_path=""' = ANY(p.proconfig), f || ': definer with an empty path')
  FROM unnest(ARRAY['app.pilot_metrics()', 'app.pilot_evidence_counts(timestamptz)']) f
  JOIN pg_proc p ON p.oid = to_regprocedure(f);
SELECT ok(NOT p.prosecdef AND 'search_path=""' = ANY(p.proconfig), 'app.pilot_metrics_at: invoker, empty path')
  FROM pg_proc p WHERE p.oid = to_regprocedure('app.pilot_metrics_at(timestamptz)');
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || f
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
           UNION ALL SELECT 'public') r
     CROSS JOIN unnest(ARRAY['app.pilot_metrics()', 'app.pilot_metrics_at(timestamptz)',
                             'app.pilot_evidence_counts(timestamptz)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE')
       AND (SELECT proowner FROM pg_proc WHERE oid = to_regprocedure(f)) <> to_regrole(r.rolname) $$,
  ARRAY['ductus_app app.pilot_metrics()', 'ductus_identity app.pilot_evidence_counts(timestamptz)'],
  'P-D6: only ductus_app calls pilot_metrics(), only the identity owner the raw counts'
);
SELECT is(
  ARRAY(SELECT unnest(p.proargnames) FROM pg_proc p WHERE p.oid = 'app.pilot_metrics()'::regprocedure),
  ARRAY['as_of', 'submissions_recorded', 'submissions_not_recorded', 'receipts_issued', 'receipts_pending',
        'help_requests', 'save_problem_reports', 'receipt_p50_ms', 'receipt_p95_ms'],
  'P-D6: the columns hold no identifier and no text'
);
SELECT is(pg_temp.ask(a, 'SELECT count(*)::text FROM app.pilot_metrics()'), 'ZD401: not authenticated',
  'P-D6: without a live session (' || a || ') ZD401')
  FROM unnest(ARRAY['anon', 'closed', 'unknown']) a;
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM app.pilot_evidence_counts(now())'),
  '42501: permission denied for function pilot_evidence_counts', 'P-D6: the web role has no raw counts');
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM app.pilot_metrics_at(now())'),
  '42501: permission denied for function pilot_metrics_at', 'P-D6: the web role sets no cutoff');

-- Day d (from 2026-01-0d): p_done requests become submissions, p_open stay
-- requests; the first p_signed submissions get a receipt k seconds after
-- their request (k = p_first, p_first + 1, ...).
SET LOCAL session_replication_role = replica;
CREATE FUNCTION pg_temp.seed(p_day int, p_done int, p_open int, p_signed int, p_first int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_at timestamptz := timestamptz '2026-01-01 08:00:00+00' + (p_day - 1) * interval '1 day';
  v_req uuid;
  v_sub uuid;
  v_who uuid;
  v_payload text;
BEGIN
  FOR i IN 1 .. p_done + p_open LOOP
    v_req := gen_random_uuid();
    v_who := gen_random_uuid();
    INSERT INTO evidence.submission_request (id, institution_id, assignment_id, assignment_version, project_id,
      document_id, principal_id, revision, content_hash, requested_at)
    VALUES (v_req, pg_temp.id('fak_a'), pg_temp.id('z1'), 1, 'p', 'd', v_who, 1, repeat('a', 64), v_at);
    CONTINUE WHEN i > p_done;
    v_sub := gen_random_uuid();
    INSERT INTO evidence.submission (id, submission_request_id, institution_id, principal_id, assignment_id,
      assignment_version, revision, artifact_hash, requested_at, due_at, recorded_at)
    VALUES (v_sub, v_req, pg_temp.id('fak_a'), v_who, pg_temp.id('z1'), 1, 1, repeat('a', 64), v_at,
      v_at + interval '1 day', v_at + interval '1 second');
    CONTINUE WHEN i > p_signed;
    v_payload := 'izmisljena-potvrda-' || v_sub;
    INSERT INTO evidence.submission_receipt (submission_id, institution_id, principal_id, issuance_id, key_id,
      key_version, signed_at, receipt_payload, payload_digest_sha256, signature)
    VALUES (v_sub, pg_temp.id('fak_a'), v_who, gen_random_uuid(), 'k', '1',
      v_at + (p_first + i - 1) * interval '1 second', v_payload,
      encode(sha256(convert_to(v_payload, 'UTF8')), 'hex'), '{"keyId": "k", "keyVersion": "1"}');
  END LOOP;
END
$$;
-- p_save of p_count help requests on day d report a save problem.
CREATE FUNCTION pg_temp.report(p_day int, p_count int, p_save int) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO identity.problem_report (reference, institution_id, user_id, category, description, app_version,
    browser_family, sync_state, created_at)
  SELECT 'PR-' || upper(substr(md5(random()::text), 1, 10)), pg_temp.id('fak_a'), pg_temp.id('ana'), 'technical',
         'Izmišljeni opis', '1.0.0', 'other', CASE WHEN n <= p_save THEN 'ERROR' END,
         timestamptz '2026-01-01 09:00:00+00' + (p_day - 1) * interval '1 day'
    FROM generate_series(1, p_count) n
$$;

CREATE FUNCTION pg_temp.at(p_day int) RETURNS text
LANGUAGE sql AS $$
  SELECT concat_ws(' ', submissions_recorded, submissions_not_recorded, receipts_issued, receipts_pending,
                   help_requests, save_problem_reports, receipt_p50_ms, receipt_p95_ms)
    FROM app.pilot_metrics_at(timestamptz '2026-01-01 00:00:00+00' + p_day * interval '1 day')
$$;

SELECT is(pg_temp.at(0), '0 0 0 0 0 0', 'P-D6: no data: zeros, no durations');

SELECT pg_temp.seed(1, 6, 0, 5, 1);
SELECT pg_temp.report(1, 6, 2);
-- Six recorded (shown as 5); five receipts against one pending hide both,
-- and the durations with them: a shown duration would prove five receipts
-- and so the one pending. Two save reports against four others are hidden.
SELECT is(pg_temp.at(1), '5 0 5', 'P-D6: day 1: counts rounded down, small parts hidden');
SELECT is(
  (SELECT row(receipts_issued, receipts_pending, receipt_p50_ms, receipt_p95_ms, save_problem_reports)::text
     FROM app.pilot_metrics_at('2026-01-02')),
  '(,,,,)', 'P-D6: day 1: a hidden receipt partition hides the durations too');

SELECT pg_temp.seed(2, 4, 5, 0, 0);
SELECT pg_temp.report(2, 3, 3);
-- Ten recorded, five open; five receipts 1..5 s after the request, five
-- pending; nine help requests (shown as 5), five about saving, four others.
SELECT is(pg_temp.at(2), '10 5 5 5 5 3000 4800', 'P-D6: day 2: receipts and durations from five up');
SELECT is(pg_temp.at(1), '5 0 5', 'P-D6: the cutoff leaves out the later day');

SELECT pg_temp.report(3, 1, 0);
-- One more help request: ten, so five about saving against five others.
SELECT is(pg_temp.at(3), '10 5 5 5 10 5 3000 4800', 'P-D6: day 3: five save reports against five others');
SELECT ok(
  (SELECT help_requests FROM app.pilot_metrics_at('2026-01-04'))
    - (SELECT help_requests FROM app.pilot_metrics_at('2026-01-03')) IN (0, 5),
  'P-D6: one new help request is no difference of one between two days');

-- Day 4: five more receipts, about 34.7 days after their requests.
SELECT pg_temp.seed(4, 5, 0, 5, 3000000);
SELECT is(pg_temp.at(5), '15 5 5 10 10 5 3000 4800', 'P-D6: receipts after the cutoff are pending');
-- p95 of ten durations is 3 000 003 550 ms, above the integer range: capped.
SELECT is(pg_temp.at(60), '15 5 10 5 10 5 1500002500 2147483647',
  'P-D6: a duration above the integer range is capped, the counts stay');

-- The application reads the same numbers up to the start of today in Zagreb.
SELECT is(
  pg_temp.ask('ana', $$ SELECT concat_ws(' ', as_of = date_trunc('day', statement_timestamp(), 'Europe/Zagreb'),
    submissions_recorded, submissions_not_recorded, receipts_issued, receipts_pending, help_requests,
    save_problem_reports, receipt_p50_ms, receipt_p95_ms) FROM app.pilot_metrics() $$),
  't 15 5 10 5 10 5 1500002500 2147483647', 'P-D6: pilot_metrics() ends at the start of the day in Zagreb');

SELECT * FROM finish();
ROLLBACK;
