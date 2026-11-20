-- SRV-33 (Ductus#2028, c.7009695691; Ductus docs/contracts/document-schema-v2.md
-- §6, §7 t. 1, 3 and 4, §8 I1; an object without schemaVersion since
-- 20261120160000): the v2 revision 0 and the rule that every revision of a work has the schemaVersion of its revision 0, through the
-- real acceptance (app.commit_evidence_segment). Ana's work is v1, Tomo's v2.
-- Every person, course and text below is invented.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

INSERT INTO ref VALUES
  ('rev0', '{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":1}'),
  ('rev0_hash', 'a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b'),
  ('rev0_v2', '{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}'),
  -- The golden vector of server/domain/document/revision-zero.ts, written
  -- out, never recomputed (contract §6).
  ('rev0_v2_hash', '8f8aa5047daa07e8d68f4952aa70ab3c671eccdf6191bfaf6dcba591735f2618'),
  ('v1', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":1}'),
  ('v2', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}'),
  ('v2_text', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":"2","sources":[]}'),
  ('no_version', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}]}'),
  -- Valid JSON that the domain accepts but jsonb cannot hold as is: U+0000
  -- and a lone surrogate, each escaped in a text (Codex finding on #420).
  ('v2_nul', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni\u0000odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}'),
  ('v2_surrogate', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni\ud800odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}'),
  ('v1_nul', '{"nodes":[{"children":[{"marks":[],"text":"Izmisljeni\u0000odlomak.","type":"text"}],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":1}');
CREATE FUNCTION pg_temp.val(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT val FROM ref WHERE name = p_name $$;
CREATE FUNCTION pg_temp.sha(p_body text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_body, 'UTF8')), 'hex')
$$;

-- 1. The v2 revision 0: the bytes and the hash of the golden vector; v1 unchanged.
SELECT is(evidence.revision_zero_document_v2(), pg_temp.val('rev0_v2'),
  'the v2 revision 0 is the empty paragraph with the fixed id, schemaVersion 2 and no sources');
SELECT is(pg_temp.sha(evidence.revision_zero_document_v2()), pg_temp.val('rev0_v2_hash'),
  'its SHA-256 is the golden vector of the domain');
SELECT is(evidence.revision_zero_document(), pg_temp.val('rev0'), 'the v1 revision 0 is unchanged');
SELECT is(pg_temp.sha(evidence.revision_zero_document()), pg_temp.val('rev0_hash'), 'and so is its hash');

-- 2. The new functions: the evidence role's, empty search path, no right for
-- the web role or PUBLIC; only the trigger function is a definer.
SELECT is(
  (SELECT string_agg(format('%s %s %s %s %s', p.oid::regprocedure, pg_get_userbyid(p.proowner), p.provolatile,
                            p.prosecdef, 'search_path=""' = ANY(p.proconfig)), ' | ' ORDER BY p.oid::regprocedure::text)
     FROM pg_proc p
    WHERE p.oid IN ('evidence.revision_zero_document_v2()'::regprocedure, 'evidence.document_object(text)'::regprocedure,
                    'evidence.keep_document_schema_version()'::regprocedure)),
  'evidence.document_object(text) ductus_evidence i f t | '
  'evidence.keep_document_schema_version() ductus_evidence v t t | '
  'evidence.revision_zero_document_v2() ductus_evidence i f t',
  'the three functions belong to the evidence role, with an empty search path');
SELECT is_empty($$
  SELECT p.oid::regprocedure::text FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
   WHERE p.oid IN ('evidence.revision_zero_document_v2()'::regprocedure, 'evidence.document_object(text)'::regprocedure,
                   'evidence.keep_document_schema_version()'::regprocedure)
     AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner $$,
  'no role but the owner, nor PUBLIC, may execute them');
SELECT ok(NOT has_function_privilege('ductus_app', 'evidence.revision_zero_document_v2()', 'EXECUTE'),
  'the web role cannot call the v2 revision 0');
