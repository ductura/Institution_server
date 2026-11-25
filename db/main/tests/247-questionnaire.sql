-- SRV-V18-UPITNIK-BAZA (val 18, WEB docs/nalazi/val18-razlika.md §5 task 1): the
-- questionnaire of a course. A teacher of the course makes, edits (draft only),
-- opens and closes it; students of the course answer once; a sheet carries no
-- person and the participation carries no sheet; anything that is not the
-- relation (another course, another institution, an unknown id, a closed
-- questionnaire for a student) is the same refusal. Personas of institution.inc:
-- Vesna teacher of K1, Marko teacher of K2, Ana and Dora students of K1, Boris
-- in no course, Petra of another institution, Nina an unconfirmed teacher.
-- Every text is invented.
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

CREATE FUNCTION pg_temp.questions() RETURNS text LANGUAGE sql AS $$
  SELECT $q$[
    {"kind": "single", "text": "Kompostirate li kod kuće?", "options": [{"code": "da", "label": "Da"}, {"code": "ne", "label": "Ne"}]},
    {"kind": "multiple", "text": "Što stavljate u kompost?", "options": [{"code": "voce", "label": "Voće"}, {"code": "povrce", "label": "Povrće"}, {"code": "lisce", "label": "Lišće"}]},
    {"kind": "scale", "text": "Koliko je kompostiranje naporno?", "scale": {"min": 1, "max": 5}},
    {"kind": "number", "text": "Koliko kilograma mjesečno?"},
    {"kind": "text", "text": "Što biste promijenili?"}
  ]$q$
$$;

-- The first questionnaire: refused input, then the relation first.
SELECT is(pg_temp.code('vesna', format('SELECT app.create_questionnaire({k1}, ''Prazno'', ''[]'')')), 'ZD422',
  'a teacher of K1 gets ZD422 for a questionnaire without questions');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, '' '', ' || quote_literal(pg_temp.questions()) || ')'), 'ZD422',
  'a blank title is refused');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, ''Naslov'', ''[{"kind":"single","text":"Pitanje?","options":[{"code":"a","label":"A"}]}]'')'), 'ZD422',
  'a choice with one option is refused');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, ''Naslov'', ''[{"kind":"scale","text":"Pitanje?","scale":{"min":3,"max":3}}]'')'), 'ZD422',
  'a scale with min equal to max is refused');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, ''Naslov'', ''[{"kind":"text","text":"Pitanje?"},{"kind":"scale","text":"Skala?","scale":{}}]'')'), 'ZD422',
  'a valid question next to a scale question with an empty scale is refused');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, ''Naslov'', ''[{"kind":"text","text":"Pitanje?"},{"kind":"single","text":"Izbor?","options":[{"code":"a","label":"A"},{}]}]'')'), 'ZD422',
  'a valid question next to a choice with an empty option is refused');
SELECT is(institution.questionnaire_scale_valid('{}'), false, 'an empty scale is false, not null');
SELECT is(institution.questionnaire_shape_valid('scale', NULL, '{}'), false, 'a scale question with an empty scale is false, not null');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, ''Naslov'', ''[{"kind":"text","text":"Pitanje?","extra":1}]'')'), 'ZD422',
  'an unknown key of a question is refused');
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire({k1}, ''Naslov'', ''[{"kind":"number","text":"Pitanje?","options":[{"code":"a","label":"A"},{"code":"b","label":"B"}]}]'')'), 'ZD422',
  'a number with options is refused');
SELECT is(pg_temp.code(c.actor, 'SELECT app.create_questionnaire({k1}, ''Naslov'', ' || quote_literal(pg_temp.questions()) || ')'), c.result,
  format('%s makes a questionnaire in K1: %s', c.actor, c.result))
