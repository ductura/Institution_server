-- SRV-33B (Ductus#2028, c.7041077037; Ductus docs/contracts/document-schema-v2.md
-- §7 t. 3 and 6): app.evidence_commit_context names the document version of
-- the work, from the checkpoint of its revision 0. Ana's work is v1, Tomo's
-- v2. Every person, course and text below is invented.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

INSERT INTO ref VALUES
  ('rev0_hash', 'a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b'),
  ('rev0_v2_hash', '8f8aa5047daa07e8d68f4952aa70ab3c671eccdf6191bfaf6dcba591735f2618');
CREATE FUNCTION pg_temp.val(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT val FROM ref WHERE name = p_name $$;
-- The outcome and the version of one call, as one line; NULL prints as nothing.
CREATE FUNCTION pg_temp.version(p_actor text, p_document text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT format('%%s|%%s', outcome, document_schema_version)
          FROM app.evidence_commit_context(%L, 'tx-version') $q$, p_document))
$$;

-- 1. Catalogue: the same arguments, owner and reach; the version is the last column.
SELECT is(pg_get_function_result('app.evidence_commit_context(text,text)'::regprocedure),
  'TABLE(outcome text, evidence_package_id text, institution_id uuid, evidence_domain_id uuid, evidence_profile_id text, max_payload_bytes integer, transaction_known boolean, current_revision bigint, document_hash text, head_segment_hash text, last_sequence_to bigint, document_schema_version integer)',
  'the context returns the chain state and the version of the work, and no person');
SELECT ok((SELECT p.prosecdef AND p.proowner = 'ductus_evidence'::regrole AND 'search_path=""' = ANY (p.proconfig)
             FROM pg_proc p WHERE p.oid = 'app.evidence_commit_context(text,text)'::regprocedure),
  'still a SECURITY DEFINER function of the evidence role with an empty search_path');
SELECT is(ARRAY(SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                           'ductus_identity']) AS r
                 WHERE has_function_privilege(r, 'app.evidence_commit_context(text,text)', 'EXECUTE')),
  ARRAY['ductus_app'], 'only the web role executes it');
SELECT ok(NOT has_function_privilege('public', 'app.evidence_commit_context(text,text)', 'EXECUTE'),
  'PUBLIC does not');

-- Ana's work starts at the v1 revision 0, Tomo's at the v2 one, each with its
-- checkpoint, as app.open_student_work writes them.
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
RESET ROLE;

-- 2. Each owner gets the version of their own work's revision 0.
SELECT is(pg_temp.version('ana', 'doc-a'), 'ok|1', 'a v1 work is named version 1');
SELECT is(pg_temp.version('tomo', 'doc-t'), 'ok|2', 'a v2 work is named version 2');

-- 3. Nobody else learns the version of a work: the refusal carries no column.
SELECT is(pg_temp.version('dora', 'doc-a'), 'not_found|', 'another student of the course gets not_found');
SELECT is(pg_temp.version('ana', 'doc-t'), 'not_found|', 'a student of another institution gets not_found');
SELECT is(pg_temp.version('ana', 'doc-none'), 'not_found|', 'a work that does not exist gets not_found');

-- 4. The version follows revision 0, not the latest revision: a later
-- revision of the work's own version leaves it as it was.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
UPDATE evidence.document SET current_revision = 1,
       current_content_hash = encode(sha256(convert_to('{"nodes":[],"schemaVersion":2,"sources":[]}', 'UTF8')), 'hex')
 WHERE id = 'doc-t';
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT id, institution_id, 1, 0, principal_id, current_content_hash FROM evidence.document WHERE id = 'doc-t';
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
SELECT id, institution_id, 1, '{"nodes":[],"schemaVersion":2,"sources":[]}' FROM evidence.document WHERE id = 'doc-t';
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
SELECT is(pg_temp.version('tomo', 'doc-t'), 'ok|2', 'a later revision does not change the version');

SELECT * FROM finish();
ROLLBACK;
