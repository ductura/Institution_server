-- PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
-- OD-15; PRODUCT §5 rule 11): an assignment that requires a declaration
-- refuses a submission request without a declaration confirmed for the
-- submitted revision, and nothing of the request is written. The switch is
-- off by default (as today) and only the teacher of the assignment sets it
-- (C-23). Synthetic students, documents and conversations only; each case is
-- rolled back, so they do not depend on each other.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE TEMP TABLE demo_conversation (
  conversation_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  reason text NOT NULL,
  required_through_seq integer NOT NULL,
  message_hashes text[] NOT NULL
);
GRANT SELECT ON demo_conversation TO ductus_evidence;

-- Only this test transaction replaces the M9.5 source (as 209).
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.conversation_id, c.reason, c.required_through_seq, c.message_hashes FROM pg_temp.demo_conversation c
    WHERE c.student_id = p_student AND p_institution = pg_temp.id('fak_a')
      AND p_assignment = pg_temp.id('z1') AND p_document = 'doc-a'
$$;

CREATE FUNCTION pg_temp.save(p_base int, p_confirm boolean, p_revision bigint DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  body jsonb := jsonb_build_object('baseVersion',p_base,'revision',p_revision,'confirm',p_confirm,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','not_used','attachments','[]'::jsonb,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb));
BEGIN
  RETURN pg_temp.ask('ana',format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)',body,form))::jsonb;
END $$;

CREATE FUNCTION pg_temp.require(p_actor text, p_value text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT institution.set_declaration_required({z1}, %s)::text', p_value))
$$;
CREATE FUNCTION pg_temp.submit(p_revision bigint DEFAULT 1) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.request_submission(%L, %s)', 'doc-a', p_revision))
$$;
CREATE FUNCTION pg_temp.gate(p_revision bigint DEFAULT 1) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT declaration.submission_gate(%L, %s)', 'doc-a', p_revision))
$$;
CREATE FUNCTION pg_temp.read(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT declaration.read_statement({z1}) #>> ''{statement,%s}''', p_key))
$$;
CREATE FUNCTION pg_temp.requests() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM evidence.submission_request q WHERE q.document_id = 'doc-a'
$$;
CREATE FUNCTION pg_temp.pinned() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(q.declaration_version_id::text, 'none')
    FROM evidence.submission_request q WHERE q.document_id = 'doc-a'
$$;

-- 1. The column and the setter.
SELECT col_type_is('institution', 'assignment', 'declaration_required', 'boolean', 'the switch is a boolean');
SELECT col_not_null('institution', 'assignment', 'declaration_required', 'the switch is never null');
SELECT col_default_is('institution', 'assignment', 'declaration_required', 'false',
  'the switch is off by default (OD-6)');
SELECT is((SELECT count(*) FROM institution.assignment WHERE declaration_required), 0::bigint,
  'no existing assignment requires a declaration');
SELECT is(pg_temp.read('declarationRequired'), 'false', 'the student reads the switch off');

-- Only the teacher of the assignment sets it (C-23): a role alone opens nothing.
SELECT is(pg_temp.require('ana', 'true'), 'ZD403: forbidden', 'a student of the assignment cannot set it');
SELECT is(pg_temp.require('dora', 'true'), 'ZD403: forbidden', 'a classmate cannot set it');
SELECT is(pg_temp.require('marko', 'true'), 'ZD403: forbidden', 'a teacher of another course cannot set it');
SELECT is(pg_temp.require('iva', 'true'), 'ZD403: forbidden', 'the administrator cannot set it');
SELECT is(pg_temp.require('nina', 'true'), 'ZD403: forbidden', 'an unconfirmed teacher cannot set it');
SELECT is(pg_temp.require('petra', 'true'), 'ZD403: forbidden', 'a teacher of another faculty cannot set it');
SELECT is(pg_temp.require('vesna', 'NULL'), 'ZD422: invalid input', 'a null value is invalid');
SELECT alike(pg_temp.ask('vesna', 'SELECT institution.set_declaration_required({z3}, true)::text'), 'ZD403:%',
  'the teacher cannot set it on an assignment of another faculty');
SELECT is((SELECT count(*) FROM institution.assignment WHERE declaration_required), 0::bigint,
  'no refused call changed a switch');
SELECT is(pg_temp.require('vesna', 'true'), 'true', 'the teacher of the assignment turns it on');
SELECT is(pg_temp.read('declarationRequired'), 'true', 'the student reads the switch on');
SELECT is(pg_temp.require('vesna', 'false'), 'false', 'the teacher turns it off again');

-- The bridge is the evidence role's only: the app and the public do not call it.
SELECT ok(NOT has_function_privilege('ductus_app', 'app.assignment_declaration_required(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'app.assignment_declaration_required(uuid)', 'EXECUTE')
  AND has_function_privilege('ductus_evidence', 'app.assignment_declaration_required(uuid)', 'EXECUTE'),
  'only the evidence role executes the switch bridge');

SELECT is(pg_temp.call('ana','pkg-a','req-declaration-required',pg_temp.descriptor(),0,
  repeat('a',64),repeat('d',64),repeat('b',64)), 'reserved', 'fixture commits revision 1');

-- 2. On, nothing confirmed: refused, nothing written (acceptance 1).
SAVEPOINT none_confirmed;
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.gate(), 'declaration_required', 'the gate names the missing declaration');
SELECT is(pg_temp.submit(), 'ZD428: declaration_required', 'the request is refused');
SELECT is(pg_temp.requests(), 0::bigint, 'nothing of the request is written');
SELECT is(pg_temp.read('state'), 'none', 'the student still reads no declaration');
ROLLBACK TO SAVEPOINT none_confirmed;

-- 3. On, only a draft: a draft is not a confirmation.
SAVEPOINT draft_only;
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.save(0, false) #>> '{statement,state}', 'draft', 'the student saves a draft');
SELECT is(pg_temp.gate(), 'declaration_required', 'the gate refuses a draft');
SELECT is(pg_temp.submit(), 'ZD428: declaration_required', 'a draft does not let the request through');
SELECT is(pg_temp.requests(), 0::bigint, 'nothing is written for a draft');
ROLLBACK TO SAVEPOINT draft_only;

-- 4. On, confirmed for revision 1 and revision 2 submitted (OD-15; acceptance 2).
SAVEPOINT other_revision;
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.save(0, true) #>> '{statement,state}', 'confirmed', 'the student confirms revision 1');
SELECT is(pg_temp.call('ana','pkg-a','req-declaration-required-2',
  pg_temp.descriptor(p_segment=>'segment-a-2',p_sequence_from=>2,p_sequence_to=>2,p_hash=>repeat('c',64),
    p_predecessor=>repeat('b',64)),
  1,repeat('d',64),repeat('e',64),repeat('c',64)), 'reserved', 'the student commits revision 2');
SELECT is(pg_temp.gate(2), 'declaration_required', 'the gate refuses a declaration of another revision');
SELECT is(pg_temp.submit(2), 'ZD428: declaration_required', 'revision 2 is refused without its declaration');
SELECT is(pg_temp.requests(), 0::bigint, 'nothing is written for revision 2');
ROLLBACK TO SAVEPOINT other_revision;

-- 5. On, confirmed for the submitted revision: requested and pinned (acceptance 3).
SAVEPOINT confirmed;
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.save(0, true) #>> '{statement,state}', 'confirmed', 'the student confirms revision 1');
SELECT is(pg_temp.gate(), 'proceed', 'the gate lets the confirmed revision through');
SELECT is(pg_temp.submit(), 'requested', 'the request is written');
SELECT is(pg_temp.pinned(), (SELECT s.id::text FROM declaration.statement s
  WHERE s.document_id = 'doc-a' AND s.payload_jcs IS NOT NULL), 'the confirmed version is pinned');
SELECT is(pg_temp.read('state'), 'bound', 'the student reads the declaration bound');
SELECT is(pg_temp.gate(), 'proceed', 'a live request is answered by request_submission, not the gate');
SELECT is(pg_temp.submit(), 'existing', 'a second click returns the bound request');
ROLLBACK TO SAVEPOINT confirmed;

-- 6. On, a confirmed version made stale by a new required conversation.
SAVEPOINT stale;
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.save(0, true) #>> '{statement,state}', 'confirmed', 'the student confirms revision 1');
INSERT INTO demo_conversation VALUES
  (pg_temp.id('ana'), pg_temp.id('ana'), 'pasted_known', 1, ARRAY[repeat('b',64)]);
SELECT is(pg_temp.read('state'), 'stale', 'the version is stale');
SELECT is(pg_temp.gate(), 'declaration_required', 'the gate refuses a stale version');
SELECT is(pg_temp.submit(), 'ZD428: declaration_required', 'a stale version does not let the request through');
SELECT is(pg_temp.requests(), 0::bigint, 'nothing is written for a stale version');
ROLLBACK TO SAVEPOINT stale;

-- 7. On, a technical failure while reading the declaration refuses (rule 11,
-- owner decision of 23. 11.: a failed confirmation never lets a submission through).
SAVEPOINT read_error;
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.save(0, true) #>> '{statement,state}', 'confirmed', 'the student confirms revision 1');
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'synthetic snapshot failure';
END $$;
SELECT is(pg_temp.submit(), 'ZD428: declaration_required', 'a read error refuses the request');
SELECT is(pg_temp.requests(), 0::bigint, 'nothing is written after a read error');
ROLLBACK TO SAVEPOINT read_error;

-- 8. Off: submitted without a declaration, as today (OD-6; acceptance 4).
SAVEPOINT off;
SELECT is(pg_temp.gate(), 'proceed', 'the gate lets the request through while off');
SELECT is(pg_temp.submit(), 'requested', 'the request is written without a declaration');
SELECT is(pg_temp.pinned(), 'none', 'no version is pinned');
ROLLBACK TO SAVEPOINT off;

-- 9. The gate answers nothing about another student's document.
SELECT pg_temp.require('vesna', 'true');
SELECT is(pg_temp.ask('dora', 'SELECT declaration.submission_gate(''doc-a'', 1)'), 'proceed',
  'another student learns nothing from the gate; request_submission refuses her');
SELECT is(pg_temp.ask('anon', 'SELECT declaration.submission_gate(''doc-a'', 1)'), 'proceed',
  'without a session the gate says nothing either');

SELECT is(pg_temp.requests(), 0::bigint, 'every case was rolled back');

SELECT * FROM finish();
ROLLBACK;
