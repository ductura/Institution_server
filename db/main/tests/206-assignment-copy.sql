-- SRV-1904 (pilot addition P-D4): a teacher copies an assignment into a
-- course they teach. The copy is a new assignment at version 1 with the
-- content of the source's current version; it carries no submission and no
-- row about a student, and the source stays as it was. A caller without a
-- relation to the source or to the target course writes nothing and gets one
-- answer (C-23). Every person, course and date below is invented
-- (fixtures/institution.inc: Z1 of K1 at version 2, Vesna teaches K1, Marko
-- K2, Ana and Dora study in K1; Petra and Tomo are of another institution).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- 'ok' or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.copy(p_actor text, p_source text, p_course text, p_key text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE 'ok' END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT id::text FROM institution.copy_assignment(%s, %s, %s::uuid, NULL, NULL) AS id',
      p_source, p_course, p_key)) AS r) x
$$;
-- The whole source, to compare before and after.
CREATE FUNCTION pg_temp.source_state() RETURNS text
LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT format('%s,%s,%s', course_id, current_version, created_by) FROM institution.assignment
      WHERE id = pg_temp.id('z1')),
    (SELECT string_agg(format('%s:%s:%s:%s', version_no, title, ai_purposes, due_at), ';' ORDER BY version_no)
       FROM institution.assignment_version WHERE assignment_id = pg_temp.id('z1')),
    (SELECT count(*) FROM institution.notice_acknowledgment WHERE assignment_id = pg_temp.id('z1')))
$$;

-- Catalogue: the web role may call it, nobody else.
SELECT ok(has_function_privilege('ductus_app',
  'institution.copy_assignment(uuid,uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'), 'the web role calls the copy');
SELECT ok(NOT has_function_privilege(r,
  'institution.copy_assignment(uuid,uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'), r || ' cannot call the copy')
FROM unnest(ARRAY['ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r;
SELECT is((SELECT p.prosecdef::text || '|' || p.proowner::regrole::text FROM pg_proc p
            WHERE p.oid = 'institution.copy_assignment(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure),
  'true|ductus_identity', 'the copy runs as the identity role, with its own checks');

-- Rows about students on the source, so that a copy has something to leave out.
INSERT INTO institution.deadline_extension (institution_id, assignment_id, student_id, previous_due_at, due_at,
                                            reason_id, created_by)
VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), now() + interval '30 days',
        now() + interval '40 days', 'justified', pg_temp.id('vesna'));
CREATE TEMP TABLE before_copy AS SELECT pg_temp.source_state() AS state;

-- Refusals: no relation to the source, to the target or to either, and one
-- answer for every one of them, also for an id that does not exist.
SELECT is(pg_temp.copy('anon', '{z1}', '{k1}', quote_literal(gen_random_uuid())), 'ZD401', 'without a session nothing is copied');
SELECT is(pg_temp.copy(a.name, '{z1}', '{k1}', quote_literal(gen_random_uuid())), 'ZD403',
  a.name || ' cannot copy Z1 into K1')
FROM (VALUES ('marko'), ('iva'), ('ana'), ('dora'), ('boris'), ('nina'), ('petra'), ('lea'), ('tomo')) AS a (name);
SELECT is(pg_temp.copy('vesna', '{z1}', '{k2}', quote_literal(gen_random_uuid())), 'ZD403',
  'Vesna cannot copy into K2, which she does not teach');
SELECT is(pg_temp.copy('vesna', '{z1}', '{k3}', quote_literal(gen_random_uuid())), 'ZD403',
  'Vesna cannot copy into a course of another institution');
SELECT is(pg_temp.copy('vesna', '{z1}', '{nobody}', quote_literal(gen_random_uuid())), 'ZD403',
  'a course that does not exist is the same refusal');
SELECT is(pg_temp.copy('vesna', '{z2}', '{k1}', quote_literal(gen_random_uuid())), 'ZD403',
  'Vesna cannot copy Z2 of K2, which she does not teach');
SELECT is(pg_temp.copy('vesna', '{z3}', '{k1}', quote_literal(gen_random_uuid())), 'ZD403',
  'Vesna cannot copy an assignment of another institution');
SELECT is(pg_temp.copy('vesna', '{nobody}', '{k1}', quote_literal(gen_random_uuid())), 'ZD403',
  'an assignment that does not exist is the same refusal');
SELECT is(pg_temp.copy('marko', '{z1}', '{k2}', quote_literal(gen_random_uuid())), 'ZD403',
  'Marko teaches the target but not the source: refused');
SELECT is(pg_temp.ask('vesna', 'SELECT institution.copy_assignment({z1}, {k1}, NULL, NULL, NULL)'),
  'ZD422: invalid input', 'without a request key nothing is copied');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.copy_assignment({z1}, {k1}, gen_random_uuid(), now() + interval '9 days', now() + interval '2 days') $$),
  'ZD422: invalid input', 'an opening after the deadline is refused');