FROM (VALUES ('marko', 'ZD404'), ('ana', 'ZD404'), ('dora', 'ZD404'), ('boris', 'ZD404'), ('nina', 'ZD404'),
             ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('vesna', 'SELECT app.create_questionnaire(gen_random_uuid(), ''Naslov'', ' || quote_literal(pg_temp.questions()) || ')'), 'ZD404',
  'an unknown course is the same refusal');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire), 0, 'nothing was written by a refusal');

CREATE TEMP TABLE qn AS
  SELECT pg_temp.ask('vesna', 'SELECT app.create_questionnaire({k1}, ''Izmišljeno istraživanje'', ' || quote_literal(pg_temp.questions()) || ')') AS id;
GRANT SELECT ON qn TO PUBLIC;
SELECT matches((SELECT id FROM qn), '^[0-9a-f-]{36}$', 'Vesna makes a draft questionnaire');
SELECT is((SELECT state FROM institution.questionnaire), 'draft', 'it starts as a draft');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_question), 5, 'with its five questions');
SELECT is((SELECT string_agg(ord::text, ',' ORDER BY ord) FROM institution.questionnaire_question), '1,2,3,4,5',
  'in the order of the array');

-- Reading it: the teachers of K1 only.
SELECT is(substr(pg_temp.ask(c.actor, format('SELECT count(*)::text FROM app.teacher_questionnaire(%L)', (SELECT id FROM qn))), 1, 5), c.result,
  format('%s reads the questionnaire: %s', c.actor, c.result))
FROM (VALUES ('vesna', '5'), ('marko', 'ZD404'), ('ana', 'ZD404'), ('boris', 'ZD404'), ('petra', 'ZD404'),
             ('nina', 'ZD404')) AS c (actor, result);
SELECT is(substr(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.teacher_questionnaires({k1})'), 1, 5), c.result,
  format('%s lists the questionnaires of K1: %s', c.actor, c.result))
FROM (VALUES ('vesna', '1'), ('marko', 'ZD404'), ('ana', 'ZD404'), ('boris', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(substr(pg_temp.ask('vesna', format('SELECT count(*)::text FROM app.teacher_questionnaire(%L)', gen_random_uuid())), 1, 5), 'ZD404',
  'an unknown questionnaire is the same refusal');

-- A student sees nothing of a draft.
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM app.student_questionnaires()'), '0', 'Ana lists no draft');
SELECT is(substr(pg_temp.ask('ana', format('SELECT count(*)::text FROM app.student_questionnaire(%L)', (SELECT id FROM qn))), 1, 5), 'ZD404',
  'Ana reads no draft');

-- Editing a draft.
SELECT is(pg_temp.code('vesna', format('SELECT app.update_questionnaire(%L, ''Novi naslov'', ''[]'')', (SELECT id FROM qn))), 'ZD422',
  'an edit without questions is refused');
SELECT is(pg_temp.code(c.actor, format('SELECT app.update_questionnaire(%L, ''Tuđe'', %L)', (SELECT id FROM qn), pg_temp.questions())), c.result,
  format('%s edits the draft: %s', c.actor, c.result))
FROM (VALUES ('marko', 'ZD404'), ('ana', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('vesna', format('SELECT app.update_questionnaire(%L, ''Novi naslov'', %L)', (SELECT id FROM qn), pg_temp.questions())), 'ok',
  'Vesna edits the draft');
SELECT is((SELECT title FROM institution.questionnaire), 'Novi naslov', 'the title changed');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_question), 5, 'the questions were replaced, not added');

-- A draft takes no sheet, from anyone.
SELECT is(pg_temp.code('vesna', format('SELECT app.manual_questionnaire_response(%L, ''[]'')', (SELECT id FROM qn))), 'ZD422',
  'a sheet without an answer is refused');

-- Opening.
SELECT is(pg_temp.code('vesna', format('SELECT app.set_questionnaire_state(%L, ''closed'')', (SELECT id FROM qn))), 'ZD409',
  'a draft is not closed');
SELECT is(pg_temp.code('vesna', format('SELECT app.set_questionnaire_state(%L, ''draft'')', (SELECT id FROM qn))), 'ZD422',
  'draft is not a target');
SELECT is(pg_temp.code(c.actor, format('SELECT app.set_questionnaire_state(%L, ''open'')', (SELECT id FROM qn))), c.result,
  format('%s opens it: %s', c.actor, c.result))
FROM (VALUES ('marko', 'ZD404'), ('ana', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401'), ('vesna', 'ok')) AS c (actor, result);
SELECT is((SELECT state FROM institution.questionnaire), 'open', 'it is open');
SELECT is(pg_temp.msg('vesna', format('SELECT app.update_questionnaire(%L, ''Kasno'', %L)', (SELECT id FROM qn), pg_temp.questions())),
  'ZD409: not_draft', 'an open questionnaire is not edited');
SELECT throws_ok($$ DELETE FROM institution.questionnaire_question $$, 'ZD409', 'not_draft',
  'a question of an open questionnaire is not deleted, not even by the owner');

-- Answering.
CREATE FUNCTION pg_temp.answers(p_text text DEFAULT 'Više kontejnera') RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 1), 'value', 'da'),
    jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 2), 'value', jsonb_build_array('voce', 'lisce')),
    jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 3), 'value', 4),
    jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 4), 'value', 2.5),
    jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 5), 'value', p_text))::text
