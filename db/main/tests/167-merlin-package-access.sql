-- SRV-1110 (wave 11, N-18, C-16, D4): the Merlin package of an assignment.
-- Only the teacher of the work asks for, reads and downloads a package, and
-- only the one who asked; the same request key is the same package; a
-- package is ready only with a ZIP whose fingerprint the database computed;
-- it expires 24 hours after it was built; every download is recorded and no
-- record changes. Every person, course and byte below is invented
-- (fixtures/institution.inc: Vesna teaches K1 with Z1, Marko teaches K2, Ana
-- and Dora study in K1, Petra and Tomo are of fak-b).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- 'ok' or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.code(p_answer text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_answer ~ '^[0-9A-Z]{5}: ' THEN substr(p_answer, 1, 5) ELSE 'ok' END $$;
-- An invented ZIP: the local header signature and zeros.
CREATE FUNCTION pg_temp.zip(p_fill integer) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$ SELECT '\x504b0304'::bytea || decode(repeat(lpad(to_hex(p_fill), 2, '0'), 40), 'hex') $$;

-- Catalogue: forced RLS, only the owner's policy, no direct privilege.
SELECT is((SELECT format('%s|%s|%s', c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole)
             FROM pg_class c WHERE c.oid = t::regclass),
  't|t|ductus_identity', t || ' belongs to the identity role, with RLS forced')
FROM unnest(ARRAY['institution.merlin_package', 'institution.merlin_package_download']) AS t;
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  CROSS JOIN unnest(ARRAY['institution.merlin_package', 'institution.merlin_package_download']) AS t
  WHERE has_table_privilege(r, t, p)
), 'no runtime role reads or writes either table directly');
SELECT ok(NOT has_function_privilege('ductus_app', f, 'EXECUTE'), 'the web role cannot call ' || f)
FROM unnest(ARRAY['institution.own_merlin_package(uuid,uuid)', 'institution.merlin_package_state(text,timestamptz)',
                  'institution.guard_merlin_package()', 'institution.refuse_merlin_package_download_change()']) AS f;

-- Asking: the teacher of the work only; one answer for every refusal.
INSERT INTO ref SELECT 'p1', pg_temp.ask('vesna', $$ SELECT id::text FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$);
SELECT ok((SELECT val FROM ref WHERE name = 'p1') ~ '^[0-9a-f-]{36}$', 'Vesna asks for the package of Z1');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', state, claimed) FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$),
  'queued|f', 'the same key again is the queued package, not to be built twice');
SELECT is(pg_temp.ask('vesna', $$ SELECT id::text FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$),
  (SELECT val FROM ref WHERE name = 'p1'), 'and it is the same package');
SELECT is((SELECT count(*)::integer FROM institution.merlin_package), 1, 'one row for one key');
SELECT is(pg_temp.code(pg_temp.ask(a.name, $$ SELECT id::text FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$)),
  'ZD403', a.name || ' cannot ask for the package of Z1')
FROM (VALUES ('marko'), ('iva'), ('ana'), ('dora'), ('boris'), ('nina'), ('petra'), ('lea'), ('tomo')) AS a (name);
SELECT is(pg_temp.code(pg_temp.ask('anon', $$ SELECT id::text FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$)),
  'ZD401', 'without a session nothing is asked');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT id::text FROM institution.request_merlin_package({z3}, 'kljuc-0001') $$)),
  'ZD403', 'Vesna cannot ask for the package of another institution''s assignment');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT id::text FROM institution.request_merlin_package({nobody}, 'kljuc-0001') $$)),
  'ZD403', 'an assignment that does not exist is the same refusal');
SELECT is(pg_temp.code(pg_temp.ask('vesna', format('SELECT id::text FROM institution.request_merlin_package({z1}, %L)', k.key))),
  'ZD422', 'request key ' || coalesce(k.key, 'null') || ' is refused')
FROM (VALUES ('kratko'), ('ima razmak'), ('kljuc/0001'), (repeat('a', 129)), (NULL)) AS k (key);

-- Reading the state: the one who asked, while teaching the work.
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s|%s', state, sha256 IS NULL, expires_at IS NULL) FROM institution.merlin_package_status({z1}, {p1}) $$),
  'queued|t|t', 'Vesna reads her queued package, without fingerprint or expiry');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');
SELECT is(pg_temp.code(pg_temp.ask(a.name, $$ SELECT state FROM institution.merlin_package_status({z1}, {p1}) $$)),
  'ZD403', a.name || ' cannot read Vesna''s package')