SELECT is(
  (SELECT format('%s %s', tgenabled, tgfoid::regprocedure) FROM pg_trigger
    WHERE tgrelid = 'evidence.document_checkpoint'::regclass AND tgname = 'evidence_checkpoint_same_version'),
  'O evidence.keep_document_schema_version()', 'the version trigger is on the checkpoints and enabled');

-- 3. document_object: a JSON object, or null for every other text.
SELECT is(evidence.document_object(pg_temp.val('v2')) -> 'schemaVersion', '2'::jsonb, 'a document is read as an object');
SELECT is(evidence.document_object(pg_temp.val('v2_text')) -> 'schemaVersion', '"2"'::jsonb, 'a text version stays a text');
SELECT is(evidence.document_object(t), NULL, format('%s is no object', t))
  FROM unnest(ARRAY['x', '[1]', '"izmisljeno"', '2', '{"nodes":', '[1, "\u0000"]', '']) AS t;
SELECT is(evidence.document_object(pg_temp.val(n)) -> 'schemaVersion', v::jsonb,
          format('%s is read with its version, though jsonb cannot hold its text', n))
  FROM (VALUES ('v2_nul', '2'), ('v2_surrogate', '2'), ('v1_nul', '1')) AS t (n, v);
SELECT is(evidence.document_object('{"a\\u0000":"\\\u0000","schemaVersion":2}') -> 'schemaVersion', '2'::jsonb,
          'an escaped backslash before u0000 stays text');

-- Ana's work starts at the v1 revision 0, Tomo's at the v2 one, each with
-- its checkpoint, as app.open_student_work writes them.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-t', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), pg_temp.val('rev0_hash')),
  ('doc-t', pg_temp.id('fak_b'), 'project-t', pg_temp.id('tomo'), pg_temp.val('rev0_v2_hash'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), pg_temp.val('rev0_hash')),
  ('doc-t', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), pg_temp.val('rev0_v2_hash'));
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, evidence.revision_zero_document()),
  ('doc-t', pg_temp.id('fak_b'), 0, evidence.revision_zero_document_v2());
INSERT INTO evidence.package (
  id, institution_id, evidence_domain_id, document_id, project_id, principal_id,
  evidence_profile_id, max_payload_bytes
) VALUES
  ('pkg-a', pg_temp.id('fak_a'), '00000000-0000-4000-8000-0000000000d1', 'doc-a', 'project-a',
   pg_temp.id('ana'), 'standard-v1', 2097152),
  ('pkg-t', pg_temp.id('fak_b'), '00000000-0000-4000-8000-0000000000d2', 'doc-t', 'project-t',
   pg_temp.id('tomo'), 'standard-v1', 2097152);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;
RESET ROLE;

-- One acceptance of revision 1 over revision 0 by p_actor, as one value.
CREATE FUNCTION pg_temp.commit(p_actor text, p_package text, p_document text, p_initial text, p_snapshot text)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.commit_evidence_segment(%L, %L, 0, %L, %L, %L::jsonb, %L, %L, %L)',
    p_package, 'request-' || p_package || '-' || pg_temp.sha(p_snapshot), p_initial, pg_temp.sha(p_snapshot),
    jsonb_build_object(
      'evidencePackageId', p_package, 'documentId', p_document, 'sessionId', 'capture-session-v2',
      'segmentId', 'segment-' || pg_temp.sha(p_snapshot), 'evidenceSchema', 'ductus-evidence-segment-v2',
      'canonicalization', 'RFC8785-JCS', 'hashAlgorithm', 'sha256',
      'evidenceProfileId', 'standard-v1', 'sequenceFrom', 1, 'sequenceTo', 1, 'eventCount', 1,
      'observedStartedAt', '2026-11-20T10:00:00.000Z', 'observedEndedAt', '2026-11-20T10:00:00.000Z',
      'segmentHash', repeat('b', 64), 'predecessorSegmentHash', NULL, 'payloadBytes', 123)::text,
    repeat('b', 64), 'synthetic://' || p_package || '/v2', p_snapshot))
$$;
-- Everything the acceptance writes, as one value.
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
CREATE TEMP TABLE before_refusals AS SELECT pg_temp.written() AS print;

