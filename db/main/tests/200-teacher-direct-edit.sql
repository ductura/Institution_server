-- SRV-1702 (M6.4, DAN-420; D-21, D-34, D-244; Ductus docs/backend/suradnja.md
-- 4.15): direct edits of a teacher (20261129100100). Acceptance: (1) without
-- the setting on a teacher's edit fails; (2) revocation acts at once; (3) the
-- edit is marked as the teacher's in the record of the process; (4) the
-- setting is visible on the work, the same for both sides. Plus the access
-- matrix: only the student owner sets the mode; only a teacher of the work
-- edits; nobody else reads or writes; no direct privilege; the record is
-- append only; nothing touches schema evidence; everything goes with the work.
-- Every person, document and text below is invented; the documents are those
-- of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Marko teaches K1 too, from before Ana's work: a second teacher of the work.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');

CREATE FUNCTION pg_temp.schema_print(p_schema text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  t text;
  part text;
  acc text := '';
BEGIN
  FOR t IN SELECT relname FROM pg_class WHERE relnamespace = p_schema::regnamespace AND relkind IN ('r', 'p') ORDER BY relname LOOP
    EXECUTE format('SELECT string_agg(row_to_json(x)::text, ''|'' ORDER BY row_to_json(x)::text) FROM %I.%I x', p_schema, t) INTO part;
    acc := acc || t || ':' || coalesce(part, '') || ';';
  END LOOP;
  RETURN md5(acc);
END
$$;
CREATE TEMP TABLE print_before AS SELECT pg_temp.schema_print('evidence') AS evidence;

-- Three invented states of Ana's work: S1 she publishes, S2 a teacher's edit, S3 another.
CREATE TEMP TABLE body (name text PRIMARY KEY, val text NOT NULL);
INSERT INTO body VALUES
  ('s1', '{"nodes":[{"text":"Izmišljeni tekst rada."}],"schemaVersion":1}'),
  ('s2', '{"nodes":[{"text":"Izmišljeni tekst rada, s ispravkom."}],"schemaVersion":1}'),
  ('s3', '{"nodes":[{"text":"Izmišljeni tekst rada, s drugom ispravkom."}],"schemaVersion":1}');
GRANT SELECT ON body TO PUBLIC;
CREATE FUNCTION pg_temp.b(p_name text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT val FROM body WHERE name = p_name $$;
CREATE FUNCTION pg_temp.edit(p_actor text, p_expected text, p_body text, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM collaboration.publish_teacher_direct_edit(%L, %L, %L)', p_document, p_expected, p_body))
$$;
CREATE FUNCTION pg_temp.set_mode(p_actor text, p_mode text, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT outcome FROM collaboration.set_direct_edit(%L, %L)', p_document, p_mode))
$$;
CREATE FUNCTION pg_temp.mode_of(p_actor text, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT mode FROM collaboration.read_direct_edit(%L)', p_document))
$$;

-- 1. Catalogue: owner, forced RLS, one owner policy each, no direct privilege.
SELECT bag_eq(
  $$ SELECT relname::text FROM pg_class WHERE relnamespace = 'collaboration'::regnamespace AND relkind = 'r'
      AND relname IN ('direct_edit_setting', 'direct_edit_setting_change', 'teacher_edit')
      AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('direct_edit_setting'), ('direct_edit_setting_change'), ('teacher_edit') $$,
  'the identity role owns the three tables and RLS is forced on each');
SELECT bag_eq(
  $$ SELECT tablename::text, policyname::text, roles::text, cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename IN ('direct_edit_setting', 'direct_edit_setting_change', 'teacher_edit') $$,
  $$ VALUES ('direct_edit_setting', 'direct_edit_setting_owner', '{ductus_identity}', 'ALL'),
            ('direct_edit_setting_change', 'direct_edit_setting_change_owner', '{ductus_identity}', 'ALL'),
            ('teacher_edit', 'teacher_edit_owner', '{ductus_identity}', 'ALL') $$,
  'each table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || t || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.direct_edit_setting', 'collaboration.direct_edit_setting_change', 'collaboration.teacher_edit']) AS t
      WHERE has_table_privilege(r, t, p) $$,
  'no runtime role reads or writes the setting, its history or a teacher edit directly');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_sequence_privilege(r, 'collaboration.direct_edit_seq', 'USAGE,SELECT,UPDATE') $$,
  'no runtime role touches the sequence of the record');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.set_direct_edit(text,text)'::regprocedure,
        'collaboration.read_direct_edit(text)'::regprocedure,
        'collaboration.list_direct_edit_record(text)'::regprocedure,
        'collaboration.publish_teacher_direct_edit(text,text,text)'::regprocedure,
        'collaboration.delete_direct_edit(text,uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the five functions are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.set_direct_edit(text,text)', 'collaboration.read_direct_edit(text)',
        'collaboration.list_direct_edit_record(text)', 'collaboration.publish_teacher_direct_edit(text,text,text)',
        'collaboration.delete_direct_edit(text,uuid)', 'collaboration.refuse_direct_edit_rewrite()']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.set_direct_edit(text,text)'),
            ('ductus_app collaboration.read_direct_edit(text)'),
            ('ductus_app collaboration.list_direct_edit_record(text)'),
            ('ductus_app collaboration.publish_teacher_direct_edit(text,text,text)'),
            ('ductus_retention collaboration.delete_direct_edit(text,uuid)') $$,
  'the web role sets, reads and edits; the retention role alone deletes');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT is(pg_get_function_arguments('collaboration.set_direct_edit(text,text)'::regprocedure),
  'p_document_id text, p_mode text',
  'the setting takes no actor, owner or institution: they come from the session and the document');
