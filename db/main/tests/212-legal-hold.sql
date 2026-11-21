-- SRV-1305 (M10.3): legal hold. An administrator places a hold on a work, a
-- student or an assignment of their institution; another administrator of the
-- same institution, or the operator, releases it. Every person, case and
-- reason below is invented (fixtures/institution.inc: Iva and Lea are the
-- administrators of fak-a and fak-b; Boris becomes a second administrator of
-- fak-a here; doc-a is a work of fak-a, doc-b of fak-b).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

DO $$
BEGIN
  PERFORM institution.appoint_institution_admin(pg_temp.id('boris'), 'Zahtjev boris/2026');
END
$$;

-- 1. Catalogue.
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' '
                     || p.prosecdef || ' ' || ('search_path=""' = ANY (p.proconfig)), ', ' ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.oid IN ('app.legal_hold_append(text,text,text)'::regprocedure,
                    'app.legal_hold_release(uuid,text)'::regprocedure,
                    'app.legal_holds_of()'::regprocedure,
                    'app.is_on_legal_hold(text,text)'::regprocedure,
                    'evidence.operator_release_legal_hold(uuid,text,text)'::regprocedure,
                    'institution.require_legal_hold_admin()'::regprocedure,
                    'app.place_legal_hold(text,text,text)'::regprocedure,
                    'app.release_legal_hold(uuid,text)'::regprocedure,
                    'app.legal_holds()'::regprocedure)),
  'app.is_on_legal_hold(text,text) ductus_evidence true true, '
  || 'app.legal_hold_append(text,text,text) ductus_evidence true true, '
  || 'app.legal_hold_release(uuid,text) ductus_evidence true true, '
  || 'app.legal_holds() ductus_identity true true, '
  || 'app.legal_holds_of() ductus_evidence true true, '
  || 'app.place_legal_hold(text,text,text) ductus_identity true true, '
  || 'app.release_legal_hold(uuid,text) ductus_identity true true, '
  || 'evidence.operator_release_legal_hold(uuid,text,text) ductus_evidence false true, '
  || 'institution.require_legal_hold_admin() ductus_identity false true',
  'owners, SECURITY DEFINER except the operator''s release and the administrator check, and an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['app.legal_hold_append(text,text,text)',
                              'app.legal_hold_release(uuid,text)', 'app.legal_holds_of()',
                              'app.is_on_legal_hold(text,text)', 'evidence.operator_release_legal_hold(uuid,text,text)',
                              'institution.require_legal_hold_admin()', 'app.place_legal_hold(text,text,text)',
                              'app.release_legal_hold(uuid,text)', 'app.legal_holds()']) f
      WHERE has_function_privilege(r, f, 'EXECUTE')
        AND NOT (r = 'ductus_evidence' AND f IN ('app.legal_hold_append(text,text,text)',
                 'app.legal_hold_release(uuid,text)', 'app.legal_holds_of()',
                 'app.is_on_legal_hold(text,text)', 'evidence.operator_release_legal_hold(uuid,text,text)'))
        AND NOT (r = 'ductus_identity' AND f IN ('institution.require_legal_hold_admin()',
                 'app.place_legal_hold(text,text,text)', 'app.release_legal_hold(uuid,text)', 'app.legal_holds()')) $$,
  ARRAY['ductus_app app.place_legal_hold(text,text,text)', 'ductus_app app.release_legal_hold(uuid,text)',
        'ductus_app app.legal_holds()', 'ductus_retention app.is_on_legal_hold(text,text)',
        'ductus_identity app.legal_hold_append(text,text,text)',
        'ductus_identity app.legal_hold_release(uuid,text)', 'ductus_identity app.legal_holds_of()'],
  'the app runs the three RPCs, retention only asks, identity calls the private steps; nobody runs the operator''s');
SELECT is(pg_get_function_arguments('app.place_legal_hold(text,text,text)'::regprocedure),
  'p_subject_type text, p_subject_id text, p_case_reference text', 'placing names no institution or administrator');

-- 2. Who may place.
SELECT is(pg_temp.ask(c.actor, $$ SELECT app.place_legal_hold('work', 'doc-a', 'Predmet 1/2026') IS NOT NULL $$)::text,
  c.result, format('%s places a hold on a work of fak-a: %s', c.actor, c.result))
