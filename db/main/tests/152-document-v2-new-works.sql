-- SRV-33B (Ductus#2028, c.7041077037; Ductus docs/contracts/document-schema-v2.md
-- §7 t. 2 to 4): a work app.open_student_work makes is v2 from its revision 0,
-- through the real acceptance (app.commit_evidence_segment); an existing v1
-- work stays v1. Ana opens a new work; Tomo's work was made as v1 before this
-- step. Every person, course and text below is invented.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

INSERT INTO ref VALUES
  ('rev0_hash', 'a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b'),
  ('rev0_v2', '{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}'),
  -- The golden vector of server/domain/document/revision-zero.ts, written out.
  ('rev0_v2_hash', '8f8aa5047daa07e8d68f4952aa70ab3c671eccdf6191bfaf6dcba591735f2618'),
  ('v1', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":1}'),
  ('v2', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}');
CREATE FUNCTION pg_temp.val(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT val FROM ref WHERE name = p_name $$;
CREATE FUNCTION pg_temp.sha(p_body text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_body, 'UTF8')), 'hex')
$$;
-- One acceptance of revision 1 over revision 0 by p_actor, as one value.
CREATE FUNCTION pg_temp.commit(p_actor text, p_package text, p_document text, p_initial text, p_snapshot text)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.commit_evidence_segment(%L, %L, 0, %L, %L, %L::jsonb, %L, %L, %L)',
    p_package, 'request-' || pg_temp.sha(p_snapshot), p_initial, pg_temp.sha(p_snapshot),
    jsonb_build_object(
      'evidencePackageId', p_package, 'documentId', p_document, 'sessionId', 'capture-session-v2',
      'segmentId', 'segment-' || pg_temp.sha(p_snapshot), 'evidenceSchema', 'ductus-evidence-segment-v2',
      'canonicalization', 'RFC8785-JCS', 'hashAlgorithm', 'sha256',
      'evidenceProfileId', 'standard-v1', 'sequenceFrom', 1, 'sequenceTo', 1, 'eventCount', 1,
      'observedStartedAt', '2026-11-20T10:00:00.000Z', 'observedEndedAt', '2026-11-20T10:00:00.000Z',
      'segmentHash', repeat('b', 64), 'predecessorSegmentHash', NULL, 'payloadBytes', 123)::text,
    repeat('b', 64), 'synthetic://' || p_package || '/v2', p_snapshot))
$$;
CREATE FUNCTION pg_temp.context(p_actor text, p_document text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT format('%%s|%%s', outcome, document_schema_version)
          FROM app.evidence_commit_context(%L, 'tx-version') $q$, p_document))
$$;
CREATE FUNCTION pg_temp.written() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
    SELECT 'd' || row_to_json(x)::text FROM evidence.document x UNION ALL
    SELECT 'r' || row_to_json(x)::text FROM evidence.document_revision x UNION ALL
    SELECT 'k' || row_to_json(x)::text FROM evidence.document_checkpoint x UNION ALL
    SELECT 'p' || row_to_json(x)::text FROM evidence.package x UNION ALL
    SELECT 's' || row_to_json(x)::text FROM evidence.segment x UNION ALL
    SELECT 'c' || row_to_json(x)::text FROM evidence.receipt x
  ) AS t (r)
$$;

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
-- Tomo's work as app.open_student_work wrote it before this step: v1.
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-t', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-t', pg_temp.id('fak_b'), 'project-t', pg_temp.id('tomo'), pg_temp.val('rev0_hash'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-t', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), pg_temp.val('rev0_hash'));
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body) VALUES
  ('doc-t', pg_temp.id('fak_b'), 0, evidence.revision_zero_document());
INSERT INTO evidence.package (
  id, institution_id, evidence_domain_id, document_id, project_id, principal_id,
  evidence_profile_id, max_payload_bytes
) VALUES
  ('pkg-t', pg_temp.id('fak_b'), '00000000-0000-4000-8000-0000000000d2', 'doc-t', 'project-t',
   pg_temp.id('tomo'), 'standard-v1', 2097152);
SET CONSTRAINTS ALL IMMEDIATE;
-- As in a real transaction: the document and its revision 0 are written in one.
SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;
RESET ROLE;