$$;
GRANT EXECUTE ON FUNCTION pg_temp.answers(text) TO PUBLIC;
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM app.student_questionnaires()'), '1', 'Ana lists the open questionnaire');
SELECT is(pg_temp.ask('ana', format('SELECT participated::text FROM app.student_questionnaire(%L) LIMIT 1', (SELECT id FROM qn))), 'false',
  'she has not answered');
SELECT is(pg_temp.ask('boris', 'SELECT count(*)::text FROM app.student_questionnaires()'), '0', 'Boris lists none');
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM app.student_questionnaires()'), '0', 'a teacher is no respondent');
SELECT is(substr(pg_temp.ask('vesna', format('SELECT count(*)::text FROM app.student_questionnaire(%L)', (SELECT id FROM qn))), 1, 5), 'ZD404',
  'a teacher does not read the student form');
-- Refused values.
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, ''[]'')', (SELECT id FROM qn))), 'ZD422', 'no answer');
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn),
  jsonb_build_array(jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 1), 'value', 'mozda'))::text)),
  'ZD422', 'a code that is no option');
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn),
  jsonb_build_array(jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 3), 'value', 6))::text)),
  'ZD422', 'a scale value out of range');
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn),
  jsonb_build_array(jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 2), 'value', jsonb_build_array('voce', 'voce')))::text)),
  'ZD422', 'a repeated code of a multiple choice');
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn),
  jsonb_build_array(jsonb_build_object('questionId', gen_random_uuid(), 'value', 'da'))::text)),
  'ZD422', 'a question that is not of the questionnaire');
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn),
  jsonb_build_array(jsonb_build_object('questionId', (SELECT id FROM institution.questionnaire_question WHERE ord = 4), 'value', '"x"'::jsonb))::text)),
  'ZD422', 'a text where a number is asked');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_response) + (SELECT count(*)::integer FROM institution.questionnaire_participation), 0,
  'a refusal leaves neither a sheet nor a participation');
-- The relation first.
SELECT is(pg_temp.code(c.actor, format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers())), c.result,
  format('%s answers: %s', c.actor, c.result))
FROM (VALUES ('vesna', 'ZD404'), ('marko', 'ZD404'), ('boris', 'ZD404'), ('tomo', 'ZD404'), ('petra', 'ZD404'),
             ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', gen_random_uuid(), pg_temp.answers())), 'ZD404',
  'an unknown questionnaire is the same refusal');
