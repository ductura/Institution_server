-- SRV-1313 (plan M7.4, DAN-382): the deadline of a submission, with and
-- without an extension (M7.3: SRV-1108, SRV-1108C), across a change of the
-- clock. Every time below is fixed, never now(): the deadline of a version,
-- the extension and the click of the request. The click is the request's
-- requested_at, which app.request_submission takes from the database clock
-- (clock_timestamp()); here the request row is written with a fixed click, as
-- that RPC would have written it at that moment, and app.record_submission,
-- the real decision (requested_at > due_at), judges it. Each judgement is
-- rolled back, so one student is judged at many clicks.
--
--   1. A click a minute before the deadline is on time, a minute after is
--      late; the deadline minute itself is on time. After the clock is set
--      back, a late click stays late: the decision is pinned at the click.
--   2. A deadline in the night of the change to summer time (29 March 2026)
--      and in the repeated hour of the change to winter time (26 October 2025)
--      is an instant: the zone of the session (Europe/Zagreb, UTC, New York,
--      Kiritimati) never changes a decision, and the database reads the same
--      Zagreb wall time of an instant as the server (tests/deadline-clock).
--   3. An extension moves the deadline of its student alone.
--   4. No time comes from the client: neither RPC of a submission takes one.
--
-- The fixed times are in the past, because a submission is recorded with the
-- database clock and recorded_at >= requested_at. Every person, course,
-- document and date is invented (fixtures/institution.inc: Vesna teaches K1,
-- Ana and Dora study in it).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Z1 gets version 3, due at 03:00 on the night of the change to summer time
-- (the first minute after the skipped hour; 01:00 UTC), and version 4, due at
-- 02:30 summer time in the repeated hour of the change to winter time
-- (the first 02:30; 00:30 UTC). Dora gets her own document of Z1.
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
) VALUES
  (pg_temp.id('z1'), 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', timestamptz '2026-03-01 08:00:00+01',
   timestamptz '2026-03-29 03:00:00+02', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna')),
  (pg_temp.id('z1'), 4, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', timestamptz '2025-10-01 08:00:00+02',
   timestamptz '2025-10-26 02:30:00+02', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
SELECT pg_temp.id('z1'), v, pg_temp.id(s), pg_temp.id('fak_a')
  FROM unnest(ARRAY['ana', 'dora']) AS s, unnest(ARRAY[3, 4]) AS v;
RESET ROLE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), pg_temp.h('a'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-d', pg_temp.id('fak_a'), 0, pg_temp.id('dora'), pg_temp.h('a'));
INSERT INTO evidence.package (
  id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id, max_payload_bytes
) VALUES ('pkg-d', pg_temp.id('fak_a'), '00000000-0000-4000-8000-0000000000d1', 'doc-d', 'project-d',
          pg_temp.id('dora'), 'standard-v1', 2097152);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;
RESET ROLE;

SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a',64), repeat('d',64), repeat('b',64)),
  'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.call('dora', 'pkg-d', 'request-d1',
    pg_temp.descriptor(p_package=>'pkg-d', p_document=>'doc-d', p_segment=>'segment-d-1', p_session=>'capture-session-d'),
    0, repeat('a',64), repeat('e',64), repeat('b',64)),
  'reserved', 'fixture: Dora commits revision 1');

-- The click of p_student at p_at on the current version p_version: the request
-- row as app.request_submission writes it (its deadline is the student's
-- effective deadline at the click), then app.record_submission as the student.
-- Returns "outcome after_deadline".
CREATE FUNCTION pg_temp.click(p_student text, p_version integer, p_at timestamptz) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_due timestamptz;
  v_id uuid;
  v_doc text := CASE p_student WHEN 'ana' THEN 'a' ELSE 'd' END;
  v_hash text := CASE p_student WHEN 'ana' THEN pg_temp.h('d') ELSE pg_temp.h('e') END;
BEGIN
  SET LOCAL ROLE ductus_identity;
  UPDATE institution.assignment SET current_version = p_version WHERE id = pg_temp.id('z1');
  RESET ROLE;
  v_due := institution.effective_due_at(pg_temp.id('z1'), pg_temp.id(p_student));
  SET LOCAL ROLE ductus_evidence;
  INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at, due_at
  ) VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), p_version, 'project-' || v_doc, 'doc-' || v_doc,
            pg_temp.id(p_student), 1, v_hash, p_at, v_due)
  RETURNING id INTO v_id;
  RESET ROLE;
  RETURN pg_temp.ask(p_student, format(
    $q$ SELECT concat_ws(' ', outcome, after_deadline) FROM app.record_submission(%L::uuid, %L) $q$, v_id, v_hash));
