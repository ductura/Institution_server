-- SRV-MENTOR-3C (Ductus#2055; owner decision of 24 Nov 2026): the retention
-- purge of works that no longer exist also removes the live state, the
-- revision requests with their versions and responses, the teachers' working
-- criteria, the direct-edit setting with its changes and the teacher edits,
-- and the review marks (20261217170000). The four kinds of 20261217120000
-- stay covered by 239. Personas of institution.inc and evidence-acceptance.inc,
-- all invented: Ana writes doc-a in Vesna's course K1 (fak-a); Tomo writes
-- doc-b in Petra's course K3 (fak-b). Every "doc-gone-*" is a work of fak-a
-- whose document is gone, with rows of one kind only, so each kind is found on
-- its own; "doc-b" in fak-a names a document that exists only in fak-b.
-- Section 6 covers the legal hold (review of #684).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- 1. Catalogue: unchanged grants, the same shape of function.
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      WHERE has_function_privilege(r, 'collaboration.purge_orphan_work_data()', 'EXECUTE') $$,
  $$ VALUES ('ductus_retention') $$,
  'the retention role alone executes the purge');
SELECT ok((SELECT p.prosecdef AND p.proowner = 'ductus_identity'::regrole AND 'search_path=""' = ANY (p.proconfig)
             AND p.provolatile = 'v' AND p.prorettype = 'bigint'::regtype
             FROM pg_proc p WHERE p.oid = 'collaboration.purge_orphan_work_data()'::regprocedure),
  'the purge stays a volatile SECURITY DEFINER function of the identity role with an empty search_path, returning a count');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

-- 2. Rows written directly (no RPC writes on a work that does not exist).
INSERT INTO ref VALUES
  ('anchor', '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}');
CREATE SEQUENCE pg_temp.seq START 9007199254740000;

CREATE FUNCTION pg_temp.put(p_kind text, p_fak text, p_doc text, p_assignment text, p_owner text, p_teacher text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_fak uuid := pg_temp.id(p_fak);
  v_assignment uuid := pg_temp.id(p_assignment);
  v_owner uuid := pg_temp.id(p_owner);
  v_teacher uuid := pg_temp.id(p_teacher);
  v_request uuid;
BEGIN
  CASE p_kind
  WHEN 'live' THEN
    INSERT INTO collaboration.live_state (document_id, institution_id, assignment_id, owner_id, body, content_hash, write_token)
    VALUES (p_doc, v_fak, v_assignment, v_owner, 'Izmišljeni tekst.', pg_temp.sha('Izmišljeni tekst.'), gen_random_uuid());
  WHEN 'revision' THEN
    INSERT INTO collaboration.revision_request (institution_id, assignment_id, owner_id, document_id, anchor, state, version, row_seq, created_by)
    VALUES (v_fak, v_assignment, v_owner, p_doc, (SELECT val::jsonb FROM ref WHERE name = 'anchor'), 'responded', 1,
            nextval('pg_temp.seq'), v_teacher)
    RETURNING id INTO v_request;
    INSERT INTO collaboration.revision_request_version (request_id, institution_id, version, instruction, requested_revision, opened_by)
    VALUES (v_request, v_fak, 1, 'Dopuni izvor.', 0, v_teacher);
    INSERT INTO collaboration.revision_response (request_id, institution_id, version, kind, explanation, response_revision, author_id)
    VALUES (v_request, v_fak, 1, 'done', 'Dopunjeno.', 0, v_owner);
  WHEN 'criterion' THEN
    INSERT INTO collaboration.teacher_working_criterion (institution_id, document_id, assignment_id, owner_id, author_id, criterion_id, assessment)
    VALUES (v_fak, p_doc, v_assignment, v_owner, v_teacher, 'sources', 1);
  WHEN 'setting' THEN
    INSERT INTO collaboration.direct_edit_setting (document_id, institution_id, assignment_id, owner_id, mode, changed_at)
    VALUES (p_doc, v_fak, v_assignment, v_owner, 'direct', now());
    INSERT INTO collaboration.direct_edit_setting_change (document_id, institution_id, mode, actor_id)
    VALUES (p_doc, v_fak, 'direct', v_owner);
  WHEN 'edit' THEN
    INSERT INTO collaboration.teacher_edit (document_id, institution_id, assignment_id, owner_id, author_id, previous_hash, content_hash, body_bytes)
    VALUES (p_doc, v_fak, v_assignment, v_owner, v_teacher, pg_temp.h('a'), pg_temp.h('e'), 64);
  WHEN 'review' THEN
    INSERT INTO collaboration.work_review (institution_id, document_id, teacher_id, assignment_id, owner_id, reviewed_revision)
    VALUES (v_fak, p_doc, v_teacher, v_assignment, v_owner, 1);
  END CASE;
END
$$;

-- The rows of one work, per kind, in the order of the deletions.
CREATE FUNCTION pg_temp.rows(p_fak text, p_doc text) RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM collaboration.live_state WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.revision_request WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.revision_request_version v JOIN collaboration.revision_request r ON r.id = v.request_id
      WHERE r.document_id = p_doc AND r.institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.revision_response s JOIN collaboration.revision_request r ON r.id = s.request_id
      WHERE r.document_id = p_doc AND r.institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.teacher_working_criterion WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.direct_edit_setting WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.direct_edit_setting_change WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.teacher_edit WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)),
    (SELECT count(*) FROM collaboration.work_review WHERE document_id = p_doc AND institution_id = pg_temp.id(p_fak)))
