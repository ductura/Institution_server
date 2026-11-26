-- SRV-ED42-PRIJEDLOZI (Ductus#2058, PITANJE ED-42): the store of a teacher's
-- text suggestions (collaboration.suggestion, 20261220190000). The table and
-- its grants, who may suggest, read and decide, the input rule, the bound
-- to the live state, the single decision, the submitted work, that nothing
-- of it enters the evidence of the work, and the retention delete. Personas
-- of institution.inc and evidence-acceptance.inc, all invented: Ana writes
-- doc-a in Vesna's course K1 (fak-a), Dora is another student of K1, Marko
-- teaches K2, Tomo writes doc-b in fak-b.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Ana's document has revisions up to 10, as in 259.
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'doc-a', pg_temp.id('fak_a'), n, n - 1, pg_temp.id('ana'), pg_temp.h('a') FROM generate_series(1, 10) AS n;
UPDATE evidence.document SET current_revision = 10 WHERE id = 'doc-a';
RESET ROLE;

-- The live state of the two works, as the students publish it (the database
-- keeps the bytes; the document rule is the edge's).
INSERT INTO ref VALUES
  ('body-a', '{"nodes":[],"schemaVersion":1,"synthetic":"izmisljeni tekst A"}'),
  ('body-b', '{"nodes":[],"schemaVersion":1,"synthetic":"izmisljeni tekst B"}'),
  ('anchor', '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}');
SELECT is(split_part(pg_temp.ask('ana', $$ SELECT outcome FROM collaboration.publish_live_state('doc-a', NULL, {body-a}) $$), '|', 1),
  'accepted', 'fixture: Ana publishes her live state');
SELECT is(split_part(pg_temp.ask('tomo', $$ SELECT outcome FROM collaboration.publish_live_state('doc-b', NULL, {body-b}) $$), '|', 1),
  'accepted', 'fixture: Tomo publishes his live state');
INSERT INTO ref SELECT 'hash-a', content_hash FROM collaboration.live_state WHERE document_id = 'doc-a';
INSERT INTO ref SELECT 'hash-b', content_hash FROM collaboration.live_state WHERE document_id = 'doc-b';

-- Everything the evidence schema holds and the live state, as one value.
CREATE FUNCTION pg_temp.evidence_print() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
    SELECT 'd' || row_to_json(x)::text FROM evidence.document x UNION ALL
    SELECT 'r' || row_to_json(x)::text FROM evidence.document_revision x UNION ALL
    SELECT 'p' || row_to_json(x)::text FROM evidence.package x UNION ALL
    SELECT 's' || row_to_json(x)::text FROM evidence.segment x UNION ALL
    SELECT 'c' || row_to_json(x)::text FROM evidence.receipt x UNION ALL
    SELECT 'l' || row_to_json(x)::text FROM collaboration.live_state x
  ) AS t (r)
$$;
CREATE TEMP TABLE print_before AS SELECT pg_temp.evidence_print() AS v;

-- A suggestion as one line: its id, or the error.
CREATE FUNCTION pg_temp.suggest(p_actor text, p_document text, p_text text, p_hash text DEFAULT NULL,
  p_anchor text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT collaboration.create_suggestion(%L, %L::jsonb, %L, %L)::text',
    p_document, coalesce(p_anchor, (SELECT val FROM ref WHERE name = 'anchor')), p_text,
    coalesce(p_hash, (SELECT val FROM ref WHERE name = 'hash-a'))))
$$;
CREATE FUNCTION pg_temp.decide(p_actor text, p_id text, p_action text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT concat_ws('|', document_id, text, live_hash IS NOT NULL, live_body IS NOT NULL)
          FROM collaboration.decide_suggestion(%L::uuid, %L) $q$, p_id, p_action))
$$;
CREATE FUNCTION pg_temp.listed(p_actor text, p_document text DEFAULT 'doc-a') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(string_agg(concat_ws('|', text, state, is_own, base_hash = {hash-a},
          created_window IS NOT NULL, decided_window IS NOT NULL), ';' ORDER BY n), 'none')
          FROM collaboration.list_suggestions(%L) WITH ORDINALITY AS l(suggestion_id, anchor, text, state, is_own,
            base_hash, created_window, decided_window, n) $q$, p_document))
$$;
CREATE FUNCTION pg_temp.stored() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(concat_ws('|', text, state), ';' ORDER BY seq), 'none')
    FROM collaboration.suggestion WHERE document_id = 'doc-a'
$$;

-- 1. Catalogue: forced RLS, only the owner's policy, no runtime grant; the
-- three definer RPCs only for the application.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND ARRAY(SELECT p.policyname::text FROM pg_policies p
      WHERE p.schemaname = 'collaboration' AND p.tablename = 'suggestion'
        AND p.roles = ARRAY['ductus_identity'::name] AND p.cmd = 'ALL') = ARRAY['suggestion_owner']
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND r.rolname <> 'ductus_identity'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'suggestion has forced RLS, only the identity owner has access and no runtime role has a grant')
  FROM pg_class c WHERE c.oid = to_regclass('collaboration.suggestion');
