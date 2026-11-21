-- SRV-1814. All people and report descriptions are synthetic.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT plan(19);

CREATE FUNCTION pg_temp.send_report(p_actor text, p_description text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT identity.submit_problem_report(''technical'', %L, NULL, ''1.0.0'', ''other'', NULL, NULL)',
    p_description));
$$;

SELECT matches(pg_temp.send_report('ana', repeat('🧪', 2000)), '^PR-[0-9A-F]{10}$',
  'accepts 2000 Unicode code points');
SELECT is(pg_temp.send_report('ana', repeat('🧪', 2001)), 'ZD422: invalid input',
  'refuses 2001 Unicode code points');
SELECT matches(pg_temp.send_report('dora', 'Izmišljeni primjer A.'), '^PR-[0-9A-F]{10}$',
  'another student in the same institution submits');
SELECT matches(pg_temp.send_report('tomo', 'Izmišljeni primjer B.'), '^PR-[0-9A-F]{10}$',
  'a student in a different institution submits');

SELECT is(pg_temp.ask(actor, 'SELECT string_agg(user_id::text, '','') FROM identity.problem_report'),
  pg_temp.id(actor)::text, actor || ' sees exactly their own report')
FROM unnest(ARRAY['ana', 'dora', 'tomo']) AS actors(actor);
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM identity.problem_report'), '0',
  'institution administrator gets no support privilege');
SELECT is(pg_temp.ask(actor, 'SELECT count(*)::text FROM identity.problem_report'), '0',
  actor || ' sees no reports')
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS actors(actor);
SELECT is(pg_temp.ask_as('ductus_problem_report_reader', 'anon',
  'SELECT count(DISTINCT user_id)::text FROM identity.problem_report'), '3',
  'the operations reader sees all reporters across institutions');
SELECT is(pg_temp.ask_as('ductus_problem_report_reader', 'anon',
  'DELETE FROM identity.problem_report'), '42501: permission denied for table problem_report',
  'the operations reader cannot mutate reports');
SELECT ok(NOT pg_has_role('ductus_app', 'ductus_problem_report_reader', 'MEMBER') AND
  NOT has_function_privilege('ductus_problem_report_reader',
    'identity.submit_problem_report(text,text,text,text,text,integer,text)', 'EXECUTE'),
  'there is no role escalation or submission privilege for the reader');

SELECT ok(bool_and(reference ~ '^PR-[0-9A-F]{10}$') AND count(reference) = 4,
  'the remaining four reports fit under the hourly limit')
FROM (SELECT pg_temp.send_report('ana', 'Izmišljeni opis ' || n) AS reference
      FROM generate_series(1, 4) AS n) accepted;
SELECT is(pg_temp.send_report('ana', 'Šesta izmišljena prijava.'), 'ZD429: too many reports',
  'the sixth report in the hour is refused');
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM identity.problem_report'), '5',
  'only the five accepted reports were persisted');
SELECT matches(pg_temp.send_report('tomo', 'Druga izmišljena prijava.'), '^PR-[0-9A-F]{10}$',
  'a different account still has its own quota');

SELECT * FROM finish();
ROLLBACK;
