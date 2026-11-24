-- SRV-V19-DNEVNIK-BAZA: the journal of a professional practice with the mentor's
-- signature (20261219100000). Personas of institution.inc and mentorship.inc, all
-- invented: Marko mentors Ana (ms1, open); Vesna mentored Dora (ms2, ended); Iva is
-- the administrator of fak-a, Lea of fak-b; Boris, Tomo and Petra have no part in
-- Ana's practice. Dates are relative to today so the test does not age.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- 1. Catalogue: forced RLS, append-only, no table privilege for the web role, RPCs only for it.
SELECT ok(relrowsecurity AND relforcerowsecurity AND relowner = 'ductus_identity'::regrole,
  relname || ' has forced row security and the identity owner')
  FROM pg_class WHERE oid IN ('institution.practice_placement'::regclass, 'institution.practice_entry'::regclass,
                              'institution.practice_signoff'::regclass);
SELECT ok(NOT has_table_privilege(r, name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'), r || ' has no privilege on ' || name)
  FROM (VALUES ('institution.practice_placement'), ('institution.practice_entry'), ('institution.practice_signoff')) AS t(name)
  CROSS JOIN (VALUES ('ductus_app'), ('ductus_worker'), ('ductus_evidence'), ('public')) AS x(r);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('ductus_evidence'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.open_practice_placement(uuid,text,date,date)',
    'app.add_practice_entry(uuid,date,numeric,text,uuid)', 'app.sign_practice_entries(uuid,date,text)',
    'app.practice_placements()', 'app.practice_entries(uuid)', 'app.practice_signoffs(uuid)',
    'institution.practice_context(uuid)', 'institution.practice_entries_digest(uuid,date)']) AS f;
SELECT ok(has_function_privilege('ductus_app', f, 'EXECUTE'), 'the web role calls ' || f)
  FROM unnest(ARRAY['app.open_practice_placement(uuid,text,date,date)',
    'app.add_practice_entry(uuid,date,numeric,text,uuid)', 'app.sign_practice_entries(uuid,date,text)',
    'app.practice_placements()', 'app.practice_entries(uuid)', 'app.practice_signoffs(uuid)']) AS f;
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_identity', 'institution', 'CREATE'),
  'after the migration the owner keeps no CREATE');

-- Helpers.
CREATE FUNCTION pg_temp.d(p_days integer) RETURNS text LANGUAGE sql STABLE AS $$ SELECT (current_date + p_days)::text $$;
CREATE FUNCTION pg_temp.open(p_actor text, p_ms text, p_org text, p_from integer, p_to integer) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.open_practice_placement(%L::uuid, %L, %L::date, %L::date)',
    pg_temp.id(p_ms), p_org, pg_temp.d(p_from), pg_temp.d(p_to)))
$$;
CREATE FUNCTION pg_temp.add(p_actor text, p_pl text, p_day integer, p_hours text, p_text text, p_corr text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.add_practice_entry(%L::uuid, %L::date, %L::numeric, %L, %L::uuid)',
    p_pl, pg_temp.d(p_day), p_hours, p_text, p_corr))
$$;
CREATE FUNCTION pg_temp.sign(p_actor text, p_pl text, p_day integer, p_comment text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, entry_count, entries_sha256) FROM app.sign_practice_entries(%L::uuid, %L::date, %L)',
    ':', p_pl, pg_temp.d(p_day), p_comment))
$$;

-- 2. Opening: only the mentor of an open mentorship; anything else is the same ZD404.
SELECT is(pg_temp.open('anon', 'ms1', 'Organizacija A', -30, 30), 'ZD401: not authenticated', 'no session, no practice');
SELECT is(pg_temp.open(a, 'ms1', 'Organizacija A', -30, 30), 'ZD404: not found', a || ' cannot open a practice on ms1')
  FROM (VALUES ('ana'), ('vesna'), ('iva'), ('boris'), ('tomo')) AS t(a);
SELECT is(pg_temp.open('marko', 'ms2', 'Organizacija A', -30, 30), 'ZD404: not found', 'not the mentor of ms2 (and it has ended)');
SELECT is(pg_temp.open('vesna', 'ms2', 'Organizacija A', -30, 30), 'ZD404: not found', 'an ended mentorship takes no practice');
SELECT is(pg_temp.open('marko', 'nobody', 'Organizacija A', -30, 30), 'ZD404: not found', 'an unknown mentorship');
SELECT is(pg_temp.open('lea', 'ms1', 'Organizacija A', -30, 30), 'ZD404: not found', 'another institution''s administrator');
SELECT is(pg_temp.open('marko', 'ms1', o, f, t), 'ZD422: invalid input', why)
  FROM (VALUES ('   ', -30, 30, 'the organisation is not blank'),
               (repeat('x', 121), -30, 30, 'the organisation has at most 120 characters'),
               ('Org' || chr(10) || 'A', -30, 30, 'the organisation is one line'),
               ('Organizacija A', 30, -30, 'the period ends after it starts')) AS t(o, f, t, why);
