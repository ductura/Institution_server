-- SRV-V18-KODIRANJE-BAZA (val 18, WEB docs/nalazi/val18-razlika.md §5 task 5):
-- the qualitative coding of a person's own material. Material, codebook and
-- marked passages belong to their owner and to nobody else: another student, a
-- teacher of the same course and a person of another institution see nothing and
-- touch nothing, and an unknown or malformed id is the same refusal (ZD404). A
-- text never changes, the codebook keeps the owner's order, a quote must be
-- exactly the text it points at. Personas of institution.inc: Ana and Dora
-- students of K1, Vesna teacher of K1, Boris in no course, Petra of another
-- institution. Every text is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- 'ok' or the SQLSTATE of the refusal; the message when asked for it.
CREATE FUNCTION pg_temp.code(p_actor text, p_sql text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE 'ok' END FROM (SELECT pg_temp.ask(p_actor, p_sql) AS r) x
$$;
CREATE FUNCTION pg_temp.msg(p_actor text, p_sql text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN r ELSE 'ok' END FROM (SELECT pg_temp.ask(p_actor, p_sql) AS r) x
$$;

-- Material: three lines, the middle one empty; the second line has a non-ASCII word.
CREATE FUNCTION pg_temp.body() RETURNS text LANGUAGE sql AS $$
  SELECT E'Prvi redak: kompost je važan.\n\nTreći redak: šuma šuti.'
$$;

-- Making a material: refused input first (for a person in a session), then the
-- relation (there is none to check: it is the caller's own).
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material('''', ''interview'', ''Tekst'')'), 'ZD422', 'an empty title is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material('' Naslov'', ''interview'', ''Tekst'')'), 'ZD422', 'a title with a space at the start is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', ''audio'', ''Tekst'')'), 'ZD422', 'a kind outside the closed set is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', NULL, ''Tekst'')'), 'ZD422', 'a null kind is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', ''note'', '''')'), 'ZD422', 'an empty text is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', ''note'', E''  \n \t'')'), 'ZD422', 'a text of white space is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', ''note'', E''Tekst\x01'')'), 'ZD422', 'a control character is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', ''note'', repeat(''a'', 100001))'), 'ZD422', 'a text over 100000 characters is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(''Naslov'', ''note'', repeat(''a'', 100000))'), 'ok', 'a text of exactly 100000 characters is kept');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_material(repeat(''a'', 201), ''note'', ''Tekst'')'), 'ZD422', 'a title over 200 characters is refused');
SELECT is(pg_temp.code('anon', 'SELECT app.create_qual_material(''Naslov'', ''note'', ''Tekst'')'), 'ZD401', 'without a session it is ZD401');
SELECT is(pg_temp.code('expired', 'SELECT app.create_qual_material(''Naslov'', ''note'', ''Tekst'')'), 'ZD401', 'an expired session is ZD401');
SELECT is((SELECT count(*)::integer FROM institution.qual_material), 1, 'only the valid one of the above was written');

CREATE TEMP TABLE m1 AS
  SELECT pg_temp.ask('ana', 'SELECT app.create_qual_material(''Intervju A'', ''interview'', ' || quote_literal(E'Prvi redak: kompost je važan.\r\n\r\nTreći redak: šuma šuti.') || ')') AS id;
GRANT SELECT ON m1 TO PUBLIC;
SELECT matches((SELECT id FROM m1), '^[0-9a-f-]{36}$', 'Ana keeps an interview');
SELECT is((SELECT body FROM institution.qual_material WHERE id = (SELECT id FROM m1)::uuid), pg_temp.body(),
  'the line breaks of the paste are stored as a line feed');
SELECT is((SELECT owner_id FROM institution.qual_material WHERE id = (SELECT id FROM m1)::uuid), pg_temp.id('ana'), 'it is hers');
SELECT is((SELECT institution_id FROM institution.qual_material WHERE id = (SELECT id FROM m1)::uuid), pg_temp.id('fak_a'), 'of her institution');

-- Reading it: the owner only.
SELECT is(substr(pg_temp.ask(c.actor, format('SELECT title FROM app.qual_material(%L)', (SELECT id FROM m1))), 1, 11), c.result,
  format('%s reads the material of Ana: %s', c.actor, c.result))