-- The once rule.
SELECT is(pg_temp.code('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers())), 'ok', 'Ana answers');
SELECT is(pg_temp.msg('ana', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers())),
  'ZD409: already_answered', 'Ana answers a second time');
SELECT is(pg_temp.ask('ana', format('SELECT participated::text FROM app.student_questionnaire(%L) LIMIT 1', (SELECT id FROM qn))), 'true',
  'she is shown as having answered');
SELECT is(pg_temp.code('dora', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers('Manje posla'))), 'ok',
  'Dora answers');
SELECT is(pg_temp.code('vesna', format('SELECT app.manual_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers('Papirnati list'))), 'ok',
  'Vesna enters a sheet by hand');
SELECT is(pg_temp.code(c.actor, format('SELECT app.manual_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers())), c.result,
  format('%s enters a sheet by hand: %s', c.actor, c.result))
FROM (VALUES ('marko', 'ZD404'), ('ana', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);

-- Anonymity: what the tables can and cannot say.
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_response), 3, 'three sheets (two students, one by hand)');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_participation), 2, 'two participations');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_answer), 15, 'fifteen answers');
SELECT is_empty(
  $$ SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'institution' AND table_name IN ('questionnaire_response', 'questionnaire_answer')
       AND (column_name ~ '(user|person|student|principal|author|actor|account)' OR data_type LIKE 'timestamp%') $$,
  'no column of a sheet or an answer names a person or holds a time');
SELECT is_empty(
  $$ SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'institution' AND table_name = 'questionnaire_participation'
       AND (column_name ~ 'response|answer' OR data_type LIKE 'timestamp%') $$,
  'no column of the participation names a sheet or holds a time');
SELECT is_empty(
  $$ SELECT conname FROM pg_constraint
     WHERE contype = 'f' AND (
       (conrelid = 'institution.questionnaire_participation'::regclass
         AND confrelid IN ('institution.questionnaire_response'::regclass, 'institution.questionnaire_answer'::regclass))
       OR (conrelid IN ('institution.questionnaire_response'::regclass, 'institution.questionnaire_answer'::regclass)
         AND confrelid IN ('identity.user_account'::regclass, 'institution.questionnaire_participation'::regclass))) $$,
  'no foreign key links a sheet to a person or to a participation');
SELECT is((SELECT count(*)::integer FROM institution.questionnaire_response WHERE answered_on = current_date), 3,
  'the sheets carry the date');

-- Reading the answers: the teachers only; no person comes with them.
SELECT is(substr(pg_temp.ask(c.actor, format('SELECT count(*)::text FROM app.questionnaire_answer_rows(%L)', (SELECT id FROM qn))), 1, 5), c.result,
  format('%s reads the answer rows: %s', c.actor, c.result))