SELECT is(pg_temp.ask('marko', format('SELECT app.open_practice_placement(NULL, %L, %L::date, %L::date)', 'Organizacija A', pg_temp.d(-1), pg_temp.d(1))),
  'ZD404: not found', 'no mentorship given');

CREATE TEMP TABLE pl (name text PRIMARY KEY, id text);
GRANT SELECT ON pl TO PUBLIC;
INSERT INTO pl SELECT 'a', pg_temp.open('marko', 'ms1', 'Organizacija A', -30, 30);
SELECT matches((SELECT id FROM pl WHERE name = 'a'), '^[0-9a-f-]{36}$', 'Marko opens a practice for Ana');
CREATE FUNCTION pg_temp.pl() RETURNS text LANGUAGE sql STABLE AS $$ SELECT id FROM pl WHERE name = 'a' $$;
SELECT is(pg_temp.ask('marko', format('SELECT concat_ws(%L, student_id = %L::uuid, organisation_name, entry_count, signed_through IS NULL) FROM app.practice_placements()', ':', pg_temp.id('ana'))),
  't:Organizacija A:0:t', 'the mentor lists the practice');
SELECT is(pg_temp.ask('ana', 'SELECT count(*) FROM app.practice_placements()'), '1', 'the student lists it');
SELECT is(pg_temp.ask(a, 'SELECT count(*) FROM app.practice_placements()'), '0', a || ' lists no practice of Ana')
  FROM (VALUES ('iva'), ('vesna'), ('boris'), ('dora'), ('lea'), ('tomo')) AS t(a);

-- 3. Entries: only the student; the period, the hours and the text are checked.
SELECT is(pg_temp.add('anon', pg_temp.pl(), -5, '4', 'Dan u organizaciji A.'), 'ZD401: not authenticated', 'no session, no entry');
SELECT is(pg_temp.add(a, pg_temp.pl(), -5, '4', 'Dan u organizaciji A.'), 'ZD404: not found', a || ' writes into Ana''s practice: refused')
  FROM (VALUES ('marko'), ('vesna'), ('iva'), ('boris'), ('dora'), ('lea')) AS t(a);
SELECT is(pg_temp.add('ana', '00000000-0000-4000-8000-00000000dead', -5, '4', 'Tekst.'), 'ZD404: not found', 'an unknown practice');
SELECT is(pg_temp.add('ana', pg_temp.pl(), -5, h, tx), 'ZD422: invalid input', why)
  FROM (VALUES ('0', 'Tekst.', 'hours below 0.5'), ('12.5', 'Tekst.', 'hours above 12'), ('3.3', 'Tekst.', 'hours not in steps of 0.5'),
               ('4', '  ', 'a blank text'), ('4', repeat('x', 4001), 'a text over 4000'),
               ('4', 'a' || chr(8238) || 'b', 'a bidirectional override'), ('4', 'a' || chr(1) || 'b', 'a control character')) AS t(h, tx, why);
SELECT is(pg_temp.add('ana', pg_temp.pl(), 5, '4', 'Budućnost.'), 'ZD422: invalid input', 'a date in the future');
SELECT is(pg_temp.add('ana', pg_temp.pl(), -31, '4', 'Prije početka.'), 'ZD409: placement closed', 'a date before the period');
SELECT is(pg_temp.add('ana', pg_temp.pl(), 31, '4', 'Poslije kraja.'), 'ZD409: placement closed', 'a date after the period');
SELECT is(pg_temp.add('ana', pg_temp.pl(), -5, '4', 'Dan u organizaciji A.', '00000000-0000-4000-8000-00000000dead'), 'ZD422: invalid input',
  'a correction of an entry that does not exist');
