-- SRV-1803 (M8.2 and M8.2b, DAN-396; D-282, D-290 to D-292; contract
-- docs/adr/import-contract.md): the record of an import (20261202100000).
-- Acceptance: (1) import_event and its confirmation are append only; (2) a
-- work whose assignment does not allow import is refused (the route's 403).
-- Plus the access matrix: only the student owner of the work prepares and
-- confirms; nobody reads or writes a table directly; the confirmation follows
-- the order of the contract (P1 to P4, P6 to P9), gives one event per import
-- and never touches schema evidence. Every person, document and manifest
-- below is invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

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

-- An invented manifest in the canonical key order; its hashes are stand-ins.
CREATE FUNCTION pg_temp.manifest(p_import text, p_document text DEFAULT 'doc-a', p_extra text DEFAULT '') RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"contentSha256":"' || repeat('2', 64) || '","documentId":"' || p_document
      || '","fileFormat":"docx","importId":"' || p_import || '","importKind":"file-upload",'
      || '"manifestSchema":"ductus-import-manifest-v1","rawByteLength":48213,"rawSha256":"'
      || repeat('1', 64) || '","traces":[]' || p_extra || '}'
$$;
-- The same manifest in another file format.
CREATE FUNCTION pg_temp.manifest_as(p_import text, p_format text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(pg_temp.manifest(p_import), '"fileFormat":"docx"', '"fileFormat":"' || p_format || '"')
$$;
CREATE TEMP TABLE imp (name text PRIMARY KEY, id text NOT NULL);
INSERT INTO imp VALUES
  ('i1', '0b5c2a7e-3f1d-4c8e-9a6b-000000000001'), ('i2', '0b5c2a7e-3f1d-4c8e-9a6b-000000000002'),
  ('i3', '0b5c2a7e-3f1d-4c8e-9a6b-000000000003'), ('i4', '0b5c2a7e-3f1d-4c8e-9a6b-000000000004'),
  ('i5', '0b5c2a7e-3f1d-4c8e-9a6b-000000000005'), ('i6', '0b5c2a7e-3f1d-4c8e-9a6b-000000000006'),
  ('old', '0b5c2a7e-3f1d-4c8e-9a6b-0000000000ff');
GRANT SELECT ON imp TO PUBLIC;
CREATE FUNCTION pg_temp.i(p_name text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT id FROM imp WHERE name = p_name $$;
CREATE FUNCTION pg_temp.prepare(p_actor text, p_import text, p_manifest text DEFAULT NULL, p_sha text DEFAULT NULL,
  p_file_name text DEFAULT 'Seminar.docx', p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome || coalesce('' '' || base_revision, '''') FROM collaboration.prepare_import(%L, %L, %L, %L, %L)',
    p_document, pg_temp.i(p_import), coalesce(p_manifest, pg_temp.manifest(pg_temp.i(p_import), p_document)),
    coalesce(p_sha, pg_temp.sha(coalesce(p_manifest, pg_temp.manifest(pg_temp.i(p_import), p_document)))),
    p_file_name))
$$;
CREATE FUNCTION pg_temp.confirm(p_actor text, p_import text, p_sha text DEFAULT NULL, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM collaboration.confirm_import(%L, %L, %L)',
    p_document, pg_temp.i(p_import), coalesce(p_sha, pg_temp.sha(pg_temp.manifest(pg_temp.i(p_import), p_document)))))
$$;
CREATE FUNCTION pg_temp.event_of(p_actor text, p_import text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT event_id::text FROM collaboration.confirm_import(%L, %L, %L)',
    'doc-a', pg_temp.i(p_import), pg_temp.sha(pg_temp.manifest(pg_temp.i(p_import)))))
$$;
CREATE FUNCTION pg_temp.gate(p_actor text, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT outcome FROM collaboration.import_gate(%L)', p_document))
$$;

-- 1. Catalogue: owner, forced RLS, one owner policy each, no direct privilege.
SELECT bag_eq(
  $$ SELECT relname::text FROM pg_class WHERE relnamespace = 'collaboration'::regnamespace AND relkind = 'r'
      AND relname IN ('import_event', 'import_confirmation')
      AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('import_event'), ('import_confirmation') $$,
  'the identity role owns both tables and RLS is forced on each');
SELECT bag_eq(
  $$ SELECT tablename::text, policyname::text, roles::text, cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename IN ('import_event', 'import_confirmation') $$,
  $$ VALUES ('import_event', 'import_event_owner', '{ductus_identity}', 'ALL'),
            ('import_confirmation', 'import_confirmation_owner', '{ductus_identity}', 'ALL') $$,
  'each table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || t || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.import_event', 'collaboration.import_confirmation']) AS t
      WHERE has_table_privilege(r, t, p) $$,
  'no runtime role reads or writes an import or its confirmation directly: the client writes only through the RPCs');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.import_gate(text)'::regprocedure,
        'collaboration.prepare_import(text,uuid,text,text,text)'::regprocedure,
        'collaboration.confirm_import(text,uuid,text)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the three RPCs are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT is(
  (SELECT p.prosecdef AND p.proowner = 'ductus_evidence'::regrole AND 'search_path=""' = ANY (p.proconfig)
     FROM pg_proc p WHERE p.oid = 'collaboration.document_import_revision(text)'::regprocedure),
  true, 'the revision is read through a function of the evidence role, as document_scope');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'ductus_identity']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.import_gate(text)', 'collaboration.prepare_import(text,uuid,text,text,text)',
        'collaboration.confirm_import(text,uuid,text)', 'collaboration.document_import_revision(text)',
        'collaboration.work_takes_import(text,uuid,uuid)', 'collaboration.import_owner_scope(text)',
        'collaboration.is_import_manifest(text,text,uuid,text,text,text,integer)',
        'collaboration.is_import_file_name(text)', 'collaboration.refuse_import_rewrite()']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') AND NOT (r = 'ductus_identity' AND f <> 'collaboration.document_import_revision(text)') $$,
  $$ VALUES ('ductus_app collaboration.import_gate(text)'),
            ('ductus_app collaboration.prepare_import(text,uuid,text,text,text)'),
            ('ductus_app collaboration.confirm_import(text,uuid,text)'),
            ('ductus_identity collaboration.document_import_revision(text)'),
            ('ductus_evidence collaboration.document_import_revision(text)') $$,
  'the web role gates, prepares and confirms; only the identity role (and the owner) reads the revision; the helpers are nobody''s');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT ok(NOT has_schema_privilege('ductus_evidence', 'collaboration', 'USAGE'),
  'after the migration the evidence role keeps no usage of the schema');
SELECT is(pg_get_function_arguments('collaboration.prepare_import(text,uuid,text,text,text)'::regprocedure),
  'p_document_id text, p_import_id uuid, p_manifest text, p_manifest_sha256 text, p_file_name text',
  'preparing takes no actor, owner, revision or time: the session, the document and the database decide');
SELECT is(pg_get_function_arguments('collaboration.confirm_import(text,uuid,text)'::regprocedure),
  'p_document_id text, p_import_id uuid, p_manifest_sha256 text',
  'confirming takes the work, the import and the reviewed hash only (ImportConfirmBodyV1)');

-- 2. The gate: only the student owner, and only while import is allowed.
SELECT is(pg_temp.gate('ana'), 'allowed', 'Ana may import into her work: Z1 allows import');
SELECT is(pg_temp.gate(a.name), 'ZD403: forbidden', a.name || ' may not import into Ana''s work')
FROM (VALUES ('vesna'), ('marko'), ('dora'), ('iva'), ('tomo'), ('petra')) AS a (name);
SELECT matches(pg_temp.gate('anon'), '^ZD401', 'the gate needs a session');
SELECT is(pg_temp.gate('ana', 'doc-nema'), 'ZD403: forbidden', 'a missing work reads as a forbidden one');
SELECT is(pg_temp.gate('tomo', 'doc-b'), 'allowed', 'Tomo may import into his own work at the other faculty');

-- 3. Preparing: the server's manifest, held to its columns.
SELECT is(pg_temp.prepare('ana', 'i1'), 'prepared 0', 'Ana prepares an import over revision 0, read by the database');
SELECT is(pg_temp.prepare(a.name, 'i2'), 'ZD403: forbidden', a.name || ' may not prepare an import into Ana''s work')
FROM (VALUES ('vesna'), ('dora'), ('tomo')) AS a (name);
SELECT matches(pg_temp.prepare('anon', 'i2'), '^ZD401', 'preparing needs a session');
SELECT is(pg_temp.prepare('ana', 'i2', p_sha => repeat('a', 64)), 'ZD422: invalid input',
  'a hash that is not the SHA-256 of the manifest text is refused');
SELECT is(pg_temp.prepare('ana', 'i2', p_manifest => pg_temp.manifest(pg_temp.i('i3'))), 'ZD422: invalid input',
  'a manifest of another import id is refused');
SELECT is(pg_temp.prepare('ana', 'i2', p_manifest => pg_temp.manifest(pg_temp.i('i2'), 'doc-b')), 'ZD422: invalid input',
  'a manifest of another work is refused');
SELECT is(pg_temp.prepare('ana', 'i2', p_manifest => pg_temp.manifest(pg_temp.i('i2'), 'doc-a', ',"fileName":"Seminar.docx"')),
  'ZD422: invalid input', 'a manifest carrying the file name is refused: the name is outside every hash (D-292)');
SELECT is(pg_temp.prepare('ana', 'i2', p_manifest => 'nije json'), 'ZD422: invalid input', 'text that is no JSON is refused');
SELECT is(pg_temp.prepare('ana', 'i2', p_file_name => E'Rad‮gnp.docx'), 'ZD422: invalid input',
  'a file name with a bidirectional override is refused');
SELECT is(pg_temp.prepare('ana', 'i2', p_file_name => '..'), 'ZD422: invalid input', 'the file name .. is refused');
SELECT is(pg_temp.prepare('ana', 'i1'), 'ZD422: invalid input', 'the same import id twice is refused');
SELECT is(pg_temp.prepare('ana', 'i2', p_file_name => NULL), 'prepared 0', 'an import without a file name is prepared');
SELECT is(pg_temp.prepare('ana', 'i5', p_manifest => pg_temp.manifest_as(pg_temp.i('i5'), 'odt')), 'ZD422: invalid input',
  'preparing an odt import is still refused: the v1 manifest and the RPC take docx and pdf alone until the ODT reader (20261220610000)');
SELECT bag_eq(
  $$ SELECT import_id::text, owner_id, base_revision, raw_byte_length, file_name FROM collaboration.import_event $$,
  $$ VALUES (pg_temp.i('i1'), pg_temp.id('ana'), 0::bigint, 48213, 'Seminar.docx'),
            (pg_temp.i('i2'), pg_temp.id('ana'), 0::bigint, 48213, NULL) $$,
  'two rows, Ana''s, with the length of the manifest and the name beside it');
SELECT ok((SELECT bool_and(position('Seminar' IN manifest) = 0) FROM collaboration.import_event),
  'no stored manifest holds the file name');

-- 4. Confirming (contract §5).
SELECT is(pg_temp.confirm(a.name, 'i1'), 'NOT_FOUND', a.name || ' confirming Ana''s import reads as a missing one (P4)')
FROM (VALUES ('vesna'), ('dora'), ('tomo')) AS a (name);
SELECT is(pg_temp.confirm('tomo', 'i1', p_document => 'doc-b'), 'NOT_FOUND', 'Ana''s import does not exist on another work (P4)');
SELECT is(pg_temp.confirm('ana', 'i6'), 'NOT_FOUND', 'an import never prepared is not found');
SELECT is(pg_temp.confirm('ana', 'i1', repeat('b', 64)), 'MANIFEST_MISMATCH', 'another reviewed hash is a mismatch (P2)');
SELECT matches(pg_temp.confirm('closed', 'i1'), '^ZD401', 'a closed session confirms nothing (P6)');
SELECT is(pg_temp.confirm('ana', 'i1'), 'confirmed', 'Ana confirms her reviewed import');
CREATE TEMP TABLE first_event AS SELECT event_id::text AS id FROM collaboration.import_confirmation WHERE import_id = pg_temp.i('i1')::uuid;
SELECT is(pg_temp.event_of('ana', 'i1'), (SELECT id FROM first_event), 'a retry answers the same event (P1, P8)');
SELECT is(pg_temp.confirm('ana', 'i1'), 'already-confirmed', 'a retry is already-confirmed, never a second event');
SELECT is(pg_temp.confirm('ana', 'i1', repeat('b', 64)), 'MANIFEST_MISMATCH', 'a confirmed import with another hash is a mismatch');
SELECT is((SELECT count(*)::integer FROM collaboration.import_confirmation WHERE import_id = pg_temp.i('i1')::uuid), 1,
  'one confirmation, one event (E2)');

-- Expired (P3): an import prepared 61 minutes ago, written by the owner role.
INSERT INTO collaboration.import_event
  (import_id, institution_id, document_id, assignment_id, owner_id, base_revision, manifest, manifest_sha256,
   import_kind, file_format, raw_byte_length, prepared_at)
VALUES (pg_temp.i('old')::uuid, pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), 0,
        pg_temp.manifest(pg_temp.i('old')), pg_temp.sha(pg_temp.manifest(pg_temp.i('old'))), 'file-upload', 'docx', 48213,
        statement_timestamp() - interval '61 minutes');
SELECT is(pg_temp.confirm('ana', 'old'), 'EXPIRED', 'an import older than 60 minutes is expired (P3)');

-- Revision changed (P9): Ana's work moves to revision 1 after the import was prepared.
SELECT is(pg_temp.prepare('ana', 'i3'), 'prepared 0', 'Ana prepares a third import over revision 0');
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
VALUES ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), pg_temp.h('b'));
UPDATE evidence.document SET current_revision = 1, current_content_hash = pg_temp.h('b') WHERE id = 'doc-a';
RESET ROLE;
DROP TABLE print_before;
CREATE TEMP TABLE print_before AS SELECT pg_temp.schema_print('evidence') AS evidence;
SELECT is(pg_temp.confirm('ana', 'i3'), 'REVISION_CHANGED', 'a revision committed between preparing and confirming refuses it (P9)');
SELECT is(pg_temp.prepare('ana', 'i4'), 'prepared 1', 'a new import is prepared over the current revision');

-- Import turned off (P7, D-282, acceptance 2): Z1 gets a third version without import.
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by)
VALUES (pg_temp.id('z1'), 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', now(), now() + interval '30 days',
        'partially_allowed', '{proofreading}', 'extended', false, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
SELECT is(pg_temp.confirm('ana', 'i4'), 'IMPORT_NOT_ALLOWED', 'an import of a work whose import was turned off is refused (P7)');
SELECT is(pg_temp.gate('ana'), 'not_allowed', 'the gate says not allowed: the route answers 403');
SELECT is(pg_temp.prepare('ana', 'i5'), 'not_allowed', 'nothing is prepared while the assignment does not allow import');
SELECT is(pg_temp.confirm('ana', 'i1'), 'already-confirmed', 'a confirmed import stays confirmed after import is turned off (P8)');
SELECT is((SELECT count(*)::integer FROM collaboration.import_event WHERE import_id = pg_temp.i('i5')::uuid), 0,
  'a refused preparation writes nothing');

-- The file format of a row (20261220610000, ADR import-manifest-v2 §4 item 2):
-- docx, pdf and odt are held, any other format is refused by the column check
-- of the same name as before. Written by the owner role's session, as above.
CREATE FUNCTION pg_temp.insert_format(p_import text, p_format text) RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    'INSERT INTO collaboration.import_event (import_id, institution_id, document_id, assignment_id, owner_id,'
    || ' base_revision, manifest, manifest_sha256, import_kind, file_format, raw_byte_length)'
    || ' VALUES (%L, %L, ''doc-a'', %L, %L, 0, %L, %L, ''file-upload'', %L, 48213)',
    p_import, pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'),
    pg_temp.manifest_as(p_import, p_format), pg_temp.sha(pg_temp.manifest_as(p_import, p_format)), p_format)
$$;
SELECT is(
  (SELECT convalidated FROM pg_constraint
    WHERE conrelid = 'collaboration.import_event'::regclass AND conname = 'import_event_file_format_check' AND contype = 'c'),
  true, 'the file format check keeps its name and holds for every existing row');
SELECT lives_ok(pg_temp.insert_format('0b5c2a7e-3f1d-4c8e-9a6b-0000000000f1', 'odt'), 'a row of an odt import is held');
SELECT lives_ok(pg_temp.insert_format('0b5c2a7e-3f1d-4c8e-9a6b-0000000000f2', 'docx'), 'a row of a docx import is still held');
SELECT lives_ok(pg_temp.insert_format('0b5c2a7e-3f1d-4c8e-9a6b-0000000000f3', 'pdf'), 'a row of a pdf import is still held');
SELECT throws_ok(pg_temp.insert_format('0b5c2a7e-3f1d-4c8e-9a6b-0000000000f4', 'rtf'), '23514',
  'new row for relation "import_event" violates check constraint "import_event_file_format_check"',
  'a row of an unknown format (rtf) is refused by the file format check');
SELECT throws_ok(pg_temp.insert_format('0b5c2a7e-3f1d-4c8e-9a6b-0000000000f5', 'ODT'), '23514',
  'new row for relation "import_event" violates check constraint "import_event_file_format_check"',
  'the format is matched exactly: ODT in capitals is refused');

-- 5. Append only (acceptance 1), for the owner role as well.
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ UPDATE collaboration.import_event SET file_name = 'Drugo.docx' $$), 'ZD409: append only',
  'an import row is never updated, not even by its owner role');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ DELETE FROM collaboration.import_event $$), 'ZD409: append only',
  'an import row is never deleted');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ TRUNCATE collaboration.import_event CASCADE $$), 'ZD409: append only',
  'the imports are never truncated');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ UPDATE collaboration.import_confirmation SET event_id = gen_random_uuid() $$), 'ZD409: append only',
  'a confirmation is never updated: its event stays the one event');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ DELETE FROM collaboration.import_confirmation $$), 'ZD409: append only',
  'a confirmation is never deleted');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ TRUNCATE collaboration.import_confirmation $$), 'ZD409: append only',
  'the confirmations are never truncated');
SELECT is(pg_temp.ask('ana', $$ INSERT INTO collaboration.import_event (import_id) VALUES (gen_random_uuid()) RETURNING 'x' $$),
  '42501: permission denied for table import_event', 'the web role cannot write an import directly');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM collaboration.import_confirmation $$),
  '42501: permission denied for table import_confirmation', 'the web role cannot read a confirmation directly');

-- 6. Nothing here writes schema evidence.
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before), 'preparing and confirming leave schema evidence as it was');

SELECT * FROM finish();
ROLLBACK;