SELECT is((SELECT count(*) FROM institution.assignment), 3::bigint, 'no refusal wrote an assignment');

-- Vesna teaches K2 too: Z1 (partially allowed AI) does not fit K2's prohibited rule.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k2'), pg_temp.id('fak_a'), pg_temp.id('vesna'), 'teacher');
SELECT is(pg_temp.copy('vesna', '{z1}', '{k2}', quote_literal(gen_random_uuid())), 'ZD422',
  'a copy may not be wider on AI than the target course allows');

-- The copy: a new assignment at version 1 with the current content of Z1.
INSERT INTO ref VALUES ('key1', '00000000-0000-4000-8000-00000000c0f1');
SELECT is(pg_temp.copy('vesna', '{z1}', '{k1}', '{key1}'), 'ok', 'Vesna copies Z1 into K1');
INSERT INTO ref
SELECT 'copy1', id::text FROM institution.assignment WHERE request_id = pg_temp.id('key1');
SELECT row_eq(
  $$ SELECT course_id, institution_id, current_version, created_by, mentorship_id FROM institution.assignment
      WHERE id = pg_temp.id('copy1') $$,
  ROW(pg_temp.id('k1'), pg_temp.id('fak_a'), 1, pg_temp.id('vesna'), NULL::uuid),
  'the copy is a new assignment of K1 at version 1, made by Vesna');
SELECT results_eq(
  $$ SELECT version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes, evidence_profile,
            import_allowed, word_min, word_max, purpose_catalog_version, work_language, created_by
       FROM institution.assignment_version WHERE assignment_id = pg_temp.id('copy1') $$,
  $$ SELECT 1, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes, evidence_profile,
            import_allowed, word_min, word_max, purpose_catalog_version, work_language, pg_temp.id('vesna')
       FROM institution.assignment_version WHERE assignment_id = pg_temp.id('z1') AND version_no = 2 $$,
  'its only version is the content of Z1''s current version');

-- No submission and no row about a student came with it.
SELECT is(
  (SELECT count(*) FROM (
     SELECT assignment_id FROM institution.notice_acknowledgment
     UNION ALL SELECT assignment_id FROM institution.notice_read
     UNION ALL SELECT assignment_id FROM institution.deadline_extension
     UNION ALL SELECT assignment_id FROM institution.work_language_override
     UNION ALL SELECT assignment_id FROM institution.work_accommodation
     UNION ALL SELECT assignment_id FROM institution.work_grant
     UNION ALL SELECT assignment_id FROM institution.work_source
     UNION ALL SELECT assignment_id FROM institution.work_attachment
     UNION ALL SELECT assignment_id FROM institution.work_milestone
     UNION ALL SELECT assignment_id FROM institution.source_proof
     UNION ALL SELECT assignment_id FROM evidence.project
     UNION ALL SELECT assignment_id FROM evidence.submission_request
     UNION ALL SELECT assignment_id FROM evidence.submission
     UNION ALL SELECT assignment_id FROM evidence.submission_note
     UNION ALL SELECT assignment_id FROM evidence.event_dispute
     UNION ALL SELECT assignment_id FROM collaboration.comment_thread
     UNION ALL SELECT assignment_id FROM collaboration.live_state
     UNION ALL SELECT assignment_id FROM collaboration.teacher_note
     UNION ALL SELECT assignment_id FROM collaboration.work_message
     UNION ALL SELECT assignment_id FROM collaboration.work_review
   ) x WHERE assignment_id = pg_temp.id('copy1')),
  0::bigint, 'the copy has no submission, work, acknowledgment, extension or other row about a student');