FROM (VALUES ('ana', 'Intervju A'), ('dora', 'ZD404: not '), ('vesna', 'ZD404: not '), ('marko', 'ZD404: not '),
             ('iva', 'ZD404: not '), ('boris', 'ZD404: not '), ('nina', 'ZD404: not '), ('petra', 'ZD404: not '),
             ('anon', 'ZD401: not ')) AS c (actor, result);
SELECT is(pg_temp.code('ana', 'SELECT * FROM app.qual_material(gen_random_uuid())'), 'ZD404', 'an unknown id is the same refusal');
SELECT is(pg_temp.code('ana', 'SELECT * FROM app.qual_material(NULL)'), 'ZD404', 'a null id is the same refusal');
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.qual_materials()'), c.result,
  format('%s lists the materials: %s', c.actor, c.result))
FROM (VALUES ('ana', '2'), ('dora', '0'), ('vesna', '0'), ('boris', '0'), ('petra', '0')) AS c (actor, result);
SELECT is(substr(pg_temp.ask('anon', 'SELECT count(*)::text FROM app.qual_materials()'), 1, 5), 'ZD401', 'a list without a session is ZD401');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(locked::text || char_count::text, '','') FROM app.qual_materials() WHERE title = ''Intervju A'''), 'false54',
  'the list says how long it is and that it is not locked');

-- The codebook.
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_code('''', ''x'')'), 'ZD422', 'an empty name is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_code(repeat(''a'', 81), '''')'), 'ZD422', 'a name over 80 characters is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_code(''Naziv'', repeat(''a'', 501))'), 'ZD422', 'a description over 500 characters is refused');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_code(''Naziv'', E''a\nb'')'), 'ZD422', 'a description is one line');
SELECT is(pg_temp.code('anon', 'SELECT app.create_qual_code(''Naziv'', '''')'), 'ZD401', 'a code without a session is ZD401');
CREATE TEMP TABLE c1 AS SELECT pg_temp.ask('ana', 'SELECT app.create_qual_code(''Kompost'', ''O kompostu'')') AS id;
CREATE TEMP TABLE c2 AS SELECT pg_temp.ask('ana', 'SELECT app.create_qual_code(''Šuma'', NULL)') AS id;
CREATE TEMP TABLE c3 AS SELECT pg_temp.ask('ana', 'SELECT app.create_qual_code(''Tišina'', '''')') AS id;
GRANT SELECT ON c1, c2, c3 TO PUBLIC;
SELECT matches((SELECT id FROM c1) || (SELECT id FROM c2) || (SELECT id FROM c3), '^([0-9a-f-]{36}){3}$', 'Ana makes three codes');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_code(''kompost'', '''')'), 'ZD409', 'the same name again, the case aside, is a conflict');
SELECT is(pg_temp.code('dora', 'SELECT app.create_qual_code(''Kompost'', '''')'), 'ok', 'another person may use the same name');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(name || ord, '','' ORDER BY ord) FROM app.qual_codes()'), 'Kompost1,Šuma2,Tišina3',
  'the codebook is in the order it was made');
SELECT is(pg_temp.ask('ana', 'SELECT description FROM app.qual_codes() WHERE name = ''Šuma'''), '', 'no description is the empty one');
SELECT is(pg_temp.ask('dora', 'SELECT count(*)::text FROM app.qual_codes()'), '1', 'Dora sees her own code only');
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.qual_codes()'), c.result,
  format('%s lists the codes: %s', c.actor, c.result))
FROM (VALUES ('vesna', '0'), ('boris', '0'), ('petra', '0')) AS c (actor, result);
-- Renaming and moving: the owner's.
SELECT is(pg_temp.code(c.actor, format('SELECT app.update_qual_code(%L, ''Tuđe'', '''')', (SELECT id FROM c1))), c.result,
  format('%s renames a code of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('ana', format('SELECT app.update_qual_code(%L, ''Šuma'', '''')', (SELECT id FROM c1))), 'ZD409', 'a rename into another name of hers is a conflict');