SELECT ok(p.prosecdef AND p.proowner = 'ductus_identity'::regrole AND 'search_path=""' = ANY(p.proconfig)
    AND has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_retention', p.oid, 'EXECUTE'),
  format('%s is a definer RPC with an empty path, only for the application', p.oid::regprocedure))
  FROM pg_proc p WHERE p.oid IN ('collaboration.create_suggestion(text,jsonb,text,text)'::regprocedure,
    'collaboration.list_suggestions(text)'::regprocedure, 'collaboration.decide_suggestion(uuid,text)'::regprocedure);
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT throws_ok($$ SET LOCAL ROLE ductus_app; INSERT INTO collaboration.suggestion
    (institution_id, assignment_id, owner_id, author_id, document_id, anchor, text, base_hash)
    VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'doc-a', '{}', 'x', repeat('a', 64)) $$,
  '42501', NULL, 'the application cannot write a suggestion directly');
RESET ROLE;
SELECT throws_ok($$ SET LOCAL ROLE ductus_app; SELECT count(*) FROM collaboration.suggestion $$,
  '42501', NULL, 'the application cannot read suggestions directly');
RESET ROLE;

-- 2. Who creates: only a teacher of the work; the owner 403, everybody else 404.
SELECT is(pg_temp.suggest('ana', 'doc-a', 'drugi odlomak'), 'ZD403: forbidden', 'the student owner cannot suggest');
SELECT is(pg_temp.suggest(p.actor, p.doc, 'drugi odlomak', p.hash), 'ZD404: not found', p.why)
  FROM (VALUES ('dora', 'doc-a', NULL, 'another student of the course reads the work as missing'),
               ('marko', 'doc-a', NULL, 'a teacher of another course reads the work as missing'),
               ('tomo', 'doc-a', NULL, 'a student of another institution reads the work as missing'),
               ('vesna', 'doc-b', (SELECT val FROM ref WHERE name = 'hash-b'), 'a work of another institution reads as missing'),
               ('vesna', 'doc-nema', NULL, 'a work that does not exist is not found'),
               ('vesna', '', NULL, 'an empty id is not found')) p(actor, doc, hash, why);
SELECT is(pg_temp.stored(), 'none', 'no refused create wrote anything');

-- 3. The input rule: as isSuggestionInput.
SELECT is(pg_temp.suggest('vesna', 'doc-a', m.text), 'ZD422: invalid input', m.why)
  FROM (VALUES ('prvi odlomak', 'a text equal to the quote changes nothing'),
               (repeat('a', 2001), 'a text above 2000 characters'),
               (E'a\nb', 'a line break (a paragraph holds none)'),
               (E'a\u0007b', 'a control character'),
               (E'a\u0085b', 'a C1 control character'),
               (E'a‮b', 'a bidi override'),
               (E'é', 'a text that is not NFC'),
               (NULL, 'no text')) m(text, why);
SELECT is(pg_temp.suggest('vesna', 'doc-a', 'drugi odlomak', NULL, a.anchor), 'ZD422: invalid input', a.why)
  FROM (VALUES ('{}', 'an empty anchor'),
               ('{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":"","startHint":0,"endHint":12,"x":1}', 'an anchor with an unknown field'),
               ('{"nodeId":"nije-uuid","quote":"prvi odlomak","prefix":"","suffix":"","startHint":0,"endHint":12}', 'an anchor without a node id'),
               ('null', 'a null anchor')) a(anchor, why);
SELECT is(pg_temp.suggest('vesna', 'doc-a', 'drugi odlomak', h.hash), 'ZD422: invalid input', h.why)
  FROM (VALUES ('nije-hash', 'a base hash that is not 64 hex'), (upper(repeat('a', 64)), 'an uppercase base hash')) h(hash, why);
SELECT is(pg_temp.stored(), 'none', 'no invalid suggestion wrote anything');

-- 4. Bound to the live state: a state that moved on is a conflict.
SELECT is(pg_temp.suggest('vesna', 'doc-a', 'drugi odlomak', repeat('0', 64)), 'ZD409: conflict',
  'a suggestion on a state that is not the current one is a conflict');
SELECT is(pg_temp.stored(), 'none', 'and writes nothing');

-- 5. The teacher suggests; both sides read the same rows.
INSERT INTO ref SELECT 's1', pg_temp.suggest('vesna', 'doc-a', 'drugi odlomak');
INSERT INTO ref SELECT 's2', pg_temp.suggest('vesna', 'doc-a', '');
INSERT INTO ref SELECT 's3', pg_temp.suggest('vesna', 'doc-a', 'treći odlomak');
SELECT ok((SELECT val FROM ref WHERE name = 's1') ~ '^[0-9a-f-]{36}$', 'the teacher of the work suggests a text');
SELECT ok((SELECT val FROM ref WHERE name = 's2') ~ '^[0-9a-f-]{36}$', 'an empty text (removing the quote) is a suggestion');
SELECT is(pg_temp.listed('vesna'),
  'drugi odlomak|pending|t|t|t|f;|pending|t|t|t|f;treći odlomak|pending|t|t|t|f',
  'the teacher reads her suggestions, oldest first, pending, bound to the state');