END
$$;
-- The same, with everything it wrote rolled back. With p_extend_ana, Vesna
-- first extends Ana's deadline (alone) to that instant.
CREATE FUNCTION pg_temp.judge(p_student text, p_version integer, p_at timestamptz,
                              p_extend_ana timestamptz DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    IF p_extend_ana IS NOT NULL THEN
      SET LOCAL ROLE ductus_identity;
      UPDATE institution.assignment SET current_version = p_version WHERE id = pg_temp.id('z1');
      RESET ROLE;
      v := pg_temp.ask('vesna', format(
        $q$ SELECT earlier_submissions::text FROM institution.extend_assignment_deadline({z1}, {ana}, %L, 'justified') $q$,
        p_extend_ana));
      IF v IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'extension refused: %', v;
      END IF;
    END IF;
    v := pg_temp.click(p_student, p_version, p_at);
    RAISE EXCEPTION USING ERRCODE = 'ZZ185';
  EXCEPTION WHEN SQLSTATE 'ZZ185' THEN
    RETURN v;
  END;
END
$$;

-- 1 and 2. Every click below, in the zone of the session given; one line per
-- click, "label outcome after_deadline".
CREATE TEMP TABLE clicks (n integer PRIMARY KEY, label text NOT NULL, version integer NOT NULL, at timestamptz NOT NULL,
                          expected text NOT NULL);
INSERT INTO clicks VALUES
  -- Summer time: the deadline is 03:00, the first minute after the skipped hour.
  (1, 'spring, a minute before (01:59 winter time)', 3, timestamptz '2026-03-29 00:59:00Z', 'recorded f'),
  (2, 'spring, the last second of winter time', 3, timestamptz '2026-03-29 00:59:59.999999Z', 'recorded f'),
  (3, 'spring, the deadline itself', 3, timestamptz '2026-03-29 01:00:00Z', 'recorded f'),
  (4, 'spring, a microsecond after', 3, timestamptz '2026-03-29 01:00:00.000001Z', 'recorded t'),
  (5, 'spring, a minute after (03:01 summer time)', 3, timestamptz '2026-03-29 01:01:00Z', 'recorded t'),
  -- Winter time: the deadline is the first 02:30 (summer time). The second
  -- 02:15 and 02:29 come after it, though the wall clock reads earlier.
  (6, 'autumn, a minute before (02:29 summer time)', 4, timestamptz '2025-10-26 02:29:00+02', 'recorded f'),
  (7, 'autumn, the deadline itself', 4, timestamptz '2025-10-26 02:30:00+02', 'recorded f'),
  (8, 'autumn, a minute after (02:31 summer time)', 4, timestamptz '2025-10-26 02:31:00+02', 'recorded t'),
  (9, 'autumn, the second 02:15 (winter time)', 4, timestamptz '2025-10-26 02:15:00+01', 'recorded t'),
  (10, 'autumn, the second 02:29 (winter time)', 4, timestamptz '2025-10-26 02:29:00+01', 'recorded t'),
  (11, 'autumn, a minute before the change (02:59 summer time)', 4, timestamptz '2025-10-26 00:59:00Z', 'recorded t');

SELECT is(pg_temp.judge('ana', c.version, c.at), c.expected, 'Ana: ' || c.label)
  FROM clicks c ORDER BY c.n;

-- The zone of the session never moves a decision: every click again, in four
-- zones, one answer.
CREATE FUNCTION pg_temp.in_zone(p_zone text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  PERFORM set_config('TimeZone', p_zone, true);
  SELECT string_agg(c.n || ':' || pg_temp.judge('dora', c.version, c.at), ' ' ORDER BY c.n) INTO v FROM clicks c;
  PERFORM set_config('TimeZone', 'UTC', true);
  RETURN v;
END
$$;
SELECT is(pg_temp.in_zone(z.zone),
          (SELECT string_agg(c.n || ':' || c.expected, ' ' ORDER BY c.n) FROM clicks c),
          'Dora, with the session in ' || z.zone || ': every click is judged as in UTC')
  FROM (VALUES ('Europe/Zagreb'), ('UTC'), ('America/New_York'), ('Pacific/Kiritimati')) AS z (zone);

-- 3. An extension moves the deadline of its student alone: Vesna extends Ana's
-- summer-time deadline by an hour; at the same click Ana is on time and Dora
-- is late.
SELECT is(pg_temp.judge('ana', 3, timestamptz '2026-03-29 01:30:00Z', timestamptz '2026-03-29 02:00:00Z'),
  'recorded f', 'with her extension, Ana''s click half an hour after the version''s deadline is on time');
SELECT is(pg_temp.judge('ana', 3, timestamptz '2026-03-29 02:01:00Z', timestamptz '2026-03-29 02:00:00Z'),
  'recorded t', 'a minute after her extended deadline Ana is late');
SELECT is(pg_temp.judge('dora', 3, timestamptz '2026-03-29 01:30:00Z', timestamptz '2026-03-29 02:00:00Z'),
  'recorded t', 'with Ana''s extension, Dora''s click half an hour after the deadline is late');
SELECT is(pg_temp.judge('ana', 4, timestamptz '2025-10-26 02:59:00+01', timestamptz '2025-10-26 03:00:00+01'),
  'recorded f', 'Ana''s extension to 03:00 winter time: her click at the second 02:59 is on time');
SELECT is(pg_temp.judge('dora', 4, timestamptz '2025-10-26 02:59:00+01', timestamptz '2025-10-26 03:00:00+01'),
  'recorded t', 'the same in the repeated hour: the extension of Ana is not Dora''s');
CREATE FUNCTION pg_temp.extended_dues() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    SET LOCAL ROLE ductus_identity;
    UPDATE institution.assignment SET current_version = 4 WHERE id = pg_temp.id('z1');
    RESET ROLE;
    PERFORM pg_temp.ask('vesna', $q$ SELECT institution.extend_assignment_deadline({z1}, {dora},
                                      timestamptz '2025-10-26 02:30:00+01', 'technical') $q$);
    PERFORM set_config('TimeZone', 'UTC', true);
    SELECT concat_ws(' ', institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('ana')),
                     institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('dora')),
                     institution.effective_due_at(pg_temp.id('z1'), NULL)) INTO v;
    RAISE EXCEPTION USING ERRCODE = 'ZZ185';
  EXCEPTION WHEN SQLSTATE 'ZZ185' THEN
    RETURN v;
  END;