SELECT is(pg_temp.code('ana', format('SELECT app.update_qual_code(%L, '''', '''')', (SELECT id FROM c1))), 'ZD422', 'a rename to nothing is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.update_qual_code(%L, ''Kompostiranje'', ''Novo'')', (SELECT id FROM c1))), 'ok', 'Ana renames her code');
SELECT is(pg_temp.ask('ana', 'SELECT name || ord FROM app.qual_codes() WHERE ord = 1'), 'Kompostiranje1', 'the place stays');
SELECT is(pg_temp.code(c.actor, format('SELECT app.move_qual_code(%L, 1)', (SELECT id FROM c3))), c.result,
  format('%s moves a code of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('ana', format('SELECT app.move_qual_code(%L, 0)', (SELECT id FROM c3))), 'ZD422', 'a place below 1 is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.move_qual_code(%L, 4)', (SELECT id FROM c3))), 'ZD422', 'a place above the number of codes is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.move_qual_code(%L, NULL)', (SELECT id FROM c3))), 'ZD422', 'a null place is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.move_qual_code(%L, 1)', (SELECT id FROM c3))), 'ok', 'Ana moves the last code to the first place');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(name || ord, '','' ORDER BY ord) FROM app.qual_codes()'), 'Tišina1,Kompostiranje2,Šuma3',
  'the others keep their order');
SELECT is(pg_temp.code('ana', format('SELECT app.move_qual_code(%L, 3)', (SELECT id FROM c3))), 'ok', 'and to the last');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(name || ord, '','' ORDER BY ord) FROM app.qual_codes()'), 'Kompostiranje1,Šuma2,Tišina3',
  'which is the order it began with');
SELECT is(pg_temp.ask('dora', 'SELECT name || ord FROM app.qual_codes()'), 'Kompost1', 'a move of Ana does not touch Dora');

-- Marking a passage. Line 0: "Prvi redak: kompost je važan." Line 1: empty. Line 2: "Treći redak: šuma šuti."
SELECT is(pg_temp.code(c.actor, format('SELECT app.create_qual_segment(%L, %L, 0, 0, 5, ''Prvi '', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), c.result,
  format('%s marks a passage of the material of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('marko', 'ZD404'), ('boris', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, gen_random_uuid(), 0, 0, 4, ''Prvi'', NULL)', (SELECT id FROM m1))), 'ZD404', 'an unknown code is the same refusal');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(gen_random_uuid(), %L, 0, 0, 4, ''Prvi'', NULL)', (SELECT id FROM c1))), 'ZD404', 'an unknown material is the same refusal');
-- A code of Dora is not Ana's code.
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, ''Prvi'', NULL)', (SELECT id FROM m1),
  (SELECT id FROM institution.qual_code WHERE owner_id = pg_temp.id('dora')))), 'ZD404', 'a code of another person is the same refusal');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, ''Prvi'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ok',
  'Ana marks the first word');
-- The anchor must be exactly the text.
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, ''Pravi'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a quote that is not the text is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 1, 5, ''Prvi'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a shifted offset is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 5, ''Prvi'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'an end that does not fit the quote is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 0, 5, ''Prvi '', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'the right quote in the wrong line is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 3, 0, 1, ''T'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a line that is not there is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 1, 0, 1, ''x'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'the empty line holds nothing to mark');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, -1, 0, 4, ''Prvi'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a negative line is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 4, 4, '''', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'an empty quote is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 5, 6, '' '', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a quote of a space is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, NULL, NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a null quote is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, NULL, 4, ''Prvi'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ZD422', 'a null offset is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, ''Prvi'', '''')', (SELECT id FROM m1), (SELECT id FROM c2))), 'ZD422', 'an empty memo is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, ''Prvi'', repeat(''a'', 1001))', (SELECT id FROM m1), (SELECT id FROM c2))), 'ZD422', 'a memo over 1000 characters is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 4, ''Prvi'', E''a\x01'')', (SELECT id FROM m1), (SELECT id FROM c2))), 'ZD422', 'a memo with a control character is refused');
-- Characters, not bytes: the non-ASCII words.
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 13, 17, ''šuma'', E''Prva\nbilješka'')', (SELECT id FROM m1), (SELECT id FROM c2))), 'ok',
  'a quote with a non-ASCII letter is marked by characters, with a memo of two lines');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 13, 17, ''šuma'', NULL)', (SELECT id FROM m1), (SELECT id FROM c2))), 'ZD409', 'the same mark again is a conflict');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 13, 17, ''šuma'', NULL)', (SELECT id FROM m1), (SELECT id FROM c1))), 'ok', 'another code on the same passage is allowed');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 13, 24, ''šuma šuti.'', NULL)', (SELECT id FROM m1), (SELECT id FROM c3))), 'ZD422', 'a quote that runs past the line is refused');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 13, 23, ''šuma šuti.'', NULL)', (SELECT id FROM m1), (SELECT id FROM c3))), 'ok', 'the rest of the line is marked');
