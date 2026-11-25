-- SRV-ASIST-PREKIDAC (Ductus#2055, T4): the switch "Asistent uključen" per
-- course (20261219400000). Only a teacher of the course sets and reads it; it is
-- on by default; every change leaves an append-only audit row in the same call.
-- A student of the assignment reads the availability: the institution has a
-- published cost configuration (the same test as begin_request's ai_disabled,
-- checked step by step against begin_request itself) and the course did not
-- switch it off. Anyone else gets not_found. All people are the invented ones
-- of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.key(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-000000254' || lpad(p_n::text, 3, '0'))::uuid
$$;
-- Does begin_request answer ai_disabled for Ana on Z1?
CREATE FUNCTION pg_temp.begin_disabled(p_n integer) RETURNS boolean LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format(
    $q$ SELECT coalesce(reason, '-') = 'ai_disabled' FROM assistant.begin_request(%L, {z1}, NULL, 1, 'proofreading',
        'Izmišljeni odlomak.', 'provider-test-a', 'model-test-1', 'test-1') $q$, pg_temp.key(p_n)))::boolean
$$;
-- What Ana reads: "outcome/available".
CREATE FUNCTION pg_temp.available(p_actor text DEFAULT 'ana', p_assignment text DEFAULT '{z1}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT outcome || '/' || coalesce(available::text, '-') FROM app.my_assistant_available(%s) $q$, p_assignment))
$$;

-- 1. Catalogue.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.course_assistant_switch(uuid,boolean)', 'app.course_assistant_switch_read(uuid)',
       'app.my_assistant_available(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs of the switch');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_identity'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.assistant_cost_published()', 'app.course_assistant_on(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers belong to no role but the owner');
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns
      WHERE table_schema = 'institution' AND table_name = 'course_assistant_setting' $$,
  ARRAY['institution_id', 'course_id', 'enabled', 'changed_by', 'changed_at'],
  'the course''s switch holds a state and its bookkeeping only');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_identity', 'audit', 'CREATE')
    AND NOT has_schema_privilege('ductus_identity', 'institution', 'CREATE'),
  'after the migration ductus_identity keeps no CREATE it was lent');
SELECT ok(NOT has_table_privilege('ductus_app', 'institution.course_assistant_setting', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('ductus_app', 'audit.assistant_course_switch_event', 'SELECT,INSERT,UPDATE,DELETE'),
  'the web role touches neither table directly');

-- 2. On by default; Vesna, teacher of K1, reads it.
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch_read(%L) $$, pg_temp.id('k1'))),
  'true', 'the course''s switch is on by default');

-- 3. Negative controls on K1: nobody but its teacher sets or reads it.
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, false) $$, pg_temp.id('k1'))), '^ZD403',
  a.name || ' does not set the switch of K1')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('marko'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.ask(a.name, format($$ SELECT enabled::text FROM app.course_assistant_switch_read(%L) $$, pg_temp.id('k1'))), '^ZD403',
  a.name || ' does not read the switch of K1')
FROM (VALUES ('ana'), ('marko'), ('iva'), ('petra')) AS a (name);
SELECT matches(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, false) $$, pg_temp.id('k2'))), '^ZD403',
  'Vesna does not set the switch of K2');
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled::text FROM app.course_assistant_switch('00000000-0000-4000-8000-00000000dead', false) $$), '^ZD403',
  'an unknown course: ZD403');
SELECT matches(pg_temp.ask('vesna', $$ SELECT enabled::text FROM app.course_assistant_switch(NULL, false) $$), '^ZD403', 'no course: ZD403');
SELECT matches(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, NULL) $$, pg_temp.id('k1'))), '^ZD422',
  'no state: ZD422');
SELECT matches(pg_temp.ask(t.name, format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, false) $$, pg_temp.id('k1'))), '^ZD401',
  'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT matches(pg_temp.ask(t.name, format($$ SELECT outcome FROM app.my_assistant_available(%L) $$, pg_temp.id('z1'))), '^ZD401',
  'session ' || t.name || ' reads no availability')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is((SELECT count(*) FROM institution.course_assistant_setting), 0::bigint, 'no refused call left a setting');
SELECT is((SELECT count(*) FROM audit.assistant_course_switch_event), 0::bigint, 'and no audit row');