-- 1. A new work is v2: its revision, hash and checkpoint are the v2 revision 0.
SELECT matches(pg_temp.ask('ana', format('SELECT concat_ws(''|'', outcome, document_hash, snapshot)
    FROM app.open_student_work(%L::uuid, true)', pg_temp.id('z1'))),
  '^opened\|' || pg_temp.val('rev0_v2_hash') || '\|', 'Ana''s new work opens at the v2 revision 0');
INSERT INTO ref SELECT 'doc_a', d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
 WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('z1');
INSERT INTO ref SELECT 'pkg_a', id FROM evidence.package WHERE document_id = pg_temp.val('doc_a');
SELECT is(
  (SELECT format('%s %s %s', d.current_content_hash, r.content_hash, c.body = evidence.revision_zero_document_v2())
     FROM evidence.document d
     JOIN evidence.document_revision r ON r.document_id = d.id AND r.revision = 0
     JOIN evidence.document_checkpoint c ON c.document_id = d.id AND c.revision = 0
    WHERE d.id = pg_temp.val('doc_a')),
  format('%s %s t', pg_temp.val('rev0_v2_hash'), pg_temp.val('rev0_v2_hash')),
  'the document, its revision 0 and its checkpoint are the v2 revision 0');
SELECT is(pg_temp.context('ana', pg_temp.val('doc_a')), 'ok|2', 'the commit context names the new work version 2');

-- 2. A v1 snapshot on the new work is refused (422 on the commit path) and writes nothing.
CREATE TEMP TABLE before_refusal AS SELECT pg_temp.written() AS print;
SELECT matches(pg_temp.commit('ana', pg_temp.val('pkg_a'), pg_temp.val('doc_a'), pg_temp.val('rev0_v2_hash'),
                              pg_temp.val('v1')),
  '^ZD422:', 'a v1 snapshot on a new work is refused');
SELECT is(pg_temp.written(), (SELECT print FROM before_refusal), 'the refusal wrote nothing');
SELECT is(pg_temp.commit('ana', pg_temp.val('pkg_a'), pg_temp.val('doc_a'), pg_temp.val('rev0_v2_hash'),
                         pg_temp.val('v2')),
  'reserved', 'a v2 snapshot on the new work is accepted');

-- 3. An existing v1 work is not touched: it opens as it was and stays v1.
SELECT is(pg_temp.ask('tomo', format('SELECT concat_ws(''|'', outcome, document_hash)
    FROM app.open_student_work(%L::uuid, true)', pg_temp.id('z3'))),
  'opened|' || pg_temp.val('rev0_hash'), 'Tomo''s v1 work opens at its v1 revision 0');
SELECT is(pg_temp.context('tomo', 'doc-t'), 'ok|1', 'and the commit context still names it version 1');
SELECT matches(pg_temp.commit('tomo', 'pkg-t', 'doc-t', pg_temp.val('rev0_hash'), pg_temp.val('v2')),
  '^ZD422:', 'a v2 snapshot on the v1 work is refused');
SELECT is(pg_temp.commit('tomo', 'pkg-t', 'doc-t', pg_temp.val('rev0_hash'), pg_temp.val('v1')),
  'reserved', 'a v1 snapshot on the v1 work is still accepted');
SELECT is((SELECT count(*)::integer FROM evidence.document WHERE principal_id = pg_temp.id('tomo')), 1,
  'opening did not make Tomo a second work');

-- 4. The function keeps its arguments, owner and reach.
SELECT is(pg_get_function_arguments('app.open_student_work(uuid,boolean)'::regprocedure),
  'p_assignment_id uuid, p_start boolean DEFAULT true', 'the same arguments');
SELECT ok((SELECT p.prosecdef AND p.proowner = 'ductus_evidence'::regrole AND 'search_path=""' = ANY (p.proconfig)
             FROM pg_proc p WHERE p.oid = 'app.open_student_work(uuid,boolean)'::regprocedure),
  'a SECURITY DEFINER function of the evidence role with an empty search_path');
SELECT is(ARRAY(SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                           'ductus_identity', 'public']) AS r
                 WHERE has_function_privilege(r, 'app.open_student_work(uuid,boolean)', 'EXECUTE')),
  ARRAY['ductus_app'], 'only the web role executes it');

SELECT * FROM finish();
ROLLBACK;
