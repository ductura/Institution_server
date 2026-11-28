-- SRV-V13-VRSTA-PISAC (migration 20261220860000): the creation stores the
-- kind of document of an assignment in institution.assignment.document_kind,
-- and a version cannot name another kind. Without the migration every
-- creation below with a kind fails (no such function) and every read of the
-- kind is 'text'. Personas of institution.inc; the content is invented.
-- Vesna teaches K1 (Ana is its student), Marko K2.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- The id, or "SQLSTATE: ...". p_kind is the SQL of the last argument, '' for none.
CREATE FUNCTION pg_temp.create_kind(p_actor text, p_key text, p_kind text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT institution.create_assignment_with_groups({k1}, %L::uuid,
      'Izmišljena prezentacija', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      'partially_allowed', '{}', 'basic', false, NULL, NULL, 1, false, false, false, '{}'::uuid[]%s)::text
  $q$, p_key, CASE WHEN p_kind = '' THEN '' ELSE ', ' || p_kind END))
$$;
-- The new version number, or "SQLSTATE: ...".
CREATE FUNCTION pg_temp.publish_kind(p_actor text, p_assignment text, p_expected integer, p_kind text)
RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT institution.publish_assignment_version(%L::uuid, %s,
      'Izmišljena prezentacija', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      'partially_allowed', '{}', 'basic', false, NULL, NULL%s)::text
  $q$, p_assignment, p_expected, CASE WHEN p_kind = '' THEN '' ELSE ', ' || p_kind END))
$$;
-- The kind as an actor reads it through ductus_app and the row security.
CREATE FUNCTION pg_temp.kind_as(p_actor text, p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce((SELECT document_kind FROM institution.assignment WHERE id = %L::uuid), '-') $q$,
    p_assignment))
$$;
CREATE FUNCTION pg_temp.val(p_name text) RETURNS text
LANGUAGE sql AS $$ SELECT val FROM ref WHERE name = p_name $$;

-- 1. Each kind is stored on creation and read back as it was asked.
INSERT INTO ref SELECT 'zs', pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d801', $$'slides'$$);
INSERT INTO ref SELECT 'zt', pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d802', $$'spreadsheet'$$);
INSERT INTO ref SELECT 'zx', pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d803', $$'text'$$);
INSERT INTO ref SELECT 'zd', pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d804', '');
SELECT is((SELECT count(*)::integer FROM ref WHERE name IN ('zs', 'zt', 'zx', 'zd') AND val ~ '^[0-9a-f-]{36}$'), 4,
  'Vesna creates a slides, a spreadsheet, a text and a kindless assignment');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zs')), 'slides', 'the teacher reads the slides assignment as slides');
SELECT is(pg_temp.kind_as('ana', pg_temp.val('zs')), 'slides', 'a student of the course reads it as slides');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zt')), 'spreadsheet', 'the spreadsheet assignment reads as spreadsheet');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zx')), 'text', 'text asked is text');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zd')), 'text', 'no kind is text, as before');
-- The bridge app.open_student_work starts the work from.
SELECT is(app.assignment_document_kind(pg_temp.val('zs')::uuid), 'slides',
  'the work of the slides assignment starts as slides');
SELECT is(app.assignment_document_kind(pg_temp.val('zt')::uuid), 'spreadsheet',
  'the work of the spreadsheet assignment starts as spreadsheet');
-- Strangers read nothing, as before: the kind follows the row security.
SELECT is(pg_temp.kind_as('marko', pg_temp.val('zs')), '-', 'a teacher of K2 reads no row');
SELECT is(pg_temp.kind_as('tomo', pg_temp.val('zs')), '-', 'a student of another institution reads no row');

-- 2. The key binds the kind: the same kind is the same id, another kind ZD409.
SELECT is(pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d801', $$'slides'$$), pg_temp.val('zs'),
  'a replay with the same kind answers the same id');
SELECT is(pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d801', $$'text'$$), 'ZD409: conflict',
  'a replay of the slides key as text is ZD409');
SELECT is(pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d801', ''), 'ZD409: conflict',
  'a replay of the slides key without a kind is ZD409');
SELECT is(pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d804', $$'slides'$$), 'ZD409: conflict',
  'a replay of a kindless key as slides is ZD409');
SELECT is(pg_temp.create_kind('vesna', '00000000-0000-4000-8000-00000000d804', $$'text'$$), pg_temp.val('zd'),
  'a replay of a kindless key as text answers the same id');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zs')), 'slides', 'the refused replay leaves the kind');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zd')), 'text', 'and the kindless one stays text');