SELECT is((SELECT count(*)::integer FROM institution.qual_segment), 4, 'a refusal leaves no passage');
-- A material shows that it is locked once it has a passage; and nothing about it changes.
SELECT is(pg_temp.ask('ana', format('SELECT locked::text || segment_count FROM app.qual_material(%L)', (SELECT id FROM m1))), 'true4', 'the material is locked after the first passage');
SELECT throws_ok(format('UPDATE institution.qual_material SET body = %L WHERE id = %L', 'Drugi tekst', (SELECT id FROM m1)), 'ZD409', 'conflict',
  'the text of a material is never changed, not even by the owner of the table');
SELECT throws_ok(format('UPDATE institution.qual_material SET title = %L WHERE id = %L', 'Novi', (SELECT id FROM m1)), 'ZD409', 'conflict',
  'nor its title');
SELECT throws_ok($$ UPDATE institution.qual_segment SET memo = 'x' $$, 'ZD409', 'conflict', 'a passage is not changed, it is removed and marked again');
SELECT throws_ok($$ UPDATE institution.qual_code SET owner_id = pg_temp.id('dora') $$, 'ZD409', 'conflict', 'a code does not change hands');
SELECT throws_ok($$ TRUNCATE institution.qual_segment CASCADE $$, 'ZD409', 'conflict', 'nothing is truncated');
SELECT throws_ok($$ TRUNCATE institution.qual_material CASCADE $$, 'ZD409', 'conflict', 'not the materials either');
SELECT throws_ok($$ TRUNCATE institution.qual_code CASCADE $$, 'ZD409', 'conflict', 'nor the codes');

-- Reading the passages: the owner's material only, in the order of the text.
SELECT is(pg_temp.code(c.actor, format('SELECT * FROM app.qual_segments(%L)', (SELECT id FROM m1))), c.result,
  format('%s reads the passages: %s', c.actor, c.result))
FROM (VALUES ('ana', 'ok'), ('dora', 'ZD404'), ('vesna', 'ZD404'), ('boris', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.ask('ana', format('SELECT string_agg(paragraph || '':'' || start_offset || '':'' || end_offset, '','') FROM app.qual_segments(%L)', (SELECT id FROM m1))),
  '0:0:4,2:13:17,2:13:17,2:13:23', 'in the order of the text (paragraph, start, end)');
SELECT is(pg_temp.ask('ana', format('SELECT string_agg((code_id = %L::uuid)::text, '','') FROM app.qual_segments(%L) WHERE paragraph = 2 AND end_offset = 17', (SELECT id FROM c1), (SELECT id FROM m1))),
  'true,false', 'and, for the same place, in the order of the codebook (Kompostiranje before Šuma)');
SELECT is(pg_temp.code('ana', 'SELECT * FROM app.qual_segments(NULL)'), 'ZD404', 'a null material is the same refusal');

-- The counts of the codebook describe, they never order it.
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(name || '':'' || segment_count, '','' ORDER BY ord) FROM app.qual_codes()'),
  'Kompostiranje:2,Šuma:1,Tišina:1', 'the codebook says how many passages each code has, in its own order');