END
$$;
SELECT is(pg_temp.extended_dues(), '2025-10-26 00:30:00+00 2025-10-26 01:30:00+00 2025-10-26 00:30:00+00',
  'Dora''s extension to the second 02:30 is an hour after the first: hers alone, the others keep the version''s');

-- 1. The clock set back after a late click. Ana clicks a minute after the
-- summer-time deadline; that request stays (not rolled back).
SET LOCAL ROLE ductus_identity;
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
RESET ROLE;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.submission_request (
    institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
    revision, content_hash, requested_at, due_at
  ) VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), 3, 'project-a', 'doc-a', pg_temp.id('ana'), 1, pg_temp.h('d'),
            timestamptz '2026-03-29 01:01:00Z', timestamptz '2026-03-29 01:00:00Z');
RESET ROLE;
CREATE FUNCTION pg_temp.record_kept() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format(
    $q$ SELECT concat_ws(' ', outcome, after_deadline, requested_at = timestamptz '2026-03-29 01:01:00Z')
          FROM app.record_submission(%L::uuid, %L) $q$, (SELECT id FROM evidence.submission_request WHERE principal_id = pg_temp.id('ana')), pg_temp.h('d')))
$$;
SELECT is(pg_temp.record_kept(), 'recorded t t', 'Ana''s click a minute after the deadline is late');
-- Back on the clock: a new click finds the request already made, at its own
-- click, and recording it again answers the same late submission.
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws(' ', outcome, requested_at = timestamptz '2026-03-29 01:01:00Z')
                                   FROM app.request_submission('doc-a', 1) $$),
  'existing t', 'with the clock set back, a new click returns the first request and its click');