-- 3. Anything but the three kinds is ZD422 before anything is written.
CREATE TEMP TABLE bad (key text, kind text);
INSERT INTO bad VALUES
  ('00000000-0000-4000-8000-00000000d805', $$'video'$$),
  ('00000000-0000-4000-8000-00000000d806', 'NULL'),
  ('00000000-0000-4000-8000-00000000d807', $$'Slides'$$),
  ('00000000-0000-4000-8000-00000000d808', $$''$$);
SELECT is(pg_temp.create_kind('vesna', b.key, b.kind), 'ZD422: invalid input', 'the kind ' || b.kind || ' is ZD422')
  FROM bad b;
SELECT is((SELECT count(*)::integer FROM institution.assignment
            WHERE request_id IN (SELECT key::uuid FROM bad)), 0, 'a refused kind creates no assignment');

-- 4. Who may is unchanged: a student of the course, a teacher of another
-- course and no session are refused, whatever the kind.
SELECT is(pg_temp.create_kind('ana', '00000000-0000-4000-8000-00000000d809', $$'slides'$$), 'ZD403: forbidden',
  'a student of K1 cannot create a slides assignment');
SELECT is(pg_temp.create_kind('marko', '00000000-0000-4000-8000-00000000d80a', $$'slides'$$), 'ZD403: forbidden',
  'a teacher of K2 cannot create one in K1');
SELECT is(pg_temp.create_kind('anon', '00000000-0000-4000-8000-00000000d80b', $$'slides'$$),
  'ZD401: not authenticated', 'no session is ZD401');

-- 5. A version keeps the kind: naming another is ZD422 and writes nothing;
-- the same kind or none publishes as before.
SELECT is(pg_temp.publish_kind('vesna', pg_temp.val('zs'), 1, $$'text'$$), 'ZD422: invalid input',
  'a text version of the slides assignment is ZD422');
SELECT is(pg_temp.publish_kind('vesna', pg_temp.val('zs'), 1, $$'spreadsheet'$$), 'ZD422: invalid input',
  'a spreadsheet version of the slides assignment is ZD422');
SELECT is(pg_temp.publish_kind('vesna', pg_temp.val('zd'), 1, $$'slides'$$), 'ZD422: invalid input',
  'a slides version of a text assignment is ZD422');
SELECT is((SELECT current_version FROM institution.assignment WHERE id = pg_temp.val('zs')::uuid), 1,
  'the refused versions write nothing');
SELECT is(pg_temp.publish_kind('vesna', pg_temp.val('zs'), 1, $$'slides'$$), '2',
  'a slides version of the slides assignment is version 2');
SELECT is(pg_temp.publish_kind('vesna', pg_temp.val('zs'), 2, ''), '3', 'a version without a kind is version 3');
SELECT is(pg_temp.publish_kind('vesna', pg_temp.val('zs'), 3, 'NULL'), '4', 'a NULL kind checks nothing');
SELECT is(pg_temp.kind_as('vesna', pg_temp.val('zs')), 'slides', 'the versions leave the kind');
-- A stranger learns nothing about the kind: ZD403 comes first.
SELECT is(pg_temp.publish_kind('marko', pg_temp.val('zs'), 4, $$'text'$$), 'ZD403: forbidden',
  'a teacher of K2 is ZD403 with the wrong kind');
SELECT is(pg_temp.publish_kind('marko', pg_temp.val('zs'), 4, $$'slides'$$), 'ZD403: forbidden',
  'and with the right one');

-- 6. No access change: one function of each name, executed by ductus_app
-- only, and the application role still cannot write the column.
SELECT is((SELECT count(*)::integer FROM pg_proc
            WHERE pronamespace = 'institution'::regnamespace
              AND proname IN ('create_assignment_with_groups', 'publish_assignment_version')), 2,
  'the old signatures are gone, one function of each name');
SELECT is((SELECT string_agg(p.oid::regprocedure::text, ', ')
             FROM pg_proc p
            WHERE p.pronamespace = 'institution'::regnamespace
              AND p.proname IN ('create_assignment_with_groups', 'publish_assignment_version')
              AND has_function_privilege('public', p.oid, 'EXECUTE')),
  NULL, 'PUBLIC executes neither');
SELECT ok(NOT has_column_privilege('ductus_app', 'institution.assignment', 'document_kind', 'UPDATE')
          AND NOT has_column_privilege('ductus_app', 'institution.assignment', 'document_kind', 'INSERT'),
  'ductus_app still cannot write document_kind');

SELECT * FROM finish();
ROLLBACK;