-- Removing a passage: the owner's.
SELECT is(pg_temp.code(c.actor, format('SELECT app.delete_qual_segment(%L)', (SELECT id FROM institution.qual_segment WHERE end_offset = 23))), c.result,
  format('%s removes a passage of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('ana', 'SELECT app.delete_qual_segment(gen_random_uuid())'), 'ZD404', 'an unknown passage is the same refusal');
SELECT is(pg_temp.code('ana', 'SELECT app.delete_qual_segment(NULL)'), 'ZD404', 'a null passage is the same refusal');
SELECT is((SELECT count(*)::integer FROM institution.qual_segment), 4, 'nothing was removed by a refusal');
SELECT is(pg_temp.code('ana', format('SELECT app.delete_qual_segment(%L)', (SELECT id FROM institution.qual_segment WHERE end_offset = 23))), 'ok', 'Ana removes it');
SELECT is((SELECT count(*)::integer FROM institution.qual_segment), 3, 'it is gone');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 2, 13, 23, ''šuma šuti.'', ''Opet'')', (SELECT id FROM m1), (SELECT id FROM c3))), 'ok', 'and can be marked again');

-- Deleting a code with passages needs the confirmation.
SELECT is(pg_temp.code(c.actor, format('SELECT app.delete_qual_code(%L, true)', (SELECT id FROM c2))), c.result,
  format('%s deletes a code of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.msg('ana', format('SELECT app.delete_qual_code(%L, false)', (SELECT id FROM c2))), 'ZD409: confirm_required',
  'a code with a passage is not deleted without the confirmation');
SELECT is(pg_temp.msg('ana', format('SELECT app.delete_qual_code(%L, NULL)', (SELECT id FROM c2))), 'ZD409: confirm_required',
  'a null confirmation is no confirmation');
SELECT is((SELECT count(*)::integer FROM institution.qual_code WHERE owner_id = pg_temp.id('ana')), 3, 'the refusals left the codebook as it was');
SELECT is(pg_temp.ask('ana', format('SELECT app.delete_qual_code(%L, true)', (SELECT id FROM c2))), '1', 'with the confirmation it is deleted and says how many passages went');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(name || ord, '','' ORDER BY ord) FROM app.qual_codes()'), 'Kompostiranje1,Tišina2',
  'the codebook is numbered again without a gap');
SELECT is(pg_temp.ask('ana', format('SELECT count(*)::text FROM app.qual_segments(%L)', (SELECT id FROM m1))), '3', 'the passages of the code went with it');
SELECT is(pg_temp.code('ana', 'SELECT app.create_qual_code(''Prazan'', '''')'), 'ok', 'Ana makes a code without a passage');
SELECT is(pg_temp.ask('ana', 'SELECT app.delete_qual_code(id, false) FROM app.qual_codes() WHERE name = ''Prazan'''), '0',
  'a code without a passage needs no confirmation');
SELECT is(pg_temp.code('ana', format('SELECT app.delete_qual_code(%L, true)', (SELECT id FROM c2))), 'ZD404', 'a deleted code is gone');

-- The export: the passages in the order of the codebook, then of the materials,
-- then of the text; nobody else's.
CREATE TEMP TABLE m2 AS
  SELECT pg_temp.ask('ana', 'SELECT app.create_qual_material(''Bilješka A'', ''note'', ''Kratka bilješka o kompostu.'')') AS id;
GRANT SELECT ON m2 TO PUBLIC;
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 0, 6, ''Kratka'', NULL)', (SELECT id FROM m2), (SELECT id FROM c3))), 'ok',
  'Ana marks the second material with the second code');
SELECT is(pg_temp.code('ana', format('SELECT app.create_qual_segment(%L, %L, 0, 18, 24, ''kompos'', NULL)', (SELECT id FROM m2), (SELECT id FROM c1))), 'ok',
  'and with the first');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(material_rank || '':'' || quote, '','') FROM app.qual_export_segments(NULL)'),
  '2:Prvi,2:šuma,3:kompos,2:šuma šuti.,3:Kratka', 'the export is by code (Kompostiranje, Tišina), then by material, then by text');
SELECT is(pg_temp.ask('ana', format('SELECT string_agg(quote, '','') FROM app.qual_export_segments(%L)', (SELECT id FROM m2))), 'kompos,Kratka',
  'of one material it holds that material only');
