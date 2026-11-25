-- SRV-KARTA-RASPON (Ductus#2055; P-1, NF-5 PG-2): the ranges of origin of a
-- revision of a work (20261218100000). The access matrix: the student owner
-- records the ranges of a saved revision once and reads them; a reader of the
-- work reads the same answer and writes nothing; the rest (another student, a
-- teacher of another course, another institution, an unknown document, no
-- session) get ZD403 or ZD401. Ranges hold a block, a range of code points, a
-- kind and an optional segmentRef: no text, no key, no time of typing. All
-- people and texts are the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Saved revisions 1 to 3 of Ana's work (stand-in hashes).
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'doc-a', pg_temp.id('fak_a'), r, r - 1, pg_temp.id('ana'), pg_temp.h(chr(100 + r)) FROM generate_series(1, 3) r;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;

CREATE FUNCTION pg_temp.seg(p_block text, p_start integer, p_end integer, p_kind text, p_extra jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('blockId', p_block, 'start', p_start, 'end', p_end, 'kind', p_kind) || p_extra
$$;
CREATE FUNCTION pg_temp.record(p_actor text, p_revision bigint, p_segments jsonb, p_doc text DEFAULT 'doc-a')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.work_origin_segments_record(%L, %s, %L::jsonb)', p_doc, p_revision, p_segments))
$$;
CREATE FUNCTION pg_temp.read(p_actor text, p_revision text DEFAULT 'NULL', p_doc text DEFAULT 'doc-a')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT coalesce(string_agg(concat_ws(':', revision, block_id, start_at, end_at, kind,
      coalesce(segment_ref, '-')), ',' ), '-') FROM app.work_origin_segments(%L, %s) $q$, p_doc, p_revision))
$$;
CREATE TEMP TABLE b (a text, c text);
INSERT INTO b VALUES ('1b0c2d3e-4f50-4a61-8b72-0c1d2e3f4a51', '2c1d0e9f-8a7b-4c6d-9e5f-1a2b3c4d5e62');
GRANT SELECT ON b TO PUBLIC;

-- 1. Catalogue: one table, forced RLS, the owner's only policy, no other privilege.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_evidence'::regrole
    AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolcanlogin AND r.rolname <> 'ductus_evidence'
        AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
    AND NOT has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'origin_segment has forced RLS, the evidence owner and no privilege for another role')
FROM pg_class c WHERE c.oid = 'evidence.origin_segment'::regclass;
SELECT bag_eq(
  $$ SELECT policyname::text FROM pg_policies WHERE schemaname = 'evidence' AND tablename = 'origin_segment' $$,
  ARRAY['origin_segment_owner'], 'only the owner''s policy');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.work_origin_segments_record(text,bigint,jsonb)',
       'app.work_origin_segments(text,bigint)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_evidence')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.origin_segments_add(text,bigint,uuid,uuid,jsonb)',
       'app.origin_segments_of(text,bigint,uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the workers belong to the evidence and identity roles only');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE') AND NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'after the migration no role keeps CREATE on the schema');
SELECT bag_eq(
  $$ SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'evidence' AND table_name = 'origin_segment' $$,
  ARRAY['document_id', 'institution_id', 'revision', 'ord', 'block_id', 'start_at', 'end_at', 'kind', 'change_id',
        'segment_ref', 'recorded_at'],
  'a range has a place, a kind and its bookkeeping; no column could hold a text, a key or a measure');

-- 2. Nothing recorded: no revision, no ranges, for the owner and a reader.
SELECT is(pg_temp.read('ana'), '-', 'Ana reads no ranges while none is recorded');
SELECT is(pg_temp.read('vesna'), '-', 'the teacher reads none either');

-- 3. The owner records the ranges of revision 2; once only.
CREATE TEMP TABLE chg AS SELECT pg_temp.ask('ana', $$ SELECT app.work_origin_record('doc-a', 'pasted_unknown', 30) $$) AS id;
GRANT SELECT ON chg TO PUBLIC;
SELECT is(pg_temp.record('ana', 2, jsonb_build_array(
    pg_temp.seg((SELECT a FROM b), 0, 40, 'typed'),
    pg_temp.seg((SELECT a FROM b), 40, 120, 'assistant_match', '{"segmentRef": "odlomak-1"}'),
    pg_temp.seg((SELECT c FROM b), 0, 30, 'pasted_unknown', jsonb_build_object('changeId', (SELECT id FROM chg))),
    pg_temp.seg((SELECT c FROM b), 30, 50, 'imported_file'))),
  '4', 'Ana records four ranges of revision 2');
SELECT is(pg_temp.record('ana', 2, jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 1, 'typed'))),
  'ZD409: already recorded', 'the ranges of a revision are recorded once');
SELECT is(pg_temp.record('ana', 1, jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 12, 'imported_file'))),
  '1', 'and revision 1 has its own');