FROM (VALUES
  ('vesna', 'ZD403: forbidden'), ('ana', 'ZD403: forbidden'), ('lea', 'ZD404: not found'),
  ('closed', 'ZD401: not authenticated'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
INSERT INTO ref SELECT 'h1', pg_temp.ask('iva', $$ SELECT app.place_legal_hold('work', 'doc-a', 'Predmet 1/2026') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'h1'), '^[0-9a-f-]{36}$', 'Iva places a hold on doc-a');
INSERT INTO ref SELECT 'h2', pg_temp.ask('iva', $$ SELECT app.place_legal_hold('work', 'doc-a', 'Predmet 2/2026') $$);
INSERT INTO ref SELECT 'h3', pg_temp.ask('iva', $$ SELECT app.place_legal_hold('student', {ana}, 'Predmet 3/2026') $$);
INSERT INTO ref SELECT 'h4', pg_temp.ask('iva', $$ SELECT app.place_legal_hold('assignment', {z1}, 'Predmet 4/2026') $$);
SELECT ok((SELECT bool_and(val ~ '^[0-9a-f-]{36}$') FROM ref WHERE name IN ('h2', 'h3', 'h4')),
  'a second hold on the same work, a student and an assignment are placed');

SELECT is(pg_temp.ask('iva', format($$ SELECT app.place_legal_hold(%L, %L, %L) $$, c.t, c.s, c.r)), c.result,
  format('Iva places %s %s: %s', c.t, c.s, c.result))
FROM (VALUES
  ('work', 'doc-b', 'Predmet 5/2026', 'ZD404: not found'),
  ('work', 'doc-none', 'Predmet 5/2026', 'ZD404: not found'),
  ('student', pg_temp.id('tomo')::text, 'Predmet 5/2026', 'ZD404: not found'),
  ('assignment', pg_temp.id('z3')::text, 'Predmet 5/2026', 'ZD404: not found'),
  ('assignment', pg_temp.id('nobody')::text, 'Predmet 5/2026', 'ZD404: not found'),
  ('student', 'not-a-uuid', 'Predmet 5/2026', 'ZD422: invalid input'),
  ('course', 'doc-a', 'Predmet 5/2026', 'ZD422: invalid input'),
  ('work', ' doc-a', 'Predmet 5/2026', 'ZD422: invalid input'),
  ('work', 'doc-a', ' Predmet', 'ZD422: invalid input'),
  ('work', 'doc-a', '', 'ZD422: invalid input'),
  ('work', 'doc-a', repeat('p', 121), 'ZD422: invalid input'),
  ('work', 'doc-a', 'Predmet' || chr(10) || '5', 'ZD422: invalid input')
) AS c (t, s, r, result);

-- 3. Who sees the holds.
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.legal_holds()'), c.result,
  format('%s lists the holds: %s', c.actor, c.result))
FROM (VALUES ('iva', '4'), ('boris', '4'), ('lea', '0'), ('vesna', 'ZD403: forbidden'), ('anon', 'ZD401: not authenticated'))
  AS c (actor, result);
SELECT is(pg_temp.ask('boris', $$ SELECT string_agg(subject_type || ':' || case_reference || ':' || (placed_by = {iva}::uuid)
                                                   || ':' || (released_at IS NULL), ' ' ORDER BY case_reference)
                                    FROM app.legal_holds() $$),
  'work:Predmet 1/2026:true:true work:Predmet 2/2026:true:true student:Predmet 3/2026:true:true '
  || 'assignment:Predmet 4/2026:true:true', 'Boris sees what Iva placed and that it is unreleased');

-- 4. Release.
SELECT is(pg_temp.ask(c.actor, format($$ SELECT app.release_legal_hold(%L, 'Predmet zatvoren.') IS NOT NULL $$,
  (SELECT val FROM ref WHERE name = 'h1'))), c.result, format('%s releases the first hold: %s', c.actor, c.result))
FROM (VALUES ('iva', 'ZD403: forbidden'), ('lea', 'ZD404: not found'), ('vesna', 'ZD403: forbidden'))
  AS c (actor, result);
SELECT is(pg_temp.ask('boris', format($$ SELECT app.release_legal_hold(%L, %L) $$, (SELECT val FROM ref WHERE name = 'h1'), c.reason)),
  'ZD422: invalid input', format('a release with the reason %L is refused', c.reason))
FROM (VALUES (''), ('   '), (repeat('r', 601))) AS c (reason);
SELECT is(pg_temp.ask('boris', format($$ SELECT app.release_legal_hold(%L, 'Predmet zatvoren.') IS NOT NULL $$,
  (SELECT val FROM ref WHERE name = 'h1'))), 'true', 'Boris releases the hold Iva placed');
SELECT is(pg_temp.ask('boris', format($$ SELECT app.release_legal_hold(%L, 'Opet.') $$,
  (SELECT val FROM ref WHERE name = 'h1'))), 'ZD409: already released', 'a hold is released once');
SELECT is(pg_temp.ask('boris', format($$ SELECT app.release_legal_hold(%L, 'Nema ga.') $$,
  (SELECT val FROM ref WHERE name = 'nobody'))), 'ZD404: not found', 'an unknown hold is not found');