FROM (VALUES ('marko'), ('ana'), ('iva'), ('petra')) AS a (name);
SELECT is(pg_temp.code(pg_temp.ask('anon', $$ SELECT state FROM institution.merlin_package_status({z1}, {p1}) $$)),
  'ZD401', 'without a session no package is read');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT state FROM institution.merlin_package_status({z2}, {p1}) $$)),
  'ZD403', 'the package is read only under its own assignment');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT state FROM institution.merlin_package_status({z1}, {nobody}) $$)),
  'ZD403', 'a package that does not exist is the same refusal');
SELECT isnt(pg_temp.ask('marko', $$ SELECT id::text FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$),
  (SELECT val FROM ref WHERE name = 'p1'), 'another teacher of K1 with the same key gets a package of his own');

-- Building: only a ZIP, only once, the fingerprint the database's.
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, {p1}) $$)),
  'ZD409', 'a queued package cannot be downloaded');
SELECT is(pg_temp.code(pg_temp.ask('vesna', format('SELECT state FROM institution.complete_merlin_package({z1}, {p1}, %L::bytea)', b.bytes))),
  'ZD422', 'content ' || coalesce(b.bytes, 'null') || ' is not a ZIP')
FROM (VALUES ('\x00010203040506070809000102030405060708090001'), ('\x504b0304'), (NULL)) AS b (bytes);
SELECT is(pg_temp.code(pg_temp.ask('marko', $$ SELECT state FROM institution.complete_merlin_package({z1}, {p1}, pg_temp.zip(1)) $$)),
  'ZD403', 'another teacher cannot store Vesna''s package');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s|%s|%s', state, sha256, byte_size, expires_at - statement_timestamp() BETWEEN interval '23 hours 59 minutes' AND interval '24 hours') FROM institution.complete_merlin_package({z1}, {p1}, pg_temp.zip(1)) $$),
  format('ready|%s|44|t', encode(sha256(pg_temp.zip(1)), 'hex')),
  'Vesna stores the ZIP: ready, its SHA-256, its size, valid for 24 hours');
SELECT is((SELECT expires_at - ready_at FROM institution.merlin_package WHERE id = pg_temp.id('p1')), interval '24 hours',
  'the expiry is 24 hours after the package was built');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT state FROM institution.complete_merlin_package({z1}, {p1}, pg_temp.zip(2)) $$)),
  'ZD409', 'a ready package is never built again');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', state, claimed) FROM institution.request_merlin_package({z1}, 'kljuc-0001') $$),
  'ready|f', 'the same key after the build is the ready package');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', state, sha256) FROM institution.merlin_package_status({z1}, {p1}) $$),
  format('ready|%s', encode(sha256(pg_temp.zip(1)), 'hex')), 'the state names the fingerprint of the stored bytes');

-- Downloading: the bytes and a record, in one transaction.
SELECT is(pg_temp.ask('vesna', $$ SELECT encode(content, 'hex') || '|' || sha256 FROM institution.download_merlin_package({z1}, {p1}) $$),
  encode(pg_temp.zip(1), 'hex') || '|' || encode(sha256(pg_temp.zip(1)), 'hex'), 'Vesna downloads the stored bytes');
SELECT row_eq(
  $$ SELECT package_id, assignment_id, downloaded_by, institution_id, sha256 FROM institution.merlin_package_download $$,
  ROW(pg_temp.id('p1'), pg_temp.id('z1'), pg_temp.id('vesna'), pg_temp.id('fak_a'), encode(sha256(pg_temp.zip(1)), 'hex')),
  'the download is recorded with the package, the reader, the institution and the fingerprint');
SELECT is(pg_temp.code(pg_temp.ask(a.name, $$ SELECT sha256 FROM institution.download_merlin_package({z1}, {p1}) $$)),
  'ZD403', a.name || ' cannot download Vesna''s package')
FROM (VALUES ('marko'), ('ana'), ('dora'), ('iva'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.code(pg_temp.ask('anon', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, {p1}) $$)),
  'ZD401', 'without a session nothing is downloaded');
SELECT is((SELECT count(*)::integer FROM institution.merlin_package_download), 1, 'a refused download leaves no record');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, {p1}) $$)), 'ok',
  'Vesna downloads again');
SELECT is((SELECT count(*)::integer FROM institution.merlin_package_download), 2, 'every download is recorded');
-- A teacher who no longer teaches the work loses the package.
DELETE FROM institution.course_member WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, {p1}) $$)), 'ZD403',
  'without the relation, the own package is refused too');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('vesna'), 'teacher');

-- Failing: a closed code, then the same key builds again.
INSERT INTO ref SELECT 'p2', pg_temp.ask('vesna', $$ SELECT id::text FROM institution.request_merlin_package({z1}, 'kljuc-0002') $$);
SELECT is(pg_temp.code(pg_temp.ask('vesna', format('SELECT state FROM institution.fail_merlin_package({z1}, {p2}, %L)', c.code))),
  'ZD422', 'failure code ' || coalesce(c.code, 'null') || ' is refused')