$$;

-- Existing works in both institutions: every kind.
SELECT pg_temp.put(k, 'fak_a', 'doc-a', 'z1', 'ana', 'vesna') FROM unnest(ARRAY['live', 'revision', 'criterion', 'setting', 'edit', 'review']) AS k;
SELECT pg_temp.put(k, 'fak_b', 'doc-b', 'z3', 'tomo', 'petra') FROM unnest(ARRAY['live', 'revision', 'criterion', 'setting', 'edit', 'review']) AS k;
-- Gone works of fak-a, one kind each.
SELECT pg_temp.put(k, 'fak_a', 'doc-gone-' || k, 'z1', 'ana', 'vesna') FROM unnest(ARRAY['live', 'revision', 'criterion', 'setting', 'edit', 'review']) AS k;
-- In fak-a, the id of a document that exists only in fak-b: every kind.
SELECT pg_temp.put(k, 'fak_a', 'doc-b', 'z1', 'ana', 'vesna') FROM unnest(ARRAY['live', 'revision', 'criterion', 'setting', 'edit', 'review']) AS k;

SELECT is(pg_temp.rows('fak_a', 'doc-a'), '1|1|1|1|1|1|1|1|1', 'doc-a has one row of every kind');
SELECT is(pg_temp.rows('fak_b', 'doc-b'), '1|1|1|1|1|1|1|1|1', 'so has doc-b in its own institution');
SELECT is(pg_temp.rows('fak_a', 'doc-b'), '1|1|1|1|1|1|1|1|1', 'and doc-b under fak-a, where no such document is');
SELECT is(string_agg(pg_temp.rows('fak_a', 'doc-gone-' || k), ' ' ORDER BY o),
  '1|0|0|0|0|0|0|0|0 0|1|1|1|0|0|0|0|0 0|0|0|0|1|0|0|0|0 0|0|0|0|0|1|1|0|0 0|0|0|0|0|0|0|1|0 0|0|0|0|0|0|0|0|1',
  'each gone work has rows of its one kind')
  FROM unnest(ARRAY['live', 'revision', 'criterion', 'setting', 'edit', 'review']) WITH ORDINALITY AS t (k, o);

-- 3. The dry run counts every kind and keeps every row.
CREATE FUNCTION pg_temp.dry_run() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_result text;
BEGIN
  BEGIN
    SET LOCAL ROLE ductus_retention;
    v_result := collaboration.purge_orphan_work_data()::text;
    RAISE EXCEPTION USING ERRCODE = 'ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN
    NULL;
  END;
  RESET ROLE;
  RETURN v_result;
END
$$;
SELECT is(pg_temp.dry_run(), '18',
  'the dry run counts nine rows of the gone works (1 live, 3 revision, 1 criterion, 2 setting, 1 edit, 1 review) and nine of doc-b under fak-a');
SELECT is(pg_temp.rows('fak_a', 'doc-gone-revision') || ' ' || pg_temp.rows('fak_a', 'doc-b'),
  '0|1|1|1|0|0|0|0|0 1|1|1|1|1|1|1|1|1', 'and removes nothing');
SELECT is(pg_temp.ask(a, $$ SELECT collaboration.purge_orphan_work_data()::text $$), '42501: permission denied for function purge_orphan_work_data',
  a || ' still cannot purge')
  FROM (VALUES ('ana'), ('vesna'), ('iva')) AS t (a);
SELECT matches(pg_temp.ask_as(r, 'ana', $$ SELECT collaboration.purge_orphan_work_data()::text $$),
  '^42501: permission denied for (function purge_orphan_work_data|schema collaboration)$', r || ' still cannot purge')
  FROM (VALUES ('ductus_worker'), ('ductus_auth'), ('ductus_evidence'), ('ductus_test_stranger')) AS t (r);

-- 4. The purge removes every kind of the gone works, and only those.
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '18',
  'the retention role, without a session, removes eighteen rows');
SELECT is(string_agg(pg_temp.rows('fak_a', 'doc-gone-' || k), ' ' ORDER BY k),
  '0|0|0|0|0|0|0|0|0 0|0|0|0|0|0|0|0|0 0|0|0|0|0|0|0|0|0 0|0|0|0|0|0|0|0|0 0|0|0|0|0|0|0|0|0 0|0|0|0|0|0|0|0|0',
  'nothing of any gone work is left, whatever its kind')
  FROM unnest(ARRAY['live', 'revision', 'criterion', 'setting', 'edit', 'review']) AS k;
