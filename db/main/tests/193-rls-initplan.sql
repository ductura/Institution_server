-- SRV-1411: exercise real evidence RLS with the same synthetic actors as test 040.
BEGIN;
\ir fixtures/institution.inc
SELECT plan(5);

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
VALUES
  ('srv1411-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('srv1411-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora')),
  ('srv1411-t', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));

INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
SELECT id, institution_id, id, principal_id, repeat('a', 64)
FROM evidence.project WHERE id IN ('srv1411-a', 'srv1411-d', 'srv1411-t');

-- Exactly 10,000 revisions across two students of K1 and one student of K3.
INSERT INTO evidence.document_revision
  (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT d.id, d.institution_id, r.n, CASE WHEN r.n > 0 THEN r.n - 1 END,
       d.principal_id, d.current_content_hash
FROM evidence.document d
CROSS JOIN LATERAL generate_series(0, CASE WHEN d.id = 'srv1411-a' THEN 9997 ELSE 0 END) r(n)
WHERE d.id IN ('srv1411-a', 'srv1411-d', 'srv1411-t');
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
ANALYZE evidence.document_revision;

SELECT is(
  (SELECT count(*) FROM evidence.document_revision WHERE document_id LIKE 'srv1411-%'),
  10000::bigint,
  'fixture has 10,000 revisions before RLS filtering'
);

-- The owner sees their rows, a peer sees only their own, and the teacher and
-- an anonymous or stale session see none, as with the policy in test 040.
SELECT results_eq(
  $$ SELECT v.actor, pg_temp.ask(v.actor, $q$
       SELECT concat_ws(':', count(*), min(document_id), max(document_id))
       FROM evidence.document_revision WHERE document_id LIKE 'srv1411-%'
     $q$)
     FROM (VALUES ('ana'), ('dora'), ('tomo'), ('vesna'), ('anon'), ('expired'), ('closed')) v(actor)
     ORDER BY v.actor $$,
  $$ VALUES ('ana', '9998:srv1411-a:srv1411-a'),
            ('anon', '0'), ('closed', '0'), ('dora', '1:srv1411-d:srv1411-d'),
            ('expired', '0'), ('tomo', '1:srv1411-t:srv1411-t'), ('vesna', '0') $$,
  'revision visibility is isolated by principal and institution'
);

CREATE FUNCTION pg_temp.revision_plan() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  query_plan jsonb;
BEGIN
  EXECUTE $q$ EXPLAIN (ANALYZE, VERBOSE, TIMING OFF, FORMAT JSON)
    SELECT count(*) FROM evidence.document_revision WHERE document_id LIKE 'srv1411-%'
  $q$ INTO query_plan;
  RETURN query_plan;
END
$$;

WITH RECURSIVE plan_nodes(node) AS (
  SELECT pg_temp.ask('ana', 'SELECT pg_temp.revision_plan()::text')::jsonb -> 0 -> 'Plan'
  UNION ALL
  SELECT child.node
  FROM plan_nodes parent
  CROSS JOIN LATERAL jsonb_array_elements(parent.node -> 'Plans') AS child(node)
)
SELECT is(
  (SELECT array_agg((node ->> 'Function Name') || ':' || (node ->> 'Actual Loops'))
   FROM plan_nodes WHERE node ->> 'Parent Relationship' = 'InitPlan'),
  ARRAY['current_actor:1'],
  'the 10,000-row query has one InitPlan and evaluates current_actor once'
);

-- A generic plan can be reused, but its identity comes from each execution.
SELECT token AS ana_token FROM tok WHERE name = 'ana' \gset
SELECT token AS dora_token FROM tok WHERE name = 'dora' \gset
SET LOCAL plan_cache_mode = force_generic_plan;
SET LOCAL ROLE ductus_app;
PREPARE srv1411_revisions AS
  SELECT count(*) FROM evidence.document_revision WHERE document_id LIKE 'srv1411-%';
SELECT set_config('app.session_token', :'ana_token', true);
EXECUTE srv1411_revisions \gset ana_
SELECT set_config('app.session_token', :'dora_token', true);
EXECUTE srv1411_revisions \gset dora_
RESET ROLE;

UPDATE identity.session SET closed_at = now(), close_reason = 'logout'
WHERE user_id = pg_temp.id('ana') AND closed_at IS NULL;
SET LOCAL ROLE ductus_app;
SELECT set_config('app.session_token', :'ana_token', true);
EXECUTE srv1411_revisions \gset revoked_
RESET ROLE;
SELECT is(
  ARRAY[:'ana_count'::integer, :'dora_count'::integer, :'revoked_count'::integer],
  ARRAY[9998, 1, 0],
  'the same plan sees a different actor and sees a revoked session as anonymous'
);
SELECT ok(
  (SELECT generic_plans = 3 AND custom_plans = 0
   FROM pg_prepared_statements WHERE name = 'srv1411_revisions'),
  'all three executions used the generic plan'
);
DEALLOCATE srv1411_revisions;

SELECT * FROM finish();
ROLLBACK;