-- 4. A revision of the other version is refused and writes nothing (§7 t. 4,
-- §8 I1), in both directions; so is a version of another JSON type.
SELECT matches(pg_temp.commit('ana', 'pkg-a', 'doc-a', pg_temp.val('rev0_hash'), pg_temp.val('v2')),
  '^ZD422:', 'a v2 revision of a v1 work is refused');
SELECT matches(pg_temp.commit('tomo', 'pkg-t', 'doc-t', pg_temp.val('rev0_v2_hash'), pg_temp.val('v1')),
  '^ZD422:', 'a v1 revision of a v2 work is refused');
SELECT matches(pg_temp.commit('tomo', 'pkg-t', 'doc-t', pg_temp.val('rev0_v2_hash'), pg_temp.val('v2_text')),
  '^ZD422:', 'a schemaVersion of "2" as text is not version 2');
SELECT matches(pg_temp.commit('ana', 'pkg-a', 'doc-a', pg_temp.val('rev0_hash'), pg_temp.val(n)),
  '^ZD422:', format('a v2 revision of a v1 work is refused though jsonb cannot hold its text (%s)', n))
  FROM unnest(ARRAY['v2_nul', 'v2_surrogate']) AS n;
SELECT matches(pg_temp.commit('tomo', 'pkg-t', 'doc-t', pg_temp.val('rev0_v2_hash'), pg_temp.val('v1_nul')),
  '^ZD422:', 'and so is a v1 revision of a v2 work');
SELECT is(pg_temp.written(), (SELECT print FROM before_refusals), 'no refusal wrote anything');

-- 5. A revision of the work's own version is accepted, for v1 as before and for v2.
SELECT is(pg_temp.commit('ana', 'pkg-a', 'doc-a', pg_temp.val('rev0_hash'), pg_temp.val('v1')), 'reserved',
  'a v1 revision of a v1 work is accepted');
SELECT is(pg_temp.commit('tomo', 'pkg-t', 'doc-t', pg_temp.val('rev0_v2_hash'), pg_temp.val('v2')), 'reserved',
  'a v2 revision of a v2 work is accepted');
SELECT is(
  (SELECT string_agg(format('%s %s %s', document_id, revision, evidence.document_object(body) -> 'schemaVersion'), ' | '
                     ORDER BY document_id, revision)
     FROM evidence.document_checkpoint WHERE document_id IN ('doc-a', 'doc-t')),
  'doc-a 0 1 | doc-a 1 1 | doc-t 0 2 | doc-t 1 2', 'each work keeps the version of its revision 0');

-- 6. The rule reads only JSON objects with a schemaVersion: a stored text
-- that is no document (no object, or an object without the key, which the
-- server's validator never accepts) is left to the other checks of the
-- checkpoint, as before this migration.
SET LOCAL ROLE ductus_evidence;
SET CONSTRAINTS ALL DEFERRED;
UPDATE evidence.document SET current_revision = 2, current_content_hash = pg_temp.sha('izmisljeni tekst')
 WHERE id = 'doc-a';
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-a', pg_temp.id('fak_a'), 2, 1, pg_temp.id('ana'), pg_temp.sha('izmisljeni tekst'));
UPDATE evidence.document SET current_revision = 2, current_content_hash = pg_temp.sha(pg_temp.val('no_version'))
 WHERE id = 'doc-t';
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-t', pg_temp.id('fak_b'), 2, 1, pg_temp.id('tomo'), pg_temp.sha(pg_temp.val('no_version')));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', format(
  $q$ INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      SELECT 'doc-t', institution_id, 2, %L FROM evidence.document WHERE id = 'doc-t'
      RETURNING revision $q$, pg_temp.val('no_version'))),
  '2', 'an object without schemaVersion is not judged by the version rule');
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon',
  $q$ INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
      SELECT 'doc-a', institution_id, 2, 'izmisljeni tekst' FROM evidence.document WHERE id = 'doc-a'
      RETURNING revision $q$),
  '2', 'a text that is no JSON object is not judged by the version rule');

SELECT * FROM finish();
ROLLBACK;