FROM (VALUES ('vesna', '15'), ('marko', 'ZD404'), ('ana', 'ZD404'), ('boris', 'ZD404'), ('petra', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(substr(pg_temp.ask(c.actor, format('SELECT count(*)::text FROM app.questionnaire_response_ids(%L)', (SELECT id FROM qn))), 1, 5), c.result,
  format('%s reads the sheet ids: %s', c.actor, c.result))
FROM (VALUES ('vesna', '3'), ('marko', 'ZD404'), ('ana', 'ZD404'), ('anon', 'ZD401')) AS c (actor, result);
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM app.teacher_questionnaires({k1}) WHERE response_count = 3'), '1',
  'the list counts three sheets');

-- Records are only added.
SELECT throws_ok($$ UPDATE institution.questionnaire_response SET answered_on = current_date $$, 'ZD409', 'conflict', 'a sheet is not updated');
SELECT throws_ok($$ DELETE FROM institution.questionnaire_answer $$, 'ZD409', 'conflict', 'an answer is not deleted');
SELECT throws_ok($$ UPDATE institution.questionnaire_participation SET participated_on = current_date $$, 'ZD409', 'conflict', 'a participation is not updated');
SELECT throws_ok($$ DELETE FROM institution.questionnaire $$, 'ZD409', 'conflict', 'a questionnaire is not deleted');
SELECT throws_ok($$ TRUNCATE institution.questionnaire_response CASCADE $$, 'ZD409', 'conflict', 'nothing is truncated');
SELECT throws_ok($$ UPDATE institution.questionnaire SET course_id = pg_temp.id('k2') $$, 'ZD409', 'conflict', 'a questionnaire does not move to another course');

-- Closing.
SELECT is(pg_temp.code('vesna', format('SELECT app.set_questionnaire_state(%L, ''open'')', (SELECT id FROM qn))), 'ZD409', 'an open questionnaire is not opened again');
SELECT is(pg_temp.code('vesna', format('SELECT app.set_questionnaire_state(%L, ''closed'')', (SELECT id FROM qn))), 'ok', 'Vesna closes it');
SELECT is(pg_temp.code('vesna', format('SELECT app.set_questionnaire_state(%L, ''open'')', (SELECT id FROM qn))), 'ZD409', 'a closed questionnaire is not reopened');
SELECT is(pg_temp.ask('dora', 'SELECT count(*)::text FROM app.student_questionnaires()'), '0', 'a closed questionnaire is not listed to a student');
SELECT is(pg_temp.code('dora', format('SELECT app.submit_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers())), 'ZD404',
  'a closed questionnaire takes no answer (the catalogue refusal)');
SELECT is(pg_temp.code('vesna', format('SELECT app.manual_questionnaire_response(%L, %L)', (SELECT id FROM qn), pg_temp.answers())), 'ZD409',
  'a closed questionnaire takes no sheet by hand');
SELECT is(pg_temp.msg('vesna', format('SELECT app.update_questionnaire(%L, ''Kasno'', %L)', (SELECT id FROM qn), pg_temp.questions())), 'ZD409: not_draft',
  'a closed questionnaire is not edited');
SELECT is(pg_temp.ask('vesna', format('SELECT count(*)::text FROM app.questionnaire_answer_rows(%L)', (SELECT id FROM qn))), '15',
  'the teacher still reads the answers of a closed questionnaire');

-- The value rules, directly.
SELECT is(institution.questionnaire_value_valid('single', '[{"code":"a","label":"A"},{"code":"b","label":"B"}]', NULL, '"a"'), true, 'single: an option');
SELECT is(institution.questionnaire_value_valid('single', '[{"code":"a","label":"A"},{"code":"b","label":"B"}]', NULL, '["a"]'), false, 'single: not a list');
SELECT is(institution.questionnaire_value_valid('multiple', '[{"code":"a","label":"A"},{"code":"b","label":"B"}]', NULL, '[]'), false, 'multiple: not empty');
SELECT is(institution.questionnaire_value_valid('multiple', '[{"code":"a","label":"A"},{"code":"b","label":"B"}]', NULL, '["a","b"]'), true, 'multiple: two options');
SELECT is(institution.questionnaire_value_valid('scale', NULL, '{"min":1,"max":5}', '5'), true, 'scale: the top');
SELECT is(institution.questionnaire_value_valid('scale', NULL, '{"min":1,"max":5}', '0'), false, 'scale: below the bottom');
SELECT is(institution.questionnaire_value_valid('scale', NULL, '{"min":1,"max":5}', '2.5'), false, 'scale: not a whole number');
SELECT is(institution.questionnaire_value_valid('number', NULL, NULL, '-3.25'), true, 'number: a decimal');
SELECT is(institution.questionnaire_value_valid('number', NULL, NULL, '1e12'), false, 'number: too large');
SELECT is(institution.questionnaire_value_valid('text', NULL, NULL, '"bilješka"'), true, 'text: a word');
SELECT is(institution.questionnaire_value_valid('text', NULL, NULL, '""'), false, 'text: not empty');
SELECT is(institution.questionnaire_value_valid('text', NULL, NULL, 'null'), false, 'text: not null');

SELECT * FROM finish();
ROLLBACK;