SELECT is(pg_temp.record_kept(), 'existing t t', 'and the submission is still late');
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon',
    $$ UPDATE evidence.submission_request SET requested_at = requested_at - interval '2 minutes'
        WHERE principal_id = {ana} RETURNING 1 $$),
  'ZD403: append-only row', 'not even the owner role moves the click of a request back');

-- 2. The Zagreb wall time of an instant, as the database reads it. The same
-- pairs are the server's (tests/deadline-clock/deadline-clock.test.ts reads
-- this block and checks it with server/domain/time/zagreb.ts).
-- zagreb-wall:begin
CREATE TEMP TABLE wall (at text PRIMARY KEY, zagreb text NOT NULL);
INSERT INTO wall VALUES
  ('2026-03-29T00:59:00.000Z', '2026-03-29T01:59'),
  ('2026-03-29T01:00:00.000Z', '2026-03-29T03:00'),
  ('2026-03-29T01:30:00.000Z', '2026-03-29T03:30'),
  ('2025-10-26T00:30:00.000Z', '2025-10-26T02:30'),
  ('2025-10-26T00:59:00.000Z', '2025-10-26T02:59'),
  ('2025-10-26T01:00:00.000Z', '2025-10-26T02:00'),
  ('2025-10-26T01:30:00.000Z', '2025-10-26T02:30'),
  ('2025-10-26T02:00:00.000Z', '2025-10-26T03:00'),
  ('2027-03-28T00:59:00.000Z', '2027-03-28T01:59'),
  ('2027-03-28T01:00:00.000Z', '2027-03-28T03:00'),
  ('2026-10-25T00:30:00.000Z', '2026-10-25T02:30'),
  ('2026-10-25T01:30:00.000Z', '2026-10-25T02:30'),
  ('2026-12-14T22:59:00.000Z', '2026-12-14T23:59');
-- zagreb-wall:end
SELECT is(to_char(w.at::timestamptz AT TIME ZONE 'Europe/Zagreb', 'YYYY-MM-DD"T"HH24:MI'), w.zagreb,
          w.at || ' is ' || w.zagreb || ' in Zagreb')
  FROM wall w ORDER BY w.at;

-- A Zagreb minute in the repeated hour names two instants. The server takes
-- the first (summer time, zagrebInstant); PostgreSQL would take the second.
-- That is why a deadline reaches the database only as an instant (the
-- contracts take ...Z, the RPCs timestamptz): the database never resolves a
-- wall minute of a deadline itself.
SELECT is((timestamp '2025-10-26 02:30' AT TIME ZONE 'Europe/Zagreb') - timestamptz '2025-10-26 00:30:00Z',
  interval '1 hour', 'PostgreSQL reads the repeated 02:30 as the second one, an hour after the server''s');
SELECT is(
  (SELECT string_agg(format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), ' ' ORDER BY p.proname)
     FROM pg_proc p
    WHERE p.oid IN ('institution.extend_assignment_deadline(uuid,uuid,timestamptz,text)'::regprocedure)),
  'extend_assignment_deadline(p_assignment_id uuid, p_student_id uuid, p_due_at timestamp with time zone, p_reason_id text)',
  'an extension takes its deadline as an instant');

-- 4. No time from the client: neither RPC of a submission takes a time, and
-- the click is the database clock.
SELECT is(
  (SELECT count(*)::integer FROM pg_proc p, unnest(p.proargtypes::oid[]) AS t (oid)
    WHERE p.oid IN ('app.request_submission(text,bigint)'::regprocedure,
                    'app.record_submission(uuid,text)'::regprocedure)
      AND t.oid IN ('timestamptz'::regtype, 'timestamp'::regtype, 'date'::regtype, 'interval'::regtype)),
  0, 'neither request_submission nor record_submission takes a time');
SELECT ok((SELECT prosrc ~ 'v_now timestamptz := pg_catalog\.clock_timestamp\(\)'
             FROM pg_proc WHERE oid = 'app.request_submission(text,bigint)'::regprocedure),
  'the click of a request is the database clock');
SELECT ok(NOT has_column_privilege('ductus_app', 'evidence.submission_request', 'requested_at', 'INSERT')
          AND NOT has_column_privilege('ductus_app', 'evidence.submission_request', 'requested_at', 'UPDATE'),
  'the web role writes no click itself');

SELECT * FROM finish();
ROLLBACK;