FROM (VALUES ('Roster unavailable'), (''), ('1x'), (NULL)) AS c (code);
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.fail_merlin_package({z1}, {p2}, 'roster_unavailable') $$),
  'failed', 'Vesna records a failure with a closed code');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, {p2}) $$)), 'ZD409',
  'a failed package cannot be downloaded');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s|%s', id = {p2}, state, claimed) FROM institution.request_merlin_package({z1}, 'kljuc-0002') $$),
  't|queued|t', 'the same key after a failure is the same package, queued to be built again');
SELECT is((SELECT failure_code FROM institution.merlin_package WHERE id = pg_temp.id('p2')), NULL,
  'and its failure code is cleared');

-- A builder that never finished: taken again after ten minutes, not before.
INSERT INTO institution.merlin_package (id, institution_id, assignment_id, requested_by, request_key, created_at, claimed_at)
VALUES ('00000000-0000-4000-8000-0000000000f1', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('vesna'), 'kljuc-zastarjeli',
        now() - interval '11 minutes', now() - interval '11 minutes');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', state, claimed) FROM institution.request_merlin_package({z1}, 'kljuc-zastarjeli') $$),
  'queued|t', 'a package queued eleven minutes ago is taken again');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', state, claimed) FROM institution.request_merlin_package({z1}, 'kljuc-zastarjeli') $$),
  'queued|f', 'and just taken, it is not taken twice');

-- Expiry: 24 hours after the build, the state reads expired and nothing is handed out.
INSERT INTO institution.merlin_package (id, institution_id, assignment_id, requested_by, request_key, state, content, sha256,
                                        byte_size, created_at, claimed_at, ready_at, expires_at)
SELECT x.id::uuid, pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('vesna'), x.key, 'ready', pg_temp.zip(3),
       encode(sha256(pg_temp.zip(3)), 'hex'), 44, now() - x.age, now() - x.age, now() - x.age, now() - x.age + interval '24 hours'
FROM (VALUES ('00000000-0000-4000-8000-0000000000f2', 'kljuc-istekli', interval '24 hours 1 minute'),
             ('00000000-0000-4000-8000-0000000000f3', 'kljuc-svjezi', interval '23 hours 59 minutes')) AS x (id, key, age);
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.merlin_package_status({z1}, '00000000-0000-4000-8000-0000000000f2') $$),
  'expired', 'a package built more than 24 hours ago reads expired');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, '00000000-0000-4000-8000-0000000000f2') $$)),
  'ZD410', 'an expired package cannot be downloaded');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', state, claimed) FROM institution.request_merlin_package({z1}, 'kljuc-istekli') $$),
  'expired|f', 'the same key after the expiry is the same expired package');
SELECT is(pg_temp.code(pg_temp.ask('vesna', $$ SELECT sha256 FROM institution.download_merlin_package({z1}, '00000000-0000-4000-8000-0000000000f3') $$)),
  'ok', 'a package built 23 hours 59 minutes ago is still handed out');

-- No change after ready, no removal, no change of a record.
SELECT throws_ok($$ UPDATE institution.merlin_package SET content = pg_temp.zip(9) WHERE id = '00000000-0000-4000-8000-0000000000f3' $$,
  'ZD403', NULL, 'a ready package cannot be changed');
SELECT throws_ok($$ UPDATE institution.merlin_package SET request_key = 'kljuc-drugi' WHERE id = '00000000-0000-4000-8000-0000000000f1' $$,
  'ZD403', NULL, 'the key of a package cannot be changed');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.fail_merlin_package({z1}, {p2}, 'build_timeout') $$),
  'failed', 'Vesna records another failure');
SELECT throws_ok($$ UPDATE institution.merlin_package SET state = 'failed', failure_code = 'other' WHERE state = 'failed' $$,
  'ZD403', NULL, 'a failed package only goes back to queued');
SELECT throws_ok($$ DELETE FROM institution.merlin_package $$, 'ZD403', NULL, 'a package cannot be removed');
SELECT throws_ok($$ TRUNCATE institution.merlin_package, institution.merlin_package_download $$, 'ZD403', NULL,
  'the packages cannot be truncated');
SELECT throws_ok($$ UPDATE institution.merlin_package_download SET sha256 = repeat('0', 64) $$, 'ZD403', NULL,
  'a record of a download cannot be changed');
SELECT throws_ok($$ DELETE FROM institution.merlin_package_download $$, 'ZD403', NULL,
  'a record of a download cannot be removed');
SELECT throws_ok($$ TRUNCATE institution.merlin_package_download $$, 'ZD403', NULL, 'the downloads cannot be truncated');

SELECT * FROM finish();
ROLLBACK;