SELECT is(pg_get_function_arguments('collaboration.publish_teacher_direct_edit(text,text,text)'::regprocedure),
  'p_document_id text, p_expected_hash text, p_body text',
  'a teacher edit takes no author, mode or source: the session, the setting under lock and the function decide');

-- 4. Visible on the work: suggestions by default, the same for both sides.
SELECT is(pg_temp.mode_of(a.name), 'suggestions', a.name || ' sees suggestions, the default, on Ana''s work')
FROM (VALUES ('ana'), ('vesna'), ('marko')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(changed_at::text, 'never') FROM collaboration.read_direct_edit('doc-a') $$), 'never',
  'a work whose mode never changed has no time of change');
SELECT is(pg_temp.mode_of(a.name), 'ZD403: forbidden', a.name || ' does not see the setting of Ana''s work')
FROM (VALUES ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT matches(pg_temp.mode_of('anon'), '^ZD401', 'reading the setting needs a session');
SELECT is(pg_temp.mode_of('vesna', 'doc-nema'), 'ZD403: forbidden', 'a missing work reads as a forbidden one');

-- Ana publishes the first live state of her work.
SELECT is(pg_temp.ask('ana', format($$ SELECT outcome FROM collaboration.publish_live_state('doc-a', NULL, %L) $$, pg_temp.b('s1'))),
  'accepted', 'Ana publishes the first live state of her work');

-- 1. Without the setting on, a teacher's edit fails and writes nothing.
SELECT is(pg_temp.edit('vesna', pg_temp.sha(pg_temp.b('s1')), pg_temp.b('s2')), 'ZD403: forbidden',
  'with suggestions (the default) Vesna''s direct edit is refused');
SELECT is((SELECT content_hash FROM collaboration.live_state WHERE document_id = 'doc-a'), pg_temp.sha(pg_temp.b('s1')),
  'the refused edit left the live state as Ana published it');
SELECT is((SELECT count(*) FROM collaboration.teacher_edit), 0::bigint, 'and recorded no teacher edit');

-- Only the student owner sets the mode.
SELECT is(pg_temp.set_mode(a.name, 'direct'), 'ZD403: forbidden', a.name || ' cannot turn direct edits on for Ana''s work')
FROM (VALUES ('vesna'), ('marko'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT matches(pg_temp.set_mode(t.name, 'direct'), '^ZD401', 'setting the mode with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.set_mode('ana', 'direct', 'doc-nema'), 'ZD403: forbidden', 'a missing work is a forbidden one');
SELECT is(pg_temp.set_mode('ana', m.val), 'ZD422: invalid input', 'the mode ' || m.why || ' is refused')
FROM (VALUES (NULL, 'missing'), ('', 'empty'), ('Direct', 'in another case'), (' direct', 'with a blank'),
             ('on', 'unknown')) AS m (val, why);
SELECT is((SELECT count(*) FROM collaboration.direct_edit_setting_change), 0::bigint, 'no refused change wrote the history');

-- Ana turns direct edits on: visible to both sides at once.
SELECT is(pg_temp.set_mode('ana', 'direct'), 'applied', 'Ana turns direct edits on');
SELECT is(pg_temp.set_mode('ana', 'direct'), 'unchanged', 'the same request again changes nothing');
SELECT is(pg_temp.mode_of(a.name), 'direct', a.name || ' sees direct edits on')
FROM (VALUES ('ana'), ('vesna'), ('marko')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT changed_at FROM collaboration.read_direct_edit('doc-a') $$),
          pg_temp.ask('vesna', $$ SELECT changed_at FROM collaboration.read_direct_edit('doc-a') $$),
  'the student and the teacher read the same time of change');
SELECT is(pg_temp.ask('ana', $$ SELECT extract(epoch FROM changed_at)::bigint % 300 FROM collaboration.read_direct_edit('doc-a') $$), '0',
  'the time is rounded to the 5-minute window of P-03');

-- Now a teacher of the work edits; others still cannot.
SELECT is(pg_temp.edit('vesna', pg_temp.sha(pg_temp.b('s1')), pg_temp.b('s2')), 'accepted',
  'with direct edits on, Vesna''s edit of the state she read is accepted');
SELECT is((SELECT body FROM collaboration.live_state WHERE document_id = 'doc-a'), pg_temp.b('s2'),
  'the live state is Vesna''s edit, for Ana''s client to apply');
SELECT is(pg_temp.edit('vesna', pg_temp.sha(pg_temp.b('s2')), pg_temp.b('s2')), 'unchanged',
  'the same body again is unchanged');
SELECT is(pg_temp.edit('marko', pg_temp.sha(pg_temp.b('s1')), pg_temp.b('s3')), 'conflict',
  'an edit of a state that is no longer the live one is a conflict');
SELECT is(pg_temp.ask('marko', format($$ SELECT coalesce(write_token::text, 'none') FROM collaboration.publish_teacher_direct_edit('doc-a', %L, %L) $$,
          pg_temp.sha(pg_temp.b('s1')), pg_temp.b('s3'))), 'none',
  'a conflict never tells the teacher the student''s write token');
SELECT is(pg_temp.edit(a.name, pg_temp.sha(pg_temp.b('s2')), pg_temp.b('s3')), 'ZD403: forbidden',
  a.name || ' cannot edit Ana''s work')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT matches(pg_temp.edit('anon', pg_temp.sha(pg_temp.b('s2')), pg_temp.b('s3')), '^ZD401', 'an edit needs a session');
SELECT is(pg_temp.edit('vesna', e.expected, e.body), 'ZD422: invalid input', 'an edit ' || e.why || ' is refused')
FROM (VALUES (NULL, pg_temp.b('s3'), 'without the hash read'), ('nije-hash', pg_temp.b('s3'), 'with a malformed hash'),
             (upper(pg_temp.sha(pg_temp.b('s2'))), pg_temp.b('s3'), 'with an upper-case hash'),
             (pg_temp.sha(pg_temp.b('s2')), NULL, 'without a body'), (pg_temp.sha(pg_temp.b('s2')), '', 'with an empty body'),
             (pg_temp.sha(pg_temp.b('s2')), repeat('x', 2097153), 'over 2 MiB')) AS e (expected, body, why);
SELECT is(pg_temp.edit('marko', pg_temp.sha(pg_temp.b('s2')), pg_temp.b('s3')), 'accepted',
  'the second teacher of the work edits the current state');
-- The student's own next write after a teacher edit is a conflict on her old token, as 4.12 answers it.
SELECT is(pg_temp.ask('ana', format($$ SELECT outcome FROM collaboration.publish_live_state('doc-a', gen_random_uuid(), %L) $$, pg_temp.b('s1'))),
  'conflict', 'Ana''s client, writing on its old token, learns of the teacher edit by a conflict');

-- A teacher never creates the first state of a work.
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.direct_edit_setting (document_id, institution_id, assignment_id, owner_id, mode, changed_at)
VALUES ('doc-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'), 'direct', now());
RESET ROLE;
SELECT is(pg_temp.edit('petra', pg_temp.sha(pg_temp.b('s1')), pg_temp.b('s2'), 'doc-b'), 'conflict',
  'with nothing published a teacher edit is a conflict and writes nothing');
SELECT is((SELECT count(*) FROM collaboration.live_state WHERE document_id = 'doc-b'), 0::bigint, 'no live state was created');

-- 3. The record of the process marks each edit as the teacher's.
SELECT row_eq(
  $$ SELECT institution_id, assignment_id, owner_id, author_id, source, mode, previous_hash, content_hash, body_bytes
      FROM collaboration.teacher_edit WHERE document_id = 'doc-a' ORDER BY seq LIMIT 1 $$,
  ROW(pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'teacher'::text, 'direct'::text,
      pg_temp.sha(pg_temp.b('s1')), pg_temp.sha(pg_temp.b('s2')), octet_length(pg_temp.b('s2'))),
  'Vesna''s edit is recorded with source teacher, her as author from the session, the states before and after and its size');
SELECT is((SELECT string_agg(p.name, ',' ORDER BY e.seq) FROM collaboration.teacher_edit e JOIN person p ON p.id = e.author_id),
  'vesna,marko', 'each accepted edit is attributed to the teacher who made it; unchanged, conflicts and refusals record nothing');
SELECT is(pg_temp.ask(a.name, $$ SELECT string_agg(kind || ':' || source || ':' || coalesce(mode, '-') || ':' || coalesce(body_bytes::text, '-'), ' / ' ORDER BY ord)
      FROM collaboration.list_direct_edit_record('doc-a') WITH ORDINALITY AS r (kind, source, mode, body_bytes, at, ord) $$),
  format('mode:student:direct:- / teacher_edit:teacher:-:%s / teacher_edit:teacher:-:%s',
         octet_length(pg_temp.b('s2')), octet_length(pg_temp.b('s3'))),
  a.name || ' reads the same record: the student turned direct edits on, then two edits marked as the teacher''s')
FROM (VALUES ('ana'), ('vesna'), ('marko')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_direct_edit_record('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads nothing of the record of Ana''s work')
FROM (VALUES ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_direct_edit_record('doc-a') WHERE extract(epoch FROM at)::bigint % 300 <> 0 $$), '0',
  'every time of the record is in the 5-minute window of P-03');

-- 2. Revocation acts at once: the very next teacher edit is refused.
SELECT is(pg_temp.set_mode('ana', 'suggestions'), 'applied', 'Ana revokes direct edits, without asking anyone');
SELECT is(pg_temp.mode_of('vesna'), 'suggestions', 'Vesna sees the revocation at once');
SELECT is(pg_temp.edit('vesna', pg_temp.sha(pg_temp.b('s3')), pg_temp.b('s2')), 'ZD403: forbidden',
  'right after the revocation Vesna''s edit is refused');
SELECT is((SELECT content_hash FROM collaboration.live_state WHERE document_id = 'doc-a'), pg_temp.sha(pg_temp.b('s3')),
  'and the live state is untouched');
-- Turning it on again does not act backwards: the edit refused above stays refused.
SELECT is(pg_temp.set_mode('ana', 'direct'), 'applied', 'Ana turns direct edits on again');
SELECT is((SELECT count(*) FROM collaboration.teacher_edit WHERE document_id = 'doc-a'), 2::bigint,
  'turning them on again records nothing for the edit refused while they were off');
SELECT is((SELECT string_agg(c.mode || ':' || p.name, ',' ORDER BY c.seq) FROM collaboration.direct_edit_setting_change c JOIN person p ON p.id = c.actor_id),
  'direct:ana,suggestions:ana,direct:ana', 'the history keeps every change with its author, never summed up');

-- Append only: no row of the history or of a teacher edit is rewritten, not even by the owner.
CREATE FUNCTION pg_temp.rewrite(p_table text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  SET LOCAL ROLE ductus_identity;
  EXECUTE format('UPDATE collaboration.%I SET institution_id = institution_id', p_table);
  RESET ROLE;
  RETURN 'rewritten';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN SQLSTATE;
END
$f$;
SELECT is(pg_temp.rewrite('direct_edit_setting_change'), 'ZD409', 'the history of the setting is append only');
SELECT is(pg_temp.rewrite('teacher_edit'), 'ZD409', 'a teacher edit is append only');

-- A teacher who leaves the course loses the work at once.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.edit('vesna', pg_temp.sha(pg_temp.b('s3')), pg_temp.b('s2')), 'ZD403: forbidden',
  'Vesna, no longer a teacher of K1, cannot edit');
SELECT is(pg_temp.mode_of('vesna'), 'ZD403: forbidden', 'nor read the setting');

-- After the submission nothing is written: neither an edit nor a change of the mode.
CREATE OR REPLACE FUNCTION app.document_submitted(p_document_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT p_document_id = 'doc-a' $$;
SELECT is(pg_temp.edit('marko', pg_temp.sha(pg_temp.b('s3')), pg_temp.b('s2')), 'ZD403: forbidden',
  'a submitted work takes no teacher edit');
SELECT is(pg_temp.set_mode('ana', 'suggestions'), 'ZD403: forbidden', 'nor a change of the mode');
SELECT is(pg_temp.mode_of('marko'), 'direct', 'the setting stays readable');

-- Nothing written in the evidence schema: the student stays the one writer (D-34).
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before),
  'no setting or teacher edit wrote anything in the evidence schema');

-- Everything goes with the work, only through the retention role.
SELECT matches(pg_temp.ask('ana', $$ SELECT collaboration.delete_direct_edit('doc-a', {fak_a}) $$), '^42501',
  'the web role cannot call the retention delete');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_direct_edit('doc-a', pg_temp.id('fak_b'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.teacher_edit WHERE document_id = 'doc-a'), 2::bigint,
  'a delete with another institution leaves the work alone');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_direct_edit('doc-a', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.teacher_edit WHERE document_id = 'doc-a')
        + (SELECT count(*) FROM collaboration.direct_edit_setting WHERE document_id = 'doc-a')
        + (SELECT count(*) FROM collaboration.direct_edit_setting_change WHERE document_id = 'doc-a'), 0::bigint,
  'after the retention delete no setting, history or teacher edit of the work is left');

SELECT * FROM finish();
ROLLBACK;
