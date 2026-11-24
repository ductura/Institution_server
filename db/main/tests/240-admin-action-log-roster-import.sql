-- SRV-ADMIN-2B uvoz-popisa-dnevnik-radnji (Ductus#2055): the confirmation of
-- a roster import (235-, institution.confirm_roster_import) is a row of the
-- administrators' action log (233-, app.admin_action_log, migration
-- 20261217130000): when, in which role, for which course and how many
-- accounts were enrolled, already enrolled and skipped. A preview, a repeated
-- confirmation and a refused one are no rows; no person is named.
-- Every person, identifier and course is invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(17);

CREATE FUNCTION pg_temp.row(p_identifier text, p_given text, p_family text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('identifier', p_identifier, 'givenName', p_given, 'familyName', p_family)
$$;
-- Boris (fak-a, in no course) is new in K1; Ana is already a student of it.
CREATE FUNCTION pg_temp.preview(p_actor text, p_course text, p_rows jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT institution.preview_roster_import(%s, 'merlin', %L::jsonb)->>'import_id' $q$,
                                     p_course, p_rows::text))
$$;
CREATE FUNCTION pg_temp.confirm(p_actor text, p_import text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT institution.confirm_roster_import(%L)::text', p_import))
$$;
-- The import entries of the log, as text; nothing else of the log.
CREATE FUNCTION pg_temp.imports(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$
    SELECT coalesce(string_agg(l.actor_role || ' ' || l.action || ' ' || coalesce(l.subject_role, '-') || ' ' || l.outcome
                               || ' ' || l.enrolled_count || '/' || l.already_enrolled_count || '/' || l.skipped_count,
                               ' | ' ORDER BY l.enrolled_count), '')
      FROM app.admin_action_log() l WHERE l.action = 'roster_import_confirmed' $q$)
$$;

-- 1. Before any import, and a preview alone, leave nothing.
SELECT is(pg_temp.imports('iva'), '', 'no import confirmed: no entry');
INSERT INTO ref VALUES ('i1', pg_temp.preview('iva', '{k1}',
  jsonb_build_array(pg_temp.row('boris@fak-a.example', 'Boris', 'Izmišljeni'),
                    pg_temp.row('ana@fak-a.example', 'Ana', 'Izmišljena'))));
SELECT matches((SELECT val FROM ref WHERE name = 'i1'), '^[0-9a-f-]{36}$', 'Iva previews an import');
SELECT is(pg_temp.imports('iva'), '', 'a preview is no entry');

-- 2. The confirmation is one entry with its counts and course.
SELECT is(pg_temp.confirm('iva', (SELECT val FROM ref WHERE name = 'i1')),
  '{"skipped": 0, "enrolled": 1, "already_enrolled": 0, "already_confirmed": false}', 'Iva confirms: Boris is enrolled');
SELECT is(pg_temp.imports('iva'), 'institution_admin roster_import_confirmed - completed 1/0/0',
  'the confirmation is one entry: administrator, completed, 1 enrolled');
SELECT is(pg_temp.ask('iva', format($$ SELECT count(*)::text FROM app.admin_action_log() l
    WHERE l.action = 'roster_import_confirmed' AND l.course_id = %L $$, pg_temp.id('k1'))), '1',
  'the entry names the course');
SELECT is(pg_temp.ask('iva', $$ SELECT count(*)::text FROM app.admin_action_log() l
    WHERE l.action <> 'roster_import_confirmed'
      AND (l.course_id IS NOT NULL OR l.enrolled_count IS NOT NULL
           OR l.already_enrolled_count IS NOT NULL OR l.skipped_count IS NOT NULL) $$), '0',
  'no other action carries a course or counts');

-- 3. Confirmed again: the first result, no second entry.
SELECT is(pg_temp.confirm('iva', (SELECT val FROM ref WHERE name = 'i1')),
  '{"skipped": 0, "enrolled": 1, "already_enrolled": 0, "already_confirmed": true}', 'confirmed again answers the first result');
SELECT is(pg_temp.imports('iva'), 'institution_admin roster_import_confirmed - completed 1/0/0',
  'a repeated confirmation adds no entry');

-- 4. A refused confirmation and an import never confirmed leave no entry.
SELECT is(pg_temp.confirm('vesna', (SELECT val FROM ref WHERE name = 'i1')), 'ZD403: forbidden', 'a teacher cannot confirm');
INSERT INTO ref VALUES ('i2', pg_temp.preview('iva', '{k1}', jsonb_build_array(pg_temp.row('ana@fak-a.example', 'Ana', 'Izmišljena'))));
SELECT is(pg_temp.imports('iva'), 'institution_admin roster_import_confirmed - completed 1/0/0',
  'an import never confirmed is no entry');

-- 5. A second confirmed import is a second entry, with its own counts.
SELECT is(pg_temp.confirm('iva', (SELECT val FROM ref WHERE name = 'i2')),
  '{"skipped": 0, "enrolled": 0, "already_enrolled": 0, "already_confirmed": false}', 'an import with nobody new is confirmed');
SELECT is(pg_temp.imports('iva'),
  'institution_admin roster_import_confirmed - completed 0/0/0 | institution_admin roster_import_confirmed - completed 1/0/0',
  'two imports are two entries');

-- 6. Only the administrators of the institution, and only its own.
SELECT is(pg_temp.imports('lea'), '', 'the administrator of fak-b reads nothing of fak-a''s imports');
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM app.admin_action_log()'), 'ZD403: forbidden',
  'a teacher still does not read the log');

-- 7. No person: nothing the log returns for an import is an id or the
-- identifier of an account.
CREATE TEMP TABLE shown AS
SELECT pg_temp.ask('iva', $$ SELECT string_agg(concat_ws(' ', l.occurred_at, l.actor_role, l.action, l.subject_role, l.outcome,
                                                   l.course_id, l.enrolled_count, l.already_enrolled_count, l.skipped_count), ' ; ')
                              FROM app.admin_action_log() l WHERE l.action = 'roster_import_confirmed' $$) AS text;
SELECT is((SELECT count(*) FROM shown s, identity.user_account u
            WHERE strpos(s.text, u.id::text) > 0 OR strpos(lower(s.text), lower(u.hr_edu_person_unique_id)) > 0),
  0::bigint, 'no entry carries the id or the identifier of an account');

-- 8. The entries cannot be changed through the source: the import is fixed.
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', format($$ UPDATE institution.roster_import SET enrolled_count = 9 WHERE id = %L $$,
  pg_temp.id('i1'))), 'ZD409: roster import is fixed', 'the counts of a confirmed import cannot be changed');

SELECT * FROM finish();
ROLLBACK;