SELECT is(pg_temp.listed('ana'),
  'drugi odlomak|pending|f|t|t|f;|pending|f|t|t|f;treći odlomak|pending|f|t|t|f',
  'the student owner reads the same rows, none her own');
SELECT is((SELECT count(*)::int FROM collaboration.suggestion WHERE document_id = 'doc-a'
             AND owner_id = pg_temp.id('ana') AND author_id = pg_temp.id('vesna')
             AND assignment_id = pg_temp.id('z1') AND institution_id = pg_temp.id('fak_a')),
  3, 'every suggestion carries the scope of the work and its author');
SELECT is(pg_temp.listed(p.actor, p.doc), 'ZD404: not found', p.why)
  FROM (VALUES ('dora', 'doc-a', 'another student of the course cannot list'),
               ('marko', 'doc-a', 'a teacher of another course cannot list'),
               ('tomo', 'doc-a', 'a student of another institution cannot list'),
               ('vesna', 'doc-b', 'a work of another institution cannot be listed'),
               ('ana', 'doc-nema', 'a work that does not exist cannot be listed')) p(actor, doc, why);
SELECT is(pg_temp.listed('tomo', 'doc-b'), 'none', 'a work without suggestions lists none');

-- 6. Who decides: only the student owner; the teacher 403, everybody else 404.
SELECT is(pg_temp.decide('vesna', (SELECT val FROM ref WHERE name = 's1'), 'accept'), 'ZD403: forbidden',
  'the teacher of the work cannot accept');
SELECT is(pg_temp.decide('vesna', (SELECT val FROM ref WHERE name = 's1'), 'reject'), 'ZD403: forbidden',
  'the teacher of the work cannot reject');
SELECT is(pg_temp.decide(p.actor, coalesce(p.id, (SELECT val FROM ref WHERE name = 's1')), 'accept'), 'ZD404: not found', p.why)
  FROM (VALUES ('dora', NULL, 'another student of the course reads the suggestion as missing'),
               ('marko', NULL, 'a teacher of another course reads the suggestion as missing'),
               ('tomo', NULL, 'a student of another institution reads the suggestion as missing'),
               ('ana', '00000000-0000-4000-8000-00000000abcd', 'a suggestion that does not exist is not found')) p(actor, id, why);
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's1'), a.action), 'ZD422: invalid input', a.why)
  FROM (VALUES ('withdraw', 'an unknown decision'), ('', 'an empty decision'), (NULL, 'no decision')) a(action, why);
SELECT is(pg_temp.stored(), 'drugi odlomak|pending;|pending;treći odlomak|pending', 'no refused decision changed anything');

-- 7. One decision each: accept answers the live state, reject none; a second is refused.
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's1'), 'accept'), 'doc-a|drugi odlomak|t|t',
  'the owner accepts and receives the live state the suggestion applies to');
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's1'), 'accept'), 'ZD409: not allowed',
  'an accepted suggestion is not accepted twice');
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's1'), 'reject'), 'ZD409: not allowed',
  'an accepted suggestion is not rejected afterwards');
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's2'), 'reject'), 'doc-a||f|f',
  'the owner rejects; a rejection carries no state');
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's2'), 'accept'), 'ZD409: not allowed',
  'a rejected suggestion is not accepted afterwards');
SELECT is(pg_temp.listed('vesna'),
  'drugi odlomak|accepted|t|t|t|t;|rejected|t|t|t|t;treći odlomak|pending|t|t|t|f',
  'the teacher reads the decisions with their window');

-- 8. Nothing of it entered the evidence of the work or its live state.
SELECT is(pg_temp.evidence_print(), (SELECT v FROM print_before),
  'suggestions and decisions changed neither the evidence nor the live state of the work');

-- 9. A submitted work: no new suggestion, no decision.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 10, repeat('a', 64), repeat('d', 64),
  repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 11');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 11) $$), 'requested', 'fixture: Ana requests revision 11');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
    (SELECT id FROM evidence.submission_request WHERE document_id = 'doc-a'), pg_temp.h('d'))), 'recorded',
  'fixture: the submission is recorded');
SELECT is(pg_temp.suggest('vesna', 'doc-a', 'četvrti odlomak'), 'ZD409: not allowed', 'a submitted work takes no suggestion');
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's3'), 'accept'), 'ZD409: not allowed',
  'a suggestion on a submitted work is not accepted');
SELECT is(pg_temp.decide('ana', (SELECT val FROM ref WHERE name = 's3'), 'reject'), 'ZD409: not allowed',
  'nor rejected');
SELECT is(pg_temp.decide('vesna', (SELECT val FROM ref WHERE name = 's3'), 'accept'), 'ZD403: forbidden',
  'the teacher is still refused first');

-- 10. The retention delete removes the suggestions with the other records.
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_revision_requests('doc-a', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is(pg_temp.stored(), 'none', 'the retention delete removes the suggestions of the work');

SELECT * FROM finish();
ROLLBACK;