SELECT is((SELECT count(*) FROM institution.deadline_extension WHERE assignment_id = pg_temp.id('z1')), 1::bigint,
  'the source still has its own extension');

-- The source is unchanged.
SELECT is(pg_temp.source_state(), (SELECT state FROM before_copy), 'Z1, its versions and acknowledgments are unchanged');

-- The same key again: the same copy; with other dates: a conflict.
SELECT is(pg_temp.ask('vesna', 'SELECT institution.copy_assignment({z1}, {k1}, {key1}, NULL, NULL)'),
  pg_temp.id('copy1')::text, 'the same key answers the same copy');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.copy_assignment({z1}, {k1}, {key1}, now(), now() + interval '99 days') $$),
  'ZD409: conflict', 'the same key with other dates is a conflict');
SELECT is((SELECT count(*) FROM institution.assignment WHERE created_by = pg_temp.id('vesna')), 2::bigint,
  'replays wrote no further assignment');

-- New dates: the copy keeps the rest of the content.
INSERT INTO ref VALUES ('key2', '00000000-0000-4000-8000-00000000c0f2');
SELECT is(pg_temp.ask('vesna', $$
  SELECT 'ok' FROM institution.copy_assignment({z1}, {k1}, {key2}, now() + interval '365 days',
                                               now() + interval '395 days') $$),
  'ok', 'Vesna copies Z1 again, with new dates');
SELECT is(
  (SELECT format('%s|%s|%s', v.opens_at - now(), v.due_at - now(), v.title)
     FROM institution.assignment a JOIN institution.assignment_version v ON v.assignment_id = a.id
    WHERE a.request_id = pg_temp.id('key2')),
  '365 days|395 days|Z1', 'the copy takes the new dates and keeps the rest of the content');

-- SRV-1901: whether the source is practice comes along; the copy above is not.
SELECT is((SELECT is_practice FROM institution.assignment WHERE id = pg_temp.id('copy1')), false,
  'a copy of a regular assignment is regular');
INSERT INTO ref VALUES ('z4', '00000000-0000-4000-8000-0000000000a4'), ('key3', '00000000-0000-4000-8000-00000000c0f3');
INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by, is_practice)
VALUES (pg_temp.id('z4'), pg_temp.id('k1'), pg_temp.id('fak_a'), 1, pg_temp.id('vesna'), true);
INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type, opens_at, due_at,
  ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
VALUES (pg_temp.id('z4'), 1, 'Z4', 'Upute za izmišljenu probu.', 'essay', now(), now() + interval '7 days',
  'prohibited', '{}', 'basic', false, pg_temp.id('vesna'));
SELECT is(pg_temp.copy('vesna', '{z4}', '{k1}', '{key3}'), 'ok', 'Vesna copies the practice assignment Z4');
SELECT is((SELECT is_practice FROM institution.assignment WHERE request_id = pg_temp.id('key3')), true,
  'a copy of a practice assignment is practice too');

-- A student of K1 sees the copy as a new assignment of the course, as after
-- any new assignment; the copy is readable through RLS like any other.
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM institution.assignment WHERE id = {copy1}'), '1',
  'Ana, a student of K1, sees the copy');
SELECT is(pg_temp.ask('tomo', 'SELECT count(*)::text FROM institution.assignment WHERE id = {copy1}'), '0',
  'Tomo, of another institution, does not');

SELECT * FROM finish();
ROLLBACK;