SELECT is(pg_temp.ask('dora', 'SELECT count(*)::text FROM app.qual_export_segments(NULL)'), '0', 'Dora exports nothing of Ana');
SELECT is(pg_temp.code(c.actor, format('SELECT * FROM app.qual_export_segments(%L)', (SELECT id FROM m2))), c.result,
  format('%s exports the material of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('anon', 'SELECT * FROM app.qual_export_segments(NULL)'), 'ZD401', 'an export without a session is ZD401');
SELECT is(pg_temp.code('ana', 'SELECT * FROM app.qual_export_segments(gen_random_uuid())'), 'ZD404', 'an unknown material is the same refusal');

-- Deleting a material takes its passages and nothing else.
SELECT is(pg_temp.code(c.actor, format('SELECT app.delete_qual_material(%L)', (SELECT id FROM m2))), c.result,
  format('%s deletes the material of Ana: %s', c.actor, c.result))
FROM (VALUES ('dora', 'ZD404'), ('vesna', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('ana', 'SELECT app.delete_qual_material(gen_random_uuid())'), 'ZD404', 'an unknown material is the same refusal');
SELECT is((SELECT count(*)::integer FROM institution.qual_material WHERE owner_id = pg_temp.id('ana')), 3, 'the refusals left the materials');
SELECT is(pg_temp.code('ana', format('SELECT app.delete_qual_material(%L)', (SELECT id FROM m2))), 'ok', 'Ana deletes it');
SELECT is((SELECT count(*)::integer FROM institution.qual_segment WHERE material_id = (SELECT id FROM m2)::uuid), 0, 'its passages went with it');
SELECT is((SELECT count(*)::integer FROM institution.qual_segment WHERE material_id = (SELECT id FROM m1)::uuid), 3, 'the passages of the other material stayed');
SELECT is(pg_temp.code('ana', format('SELECT * FROM app.qual_material(%L)', (SELECT id FROM m2))), 'ZD404', 'a deleted material is gone');

-- Limits.
INSERT INTO institution.qual_code (institution_id, owner_id, name, ord)
SELECT pg_temp.id('fak_a'), pg_temp.id('dora'), 'Kod ' || n, n + 1 FROM generate_series(1, 199) n;
SELECT is(pg_temp.msg('dora', 'SELECT app.create_qual_code(''Jedan previše'', '''')'), 'ZD409: limit', 'a codebook holds 200 codes');
INSERT INTO institution.qual_material (institution_id, owner_id, title, kind, body)
SELECT pg_temp.id('fak_a'), pg_temp.id('boris'), 'Gradivo ' || n, 'note', 'Tekst ' || n FROM generate_series(1, 200) n;
SELECT is(pg_temp.msg('boris', 'SELECT app.create_qual_material(''Jedno previše'', ''note'', ''Tekst'')'), 'ZD409: limit', 'a person keeps 200 materials');

-- Nothing about the web role is open: only the RPCs.
SELECT is_empty(
  $$ SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'institution' AND c.relname IN ('qual_material', 'qual_code', 'qual_segment')
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR has_table_privilege('ductus_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) $$,
  'the three tables have forced RLS and no privilege for the web role');
SELECT is_empty(
  $$ SELECT conname FROM pg_constraint
     WHERE contype = 'f' AND conrelid IN ('institution.qual_material'::regclass, 'institution.qual_code'::regclass, 'institution.qual_segment'::regclass)
       AND confrelid NOT IN ('identity.user_account'::regclass, 'institution.qual_material'::regclass, 'institution.qual_code'::regclass) $$,
  'no key links the coding to a course, an assignment, a work or a teacher');
SELECT is_empty(
  $$ SELECT table_name || '.' || column_name FROM information_schema.columns
     WHERE table_schema = 'institution' AND table_name IN ('qual_material', 'qual_code', 'qual_segment')
       AND (column_name ~ '(course|assignment|work|teacher|mentor|reader|share)') $$,
  'no column of the coding names a course, a work, a teacher, a mentor or a sharing');

SELECT * FROM finish();
ROLLBACK;