-- 4. Who reads the availability of Z1: its students only.
SELECT is(pg_temp.available(a.name), 'not_found/-', a.name || ' reads no availability of Z1')
FROM (VALUES ('vesna'), ('marko'), ('boris'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.available('ana', '''00000000-0000-4000-8000-00000000dead'''), 'not_found/-', 'an unknown assignment: not_found');
SELECT is(pg_temp.available('ana', 'NULL'), 'not_found/-', 'no assignment: not_found');
SELECT is(pg_temp.available('ana', '{z2}'), 'not_found/-', 'Ana reads no availability of Z2 in K2');

-- 5. (b) step by step against begin_request: available exactly when it is not ai_disabled.
SELECT is(pg_temp.available(), 'found/false', 'nothing published: not available');
SELECT ok(pg_temp.begin_disabled(1), 'and begin_request agrees: ai_disabled');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(0, 30, 30, 7) $$),
  'published:1', 'the administrator publishes the student limits and the reservation');
SELECT is(pg_temp.available(), 'found/false', 'without a cap of the institution: not available');
SELECT ok(pg_temp.begin_disabled(2), 'and begin_request agrees');
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 1, 100, 'day', 'Zahtjev 1/2026'), 2, 'the operator publishes the cap of the institution');
SELECT is(pg_temp.available(), 'found/false', 'without a cap of the service: not available');
SELECT ok(pg_temp.begin_disabled(3), 'and begin_request agrees');
SELECT is(assistant.publish_cost_cap(NULL, (SELECT coalesce(max(version_no), 0) FROM assistant.cost_config_version WHERE institution_id IS NULL),
  1000000, 'month', 'Zahtjev 2/2026') > 0, true, 'the operator publishes the cap of the service');
SELECT is(pg_temp.available(), 'found/true', 'everything published: available');
SELECT ok(NOT pg_temp.begin_disabled(4), 'and begin_request agrees: not ai_disabled');
SELECT is(pg_temp.available('dora'), 'found/true', 'Dora, also a student of Z1, reads the same');

-- 6. (c): Vesna switches K1 off, then on again.
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, false) $$, pg_temp.id('k1'))),
  'false', 'Vesna switches the assistant of K1 off');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch_read(%L) $$, pg_temp.id('k1'))),
  'false', 'and reads it off');
SELECT is(pg_temp.available(), 'found/false', 'Ana: not available in a course switched off');
SELECT is((SELECT enabled::text || '/' || (changed_by = pg_temp.id('vesna'))::text FROM institution.course_assistant_setting
            WHERE course_id = pg_temp.id('k1')), 'false/true', 'the row holds the state and who set it');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, false) $$, pg_temp.id('k1'))),
  'false', 'switching off again answers the same');
SELECT is((SELECT count(*) FROM audit.assistant_course_switch_event), 1::bigint, 'and writes no second audit row');
SELECT is(pg_temp.ask('vesna', format($$ SELECT enabled::text FROM app.course_assistant_switch(%L, true) $$, pg_temp.id('k1'))),
  'true', 'Vesna switches it on again');
SELECT is(pg_temp.available(), 'found/true', 'Ana: available again');
SELECT is((SELECT string_agg(enabled::text || ':' || (actor_id = pg_temp.id('vesna'))::text, ',' ORDER BY occurred_at, enabled)
             FROM audit.assistant_course_switch_event WHERE course_id = pg_temp.id('k1')),
  'false:true,true:true', 'every change has its audit row, by Vesna');

-- 7. The trail is append-only; the web role writes neither table.
SELECT throws_ok($$ UPDATE audit.assistant_course_switch_event SET enabled = NOT enabled $$, NULL, NULL, 'the trail refuses an update');
SELECT throws_ok($$ DELETE FROM audit.assistant_course_switch_event $$, NULL, NULL, 'the trail refuses a delete');
SELECT throws_ok($$ TRUNCATE audit.assistant_course_switch_event $$, NULL, NULL, 'the trail refuses a truncate');
SELECT matches(pg_temp.ask('vesna', format($$ INSERT INTO institution.course_assistant_setting (institution_id, course_id, enabled, changed_by)
    VALUES (%L, %L, false, %L) RETURNING 'written' $$, pg_temp.id('fak_a'), pg_temp.id('k1'), pg_temp.id('vesna'))), '^42501',
  'the web role writes no setting directly');

SELECT * FROM finish();
ROLLBACK;