SELECT is(pg_temp.ask('iva', format($$ SELECT (released_by = {boris}::uuid AND released_at IS NOT NULL)::text
                                         FROM app.legal_holds() WHERE hold_id = %L $$, (SELECT val FROM ref WHERE name = 'h1'))),
  'true', 'the list shows who released it');

-- 5. What the deletion jobs see: a subject is held while any hold on it is open.
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', format($$ SELECT app.is_on_legal_hold(%L, %L)::text $$, c.t, c.s)),
  c.result, format('%s %s is held: %s', c.t, c.s, c.result))
FROM (VALUES
  ('work', 'doc-a', 'true'), ('student', pg_temp.id('ana')::text, 'true'),
  ('assignment', pg_temp.id('z1')::text, 'true'), ('work', 'doc-b', 'false'),
  ('student', pg_temp.id('dora')::text, 'false')
) AS c (t, s, result);
SELECT is(pg_temp.ask_as('ductus_app', 'iva', $$ SELECT app.is_on_legal_hold('work', 'doc-a')::text $$),
  '42501: permission denied for function is_on_legal_hold', 'the web role does not ask directly');

-- 6. The operator's release, on a request reference.
CREATE FUNCTION pg_temp.op(p_hold text, p_ref text, p_reason text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN (evidence.operator_release_legal_hold((SELECT val::uuid FROM ref WHERE name = p_hold), p_ref, p_reason)
          IS NOT NULL)::text;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END
$$;
SELECT is(pg_temp.op('h2', ' Zahtjev 7/2026', 'Sud je ukinuo mjeru.'), 'ZD422: invalid input', 'the operator''s reference is trimmed');
SELECT is(pg_temp.op('h2', 'Zahtjev 7/2026', '  '), 'ZD422: invalid input', 'the operator gives a reason');
SELECT is(pg_temp.op('nobody', 'Zahtjev 7/2026', 'Sud je ukinuo mjeru.'), 'ZD404: not found', 'the operator''s unknown hold');
SELECT is(pg_temp.op('h2', 'Zahtjev 7/2026', 'Sud je ukinuo mjeru.'), 'true', 'the operator releases the second hold');
SELECT is(pg_temp.op('h2', 'Zahtjev 7/2026', 'Opet.'), 'ZD409: already released', 'and only once');
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT app.is_on_legal_hold('work', 'doc-a')::text $$),
  'false', 'with both holds on doc-a released, doc-a is no longer held');
SET LOCAL ROLE ductus_evidence;
SELECT is((SELECT concat_ws(' ', released_by IS NULL, release_request_ref, release_reason)
             FROM evidence.legal_hold WHERE id = (SELECT val::uuid FROM ref WHERE name = 'h2')),
  'true Zahtjev 7/2026 Sud je ukinuo mjeru.', 'the operator''s release keeps the request reference, not a user');

-- 7. A row is never deleted, and only its release ever changes, once.
SELECT throws_ok($$ DELETE FROM evidence.legal_hold $$, 'ZD403', 'append-only row', 'no hold is deleted');
SELECT throws_ok($$ DELETE FROM evidence.legal_hold WHERE false $$, 'ZD403', 'append-only row',
  'not even a delete that matches nothing');
SELECT throws_ok($$ TRUNCATE evidence.legal_hold $$, 'ZD403', 'append-only row', 'nor truncated');
SELECT throws_ok(format($$ UPDATE evidence.legal_hold SET case_reference = 'Drugi' WHERE id = %L $$,
  (SELECT val FROM ref WHERE name = 'h3')), 'ZD403', 'append-only row', 'the case reference of an open hold stays');
SELECT throws_ok(format($$ UPDATE evidence.legal_hold SET release_reason = 'Drugi razlog.' WHERE id = %L $$,
  (SELECT val FROM ref WHERE name = 'h1')), 'ZD403', 'append-only row', 'a release is not rewritten');
SELECT throws_ok(format($$ UPDATE evidence.legal_hold SET released_by = placed_by, release_reason = 'Sam.', released_at = now()
                           WHERE id = %L $$, (SELECT val FROM ref WHERE name = 'h3')),
  '23514', NULL, 'the table itself refuses a release by the one who placed it');
RESET ROLE;

-- 8. The table is closed to every role but its owner.
SELECT is(pg_temp.ask_as(c.role, 'iva', 'SELECT count(*)::text FROM evidence.legal_hold'), c.result,
  format('%s reads the table: %s', c.role, c.result))
FROM (VALUES
  ('ductus_app', '42501: permission denied for table legal_hold'),
  ('ductus_retention', '42501: permission denied for schema evidence')
) AS c (role, result);

SELECT * FROM finish();
ROLLBACK;