CREATE TEMP TABLE en (name text PRIMARY KEY, id text);
GRANT SELECT ON en TO PUBLIC;
INSERT INTO en VALUES ('e1', pg_temp.add('ana', pg_temp.pl(), -10, '7.5', 'Upoznavanje tima.'));
INSERT INTO en VALUES ('e2', pg_temp.add('ana', pg_temp.pl(), -9, '8', 'Prvi zadatak ' || chr(268) || 'ž.'));
SELECT matches((SELECT id FROM en WHERE name = 'e1'), '^[0-9a-f-]{36}$', 'Ana adds an entry');
SELECT is(pg_temp.ask('ana', format('SELECT string_agg(entry_date::text || %L || hours || %L || body, %L ORDER BY entry_date) FROM app.practice_entries(%L::uuid)', ':', ':', '|', pg_temp.pl())),
  pg_temp.d(-10) || ':7.5:Upoznavanje tima.|' || pg_temp.d(-9) || ':8.0:Prvi zadatak ' || chr(268) || 'ž.', 'Ana reads her entries');
SELECT is(pg_temp.ask('marko', format('SELECT count(*) FROM app.practice_entries(%L::uuid)', pg_temp.pl())), '2', 'the mentor reads the same entries');
SELECT is(pg_temp.ask(a, format('SELECT count(*) FROM app.practice_entries(%L::uuid)', pg_temp.pl())), 'ZD404: not found', a || ' does not read the entries')
  FROM (VALUES ('iva'), ('vesna'), ('boris'), ('dora'), ('lea'), ('tomo'), ('petra')) AS t(a);
SELECT is(pg_temp.ask('anon', format('SELECT count(*) FROM app.practice_entries(%L::uuid)', pg_temp.pl())), 'ZD401: not authenticated', 'reading needs a session');

-- 4. A correction is an entry that points at an entry of the same practice.
INSERT INTO en VALUES ('c1', pg_temp.add('ana', pg_temp.pl(), -9, '7.5', 'Ispravak sati.', (SELECT id FROM en WHERE name = 'e2')));
SELECT matches((SELECT id FROM en WHERE name = 'c1'), '^[0-9a-f-]{36}$', 'a correction points at an entry of the same practice');
-- A second practice (Marko also mentors Ana's bachelor thesis): a correction across practices is refused.
INSERT INTO ref VALUES ('ms5', '00000000-0000-4000-8000-0000000000d5');
INSERT INTO institution.mentorship (id, institution_id, mentor_id, student_id, work_type)
VALUES (pg_temp.id('ms5'), pg_temp.id('fak_a'), pg_temp.id('marko'), pg_temp.id('ana'), 'bachelor_thesis');
INSERT INTO pl SELECT 'b', pg_temp.open('marko', 'ms5', 'Organizacija B', -30, 30);
SELECT matches((SELECT id FROM pl WHERE name = 'b'), '^[0-9a-f-]{36}$', 'Marko opens a second practice for Ana');
SELECT is(pg_temp.add('ana', (SELECT id FROM pl WHERE name = 'b'), -5, '2', 'Ispravak tuđeg.', (SELECT id FROM en WHERE name = 'e1')),
  'ZD422: invalid input', 'a correction cannot point at an entry of another practice');
SELECT ok(pg_temp.ask_as('ductus_identity', 'anon', format($q$ INSERT INTO institution.practice_entry
    (institution_id, placement_id, entry_date, hours, body, corrects_entry_id) VALUES (%L::uuid, %L::uuid, current_date, 1, 'x', %L::uuid) $q$,
    pg_temp.id('fak_a'), (SELECT id FROM pl WHERE name = 'b'), (SELECT id FROM en WHERE name = 'e1'))
  ) LIKE '23503%', 'the foreign key refuses a cross-practice correction even past the RPC');

-- 5. Signing: only the mentor of the practice; the digest is the JCS of the covered entries.
SELECT is(pg_temp.sign(a, pg_temp.pl(), -1), 'ZD404: not found', a || ' cannot sign')
  FROM (VALUES ('ana'), ('vesna'), ('iva'), ('boris'), ('lea')) AS t(a);
SELECT is(pg_temp.sign('anon', pg_temp.pl(), -1), 'ZD401: not authenticated', 'signing needs a session');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), 1), 'ZD422: invalid input', 'not through a future date');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -31), 'ZD422: invalid input', 'not through a date before the period');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -1, '   '), 'ZD422: invalid input', 'a blank comment');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -20), 'ZD409: nothing to sign', 'no entry up to that date: nothing to sign');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -10, 'Potvrđujem.'),
  '1:' || encode(sha256(convert_to('[{"correctsEntryId":null,"date":"' || pg_temp.d(-10) || '","entryId":"' || (SELECT id FROM en WHERE name = 'e1')
    || '","hours":7.5,"text":"Upoznavanje tima."}]', 'UTF8')), 'hex'),
  'the mentor signs through a date: the count and the JCS digest of the covered entries');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -10), 'ZD409: nothing to sign', 'the same signature again: nothing to sign');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -1), '3:' || encode(sha256(convert_to('[{"correctsEntryId":null,"date":"' || pg_temp.d(-10) || '","entryId":"'
    || (SELECT id FROM en WHERE name = 'e1') || '","hours":7.5,"text":"Upoznavanje tima."},{"correctsEntryId":null,"date":"' || pg_temp.d(-9)
    || '","entryId":"' || (SELECT id FROM en WHERE name = 'e2') || '","hours":8,"text":"Prvi zadatak ' || chr(268) || 'ž."},{"correctsEntryId":"'
    || (SELECT id FROM en WHERE name = 'e2') || '","date":"' || pg_temp.d(-9) || '","entryId":"' || (SELECT id FROM en WHERE name = 'c1')
    || '","hours":7.5,"text":"Ispravak sati."}]', 'UTF8')), 'hex'), 'a later signature covers the earlier entries too (with the correction)');