SELECT is(pg_temp.rows('fak_a', 'doc-b'), '0|0|0|0|0|0|0|0|0', 'nor of doc-b under fak-a');
SELECT is(pg_temp.rows('fak_b', 'doc-b'), '1|1|1|1|1|1|1|1|1', 'doc-b in its own institution keeps every row');
SELECT is(pg_temp.rows('fak_a', 'doc-a'), '1|1|1|1|1|1|1|1|1', 'and so does the existing doc-a');
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '0',
  'a second run finds nothing more');

-- 5. The four kinds of 239 go in the same run as the new ones.
INSERT INTO collaboration.work_message (institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body)
VALUES (pg_temp.id('fak_a'), 'doc-gone-mixed', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'teacher', 'Stara poruka.');
SELECT pg_temp.put('review', 'fak_a', 'doc-gone-mixed', 'z1', 'ana', 'vesna');
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '2',
  'a gone work with a message and a review mark loses both');
SELECT is((SELECT count(*) FROM collaboration.work_message WHERE document_id = 'doc-gone-mixed')
        + (SELECT count(*) FROM collaboration.work_review WHERE document_id = 'doc-gone-mixed'), 0::bigint,
  'and nothing of it is left');

-- 6. Legal hold (review of #684): a gone work held on itself, on a student or
-- on an assignment of its rows is neither counted nor removed; a gone work
-- next to it without a hold goes. Holds are written as their owner would
-- (no RPC places a hold on a work that does not exist).
SELECT pg_temp.put('review', 'fak_a', 'doc-held-work', 'z1', 'ana', 'vesna');
SELECT pg_temp.put('review', 'fak_a', 'doc-held-student', 'z1', 'dora', 'vesna');
SELECT pg_temp.put('review', 'fak_a', 'doc-held-assignment', 'z2', 'nina', 'marko');
INSERT INTO collaboration.work_item_seen (institution_id, document_id, item_kind, item_id, viewer_id)
VALUES (pg_temp.id('fak_a'), 'doc-held-viewer', 'message', '00000000-0000-4000-8000-000000000392', pg_temp.id('boris'));
SELECT pg_temp.put('review', 'fak_a', 'doc-free', 'z1', 'ana', 'vesna');
INSERT INTO evidence.legal_hold (institution_id, subject_type, subject_id, case_reference, placed_by)
VALUES (pg_temp.id('fak_a'), 'work', 'doc-held-work', 'Predmet 1/2026', pg_temp.id('iva')),
       (pg_temp.id('fak_a'), 'student', pg_temp.id('dora')::text, 'Predmet 2/2026', pg_temp.id('iva')),
       (pg_temp.id('fak_a'), 'assignment', pg_temp.id('z2')::text, 'Predmet 3/2026', pg_temp.id('iva')),
       (pg_temp.id('fak_a'), 'student', pg_temp.id('boris')::text, 'Predmet 4/2026', pg_temp.id('iva'));
CREATE FUNCTION pg_temp.held() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws(' ',
    (SELECT count(*) FROM collaboration.work_review WHERE document_id = 'doc-held-work'),
    (SELECT count(*) FROM collaboration.work_review WHERE document_id = 'doc-held-student'),
    (SELECT count(*) FROM collaboration.work_review WHERE document_id = 'doc-held-assignment'),
    (SELECT count(*) FROM collaboration.work_item_seen WHERE document_id = 'doc-held-viewer'),
    (SELECT count(*) FROM collaboration.work_review WHERE document_id = 'doc-free'))
$$;
SELECT is(pg_temp.held(), '1 1 1 1 1', 'four held gone works and one free gone work, one row each');
SELECT is(pg_temp.dry_run(), '1', 'the dry run counts only the free work');
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '1',
  'the purge removes only the free work''s row');
SELECT is(pg_temp.held(), '1 1 1 1 0',
  'the work held on itself, on its student, on its assignment and on the viewer of its mark stay untouched');
SELECT is(pg_temp.rows('fak_b', 'doc-b') || ' ' || pg_temp.rows('fak_a', 'doc-a'), '1|1|1|1|1|1|1|1|1 1|1|1|1|1|1|1|1|1',
  'and the existing works still keep every row');

-- Once every hold is released, the next run removes them.
UPDATE evidence.legal_hold SET released_at = now(), release_request_ref = 'Zahtjev 9/2026', release_reason = 'Predmet zatvoren.'
 WHERE released_at IS NULL;
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '4',
  'with the holds released, the four works go');
SELECT is(pg_temp.held(), '0 0 0 0 0', 'and nothing of them is left');

-- 7. The identity role, owner of the purge, may ask about a hold; no runtime role gains it.
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_auth', 'ductus_test_stranger', 'public']) AS r
      WHERE has_function_privilege(r, 'app.is_on_legal_hold(text,text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_retention'), ('ductus_identity') $$,
  'only retention and the identity role ask whether a subject is held');

SELECT * FROM finish();
ROLLBACK;