-- 4. Reading: the latest at or below the revision asked; the same for the owner and the reader.
SELECT is(pg_temp.read('ana'),
  format('2:%1$s:0:40:typed:-,2:%1$s:40:120:assistant_match:odlomak-1,2:%2$s:0:30:pasted_unknown:-,2:%2$s:30:50:imported_file:-',
         (SELECT a FROM b), (SELECT c FROM b)),
  'Ana reads the latest recorded revision, in the order recorded');
SELECT is(pg_temp.read('vesna'), pg_temp.read('ana'), 'the teacher reads the same answer');
SELECT is(pg_temp.read('vesna', '3'), pg_temp.read('ana'), 'revision 3 has none of its own and reads revision 2');
SELECT is(pg_temp.read('ana', '1'), format('1:%s:0:12:imported_file:-', (SELECT a FROM b)), 'revision 1 reads its own');
SELECT is(pg_temp.read('ana', '0'), '-', 'below every recorded revision there is none');
SELECT matches(pg_temp.read('ana', '-1'), '^ZD422', 'a negative revision is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(block_id || ':' || start_at || '-' || end_at, ',')
    FROM app.work_origin_segments('doc-a', NULL) WHERE segment_ref = 'odlomak-1' $$),
  (SELECT a FROM b) || ':40-120', 'the segmentRef of a finding resolves to its range');

-- 5. An explained paste reads pasted_known, as in the composition.
SELECT is(pg_temp.ask('ana', format($$ SELECT app.work_origin_explain('doc-a', %L) $$, (SELECT id FROM chg))), 'true',
  'Ana explains the paste');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(kind, ',') FROM app.work_origin_segments('doc-a', 2) WHERE start_at = 0 $$),
  'typed,pasted_known', 'the range of the explained paste reads pasted_known');

-- 6. Who else: nothing but ZD403 (ZD401 without a session).
SELECT matches(pg_temp.read(a.name), '^ZD403', a.name || ' does not read the ranges of Ana''s work')
FROM (VALUES ('dora'), ('boris'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.read('vesna', 'NULL', 'doc-nema'), '^ZD403', 'an unknown document: ZD403');
SELECT matches(pg_temp.read('vesna', 'NULL', 'doc-b'), '^ZD403', 'another institution''s document: ZD403');
SELECT matches(pg_temp.record(a.name, 3, jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed'))), '^ZD403',
  a.name || ' records no ranges of Ana''s work')
FROM (VALUES ('vesna'), ('dora'), ('tomo')) AS a (name);
SELECT matches(pg_temp.read(t.name), '^ZD401', 'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 7. Invalid input: ZD422 and nothing is recorded.
SELECT matches(pg_temp.record('ana', 3, v.segments), '^ZD422', v.what)
FROM (VALUES
  ('no ranges', '[]'::jsonb),
  ('not an array', '{}'::jsonb),
  ('an empty range', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 5, 5, 'typed'))),
  ('a fractional start', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed') || '{"start": 0.5}')),
  ('a negative start', jsonb_build_array(pg_temp.seg((SELECT a FROM b), -1, 5, 'typed'))),
  ('a kind outside the list', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'dictated'))),
  ('a known paste without its change', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'pasted_known'))),
  ('a block that is not a node id', jsonb_build_array(pg_temp.seg('odlomak-1', 0, 5, 'typed'))),
  ('a key outside the closed set', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed', '{"text": "Izmisljeno"}'))),
  ('a segmentRef with a control character', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed', '{"segmentRef": "a\u0007"}'))),
  ('a change of another kind', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed', jsonb_build_object('changeId', (SELECT id FROM chg))))),
  ('a change that does not exist', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed', '{"changeId": "00000000-0000-4000-8000-0000000000ff"}'))),
  ('two ranges that overlap in a block', jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 10, 'typed'), pg_temp.seg((SELECT a FROM b), 9, 20, 'imported_file')))
) AS v (what, segments);
SELECT matches(pg_temp.record('ana', 9, jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 5, 'typed'))), '^ZD422',
  'a revision that is not saved');
SELECT is((SELECT count(*) FROM evidence.origin_segment WHERE revision = 3), 0::bigint, 'nothing of revision 3 was recorded');
SELECT is(pg_temp.record('ana', 3, jsonb_build_array(pg_temp.seg((SELECT a FROM b), 0, 10, 'typed'),
    pg_temp.seg((SELECT a FROM b), 10, 20, 'imported_file'), pg_temp.seg((SELECT c FROM b), 0, 10, 'typed'))),
  '3', 'ranges that touch, and ranges of another block at the same place, are fine');

-- 8. A range is never rewritten or removed, not even by the owner of the table.
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', v.statement), 'ZD403: origin segment is append-only', v.what)
FROM (VALUES
  ('no range is deleted', $$ DELETE FROM evidence.origin_segment $$),
  ('no kind is rewritten', $$ UPDATE evidence.origin_segment SET kind = 'typed' $$),
  ('the table is not truncated', $$ TRUNCATE evidence.origin_segment $$)
) AS v (what, statement);

SELECT * FROM finish();
ROLLBACK;
