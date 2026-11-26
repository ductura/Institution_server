-- SRV-F4-PM2-R14-SRV (F4 row PM2-R14, M8.13 "Povijest dokumenta"; Daniel's
-- decision of 26. 11. 2026, Ductus#2059 c.7202802486): the list of the imports
-- of a work (20261220320000), the same for both roles. The access matrix of the
-- read: the student who owns the work and a teacher of its assignment; another
-- student, a teacher of another course, an administrator, a person with no
-- relation and another institution never do. It returns metadata only and
-- writes nothing. Every person, document and manifest below is invented; the
-- documents are those of the shared fixture.
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
CREATE FUNCTION pg_temp.manifest(p_import text, p_document text DEFAULT 'doc-a') RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"contentSha256":"' || repeat('2', 64) || '","documentId":"' || p_document
      || '","fileFormat":"docx","importId":"' || p_import || '","importKind":"file-upload",'
      || '"manifestSchema":"ductus-import-manifest-v1","rawByteLength":48213,"rawSha256":"'
      || repeat('1', 64) || '","traces":[]}'
$$;
CREATE FUNCTION pg_temp.add_import(p_import text, p_document text, p_owner text, p_assignment text, p_institution text,
  p_age interval, p_file_name text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO collaboration.import_event
    (import_id, institution_id, document_id, assignment_id, owner_id, base_revision, manifest, manifest_sha256,
     import_kind, file_format, raw_byte_length, file_name, prepared_at)
  VALUES (p_import::uuid, pg_temp.id(p_institution), p_document, pg_temp.id(p_assignment), pg_temp.id(p_owner), 0,
          pg_temp.manifest(p_import, p_document), pg_temp.sha(pg_temp.manifest(p_import, p_document)),
          'file-upload', 'docx', 48213, p_file_name, statement_timestamp() - p_age)
$$;

-- 1. Catalogue: a SECURITY DEFINER function of the identity role, the web role alone.
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid = 'collaboration.list_imports(text)'::regprocedure
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the read is a SECURITY DEFINER function of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_function_privilege(r, 'collaboration.list_imports(text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role calls the read');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT is(pg_get_function_arguments('collaboration.list_imports(text)'::regprocedure),
  'p_document_id text', 'the read takes no person and no institution: they come from the session');
SELECT is(pg_get_function_result('collaboration.list_imports(text)'::regprocedure) ~ '(manifest|sha256|content)', false,
  'the read has no column of the manifest, a hash or the content');

-- 2. Nothing imported yet: both roles read an empty list.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_imports('doc-a') $$), '0', 'Ana reads no import before one exists');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_imports('doc-a') $$), '0', 'Vesna reads no import before one exists');

-- 3. Three imports of doc-a (one confirmed, one pending, one expired) and one of doc-b.
SELECT pg_temp.add_import('0b5c2a7e-3f1d-4c8e-9a6b-000000000001', 'doc-a', 'ana', 'z1', 'fak_a', interval '3 hours', 'Seminar.docx');
SELECT pg_temp.add_import('0b5c2a7e-3f1d-4c8e-9a6b-000000000002', 'doc-a', 'ana', 'z1', 'fak_a', interval '1 hour 30 minutes', NULL);
SELECT pg_temp.add_import('0b5c2a7e-3f1d-4c8e-9a6b-000000000003', 'doc-a', 'ana', 'z1', 'fak_a', interval '1 minute', 'Dorada.docx');
SELECT pg_temp.add_import('0b5c2a7e-3f1d-4c8e-9a6b-0000000000b1', 'doc-b', 'tomo', 'z3', 'fak_b', interval '1 minute', 'Tomo.docx');
-- The first import is confirmed (the confirmation of the record, as confirm_import writes it).
INSERT INTO collaboration.import_confirmation (import_id, institution_id, document_id, owner_id, confirmed_at)
VALUES ('0b5c2a7e-3f1d-4c8e-9a6b-000000000001', pg_temp.id('fak_a'), 'doc-a', pg_temp.id('ana'), statement_timestamp() - interval '2 hours 50 minutes');
CREATE TEMP TABLE print_before AS SELECT pg_temp.schema_print('evidence') AS evidence, pg_temp.schema_print('audit') AS audit,
  pg_temp.schema_print('collaboration') AS collaboration;

-- 4. Both roles read the same list, newest first, with the derived state.
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(right(import_id::text, 3) || ' ' || state || ' ' || coalesce(file_name, '-')
    || ' ' || (confirmed_at IS NOT NULL)::text || ' ' || (event_id IS NOT NULL)::text, ' | ' ORDER BY o)
    FROM collaboration.list_imports('doc-a') WITH ORDINALITY AS r (import_id, import_kind, file_format, raw_byte_length, file_name, base_revision, prepared_at, state, confirmed_at, event_id, o) $$),
  '003 pending Dorada.docx false false | 002 expired - false false | 001 confirmed Seminar.docx true true',
  'Ana reads her imports newest first: pending, expired after 60 minutes, confirmed with its event');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(right(import_id::text, 3) || ' ' || state, ' | ' ORDER BY o)
    FROM collaboration.list_imports('doc-a') WITH ORDINALITY AS r (import_id, import_kind, file_format, raw_byte_length, file_name, base_revision, prepared_at, state, confirmed_at, event_id, o) $$),
  '003 pending | 002 expired | 001 confirmed', 'the teacher of the assignment reads the same list');
SELECT is(pg_temp.ask('ana', $$ SELECT import_kind || ' ' || file_format || ' ' || raw_byte_length || ' ' || base_revision
    FROM collaboration.list_imports('doc-a') WHERE right(import_id::text, 3) = '001' $$),
  'file-upload docx 48213 0', 'the metadata of an import');
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM collaboration.list_imports('doc-b') $$), '1', 'Tomo reads the import of his own work');
SELECT is(pg_temp.ask('petra', $$ SELECT count(*) FROM collaboration.list_imports('doc-b') $$), '1', 'Petra, the teacher of his assignment, reads it too');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_imports('doc-a') WHERE import_id::text LIKE '%00b1' $$), '0',
  'the imports of another work never appear in a list');

-- 5. Nobody else reads them: one answer for another's, a missing and a foreign work.
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_imports('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no import of Ana''s work')
FROM (VALUES ('marko'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_imports('doc-b') $$), 'ZD403: forbidden',
  'Ana reads no import of a work of another institution');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_imports('doc-b') $$), 'ZD403: forbidden',
  'a teacher of another institution''s work reads nothing');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_imports('doc-nema') $$), 'ZD403: forbidden',
  'a missing work reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT count(*) FROM collaboration.list_imports('doc-a') $$), '^ZD401',
  'a read with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);

-- 6. Access comes from the relation: a second teacher of K1 reads, one who left does not.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.list_imports('doc-a') $$), '3', 'a teacher who joins the course reads the list');
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('marko') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM collaboration.list_imports('doc-a') $$), 'ZD403: forbidden', 'and no longer once he left');

-- 7. The read wrote nothing.
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before), 'the read wrote nothing in the evidence schema');
SELECT is(pg_temp.schema_print('audit'), (SELECT audit FROM print_before), 'the read leaves no row in the access log');

SELECT * FROM finish();
ROLLBACK;