-- An entry for an older date after a signature is a correction that needs a new signature.
INSERT INTO en VALUES ('late', pg_temp.add('ana', pg_temp.pl(), -10, '1', 'Zakašnjeli zapis.'));
SELECT is(pg_temp.ask('ana', format('SELECT signed_through::text FROM app.practice_placements() WHERE placement_id = %L::uuid', pg_temp.pl())), pg_temp.d(-1), 'the newest signature is the one shown');
SELECT is(left(pg_temp.sign('marko', pg_temp.pl(), -1), 2), '4:', 'an entry added later for an older date needs a new signature');
SELECT is(pg_temp.sign('marko', pg_temp.pl(), -1), 'ZD409: nothing to sign', 'and then nothing is left to sign');

-- 6. The signatures: the student sees the comment, nobody else reads them, none can be withdrawn.
SELECT is(pg_temp.ask('ana', format('SELECT string_agg(through_date::text || %L || entry_count || %L || coalesce(comment, %L), %L ORDER BY through_date, entry_count) FROM app.practice_signoffs(%L::uuid)', ':', ':', '-', '|', pg_temp.pl())),
  pg_temp.d(-10) || ':1:Potvrđujem.|' || pg_temp.d(-1) || ':3:-|' || pg_temp.d(-1) || ':4:-', 'the student reads the signatures and the mentor''s comment');
SELECT is(pg_temp.ask('marko', format('SELECT count(*) FROM app.practice_signoffs(%L::uuid)', pg_temp.pl())), '3', 'the mentor reads the history');
SELECT is(pg_temp.ask(a, format('SELECT count(*) FROM app.practice_signoffs(%L::uuid)', pg_temp.pl())), 'ZD404: not found', a || ' does not read the signatures')
  FROM (VALUES ('iva'), ('vesna'), ('boris'), ('dora'), ('lea')) AS t(a);

-- 7. A closed mentorship takes no entry; the table refuses UPDATE, DELETE and TRUNCATE for the owner too.
UPDATE institution.mentorship SET ended_at = now() WHERE id = pg_temp.id('ms1');
SELECT is(pg_temp.add('ana', pg_temp.pl(), -2, '2', 'Nakon kraja.'), 'ZD409: placement closed', 'an ended mentorship closes the practice');
SELECT is(pg_temp.ask('ana', format('SELECT count(*) FROM app.practice_entries(%L::uuid)', pg_temp.pl())), '4', 'the student still reads the journal');

SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'UPDATE institution.practice_entry SET hours = 1'), 'ZD409: conflict', 'UPDATE of an entry is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'DELETE FROM institution.practice_entry'), 'ZD409: conflict', 'DELETE of an entry is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'TRUNCATE institution.practice_entry'), 'ZD409: conflict', 'TRUNCATE of the entries is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'UPDATE institution.practice_signoff SET comment = NULL'), 'ZD409: conflict', 'UPDATE of a signature is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'DELETE FROM institution.practice_signoff'), 'ZD409: conflict', 'DELETE of a signature is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'UPDATE institution.practice_placement SET organisation_name = ''X'''), 'ZD409: conflict', 'UPDATE of a practice is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'DELETE FROM institution.practice_placement'), 'ZD409: conflict', 'DELETE of a practice is refused');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'institution.practice_placement'::regclass AND tgname = 'practice_placement_no_truncate' AND tgenabled = 'O'),
  'TRUNCATE of the practices has its guard (the foreign keys refuse it first)');

SELECT * FROM finish();
ROLLBACK;
