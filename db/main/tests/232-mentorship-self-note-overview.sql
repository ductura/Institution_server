-- SRV-MENTOR-3 (Ductus#2055; MK-8, MK-9, MK-11, PG-9): the student's note to
-- self and reading place, the "student je vidio" marks and the mentor's
-- overview of the own students (20261214150000). Personas of institution.inc,
-- evidence-acceptance.inc and mentorship.inc, all invented: Ana writes zm1
-- under her mentor Marko (ms1) and doc-a in Vesna's course K1; Dora, Petra,
-- Tomo and the others have no part in Ana's works.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- 1. Catalogue: owner, forced RLS, one owner policy, no direct privilege.
SELECT bag_eq(
  $$ SELECT relname::text FROM pg_class WHERE relnamespace = 'collaboration'::regnamespace AND relkind = 'r'
      AND relname IN ('work_self_note', 'work_item_seen')
      AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('work_self_note'), ('work_item_seen') $$,
  'the identity role owns both tables and RLS is forced on them');
SELECT bag_eq(
  $$ SELECT tablename::text || ' ' || policyname::text || ' ' || roles::text || ' ' || cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename IN ('work_self_note', 'work_item_seen') $$,
  $$ VALUES ('work_self_note work_self_note_owner {ductus_identity} ALL'),
            ('work_item_seen work_item_seen_owner {ductus_identity} ALL') $$,
  'each table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || t || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.work_self_note', 'collaboration.work_item_seen']) AS t
      WHERE has_table_privilege(r, t, p) $$,
  'no runtime role reads or writes either table directly');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.get_work_self_note(text)', 'collaboration.set_work_self_note(text,text,jsonb)',
        'collaboration.set_work_reading_place(text,jsonb)', 'collaboration.clear_work_self_note(text,text)',
        'collaboration.mark_work_items_seen(text,text[],uuid[])', 'collaboration.list_work_items_seen_by_student(text)',
        'collaboration.mentor_student_overview()', 'collaboration.delete_work_self_notes(text,uuid)',
        'collaboration.delete_work_items_seen(text,uuid)', 'collaboration.self_note_scope(text)',
        'collaboration.work_item_author(uuid,text,text,uuid)', 'collaboration.is_work_place(jsonb)',
        'collaboration.is_self_note_text(text)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.get_work_self_note(text)'),
            ('ductus_app collaboration.set_work_self_note(text,text,jsonb)'),
            ('ductus_app collaboration.set_work_reading_place(text,jsonb)'),
            ('ductus_app collaboration.clear_work_self_note(text,text)'),
            ('ductus_app collaboration.mark_work_items_seen(text,text[],uuid[])'),
            ('ductus_app collaboration.list_work_items_seen_by_student(text)'),
            ('ductus_app collaboration.mentor_student_overview()'),
            ('ductus_retention collaboration.delete_work_self_notes(text,uuid)'),
            ('ductus_retention collaboration.delete_work_items_seen(text,uuid)') $$,
  'the web role calls the seven RPCs, the retention role alone deletes, nobody calls the helpers');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.get_work_self_note(text)'::regprocedure, 'collaboration.set_work_self_note(text,text,jsonb)'::regprocedure,
        'collaboration.set_work_reading_place(text,jsonb)'::regprocedure, 'collaboration.clear_work_self_note(text,text)'::regprocedure,
        'collaboration.mark_work_items_seen(text,text[],uuid[])'::regprocedure, 'collaboration.list_work_items_seen_by_student(text)'::regprocedure,
        'collaboration.mentor_student_overview()'::regprocedure, 'collaboration.delete_work_self_notes(text,uuid)'::regprocedure,
        'collaboration.delete_work_items_seen(text,uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the RPCs are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

-- The mentored work of Ana.
CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;

-- 2. The overview before Ana opens her work: waiting on the student, no stage.
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.work_milestone (id, institution_id, assignment_id, position, title, due_at)
VALUES ('00000000-0000-4000-8000-000000000301', pg_temp.id('fak_a'), pg_temp.id('zm1'), 1, 'Nacrt', now() + interval '10 days'),
       ('00000000-0000-4000-8000-000000000302', pg_temp.id('fak_a'), pg_temp.id('zm1'), 2, 'Poglavlje', now() + interval '40 days');
RESET ROLE;
CREATE FUNCTION pg_temp.overview(p_actor text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT coalesce(string_agg(concat_ws('|', mentorship_id = '00000000-0000-4000-8000-0000000000d1',
           document_id IS NOT NULL, given_name IS NOT NULL, work_type, coalesce(stage_title, '-'), coalesce(stage_position::text, '-'),
           stage_count, coalesce(stage_state, '-'), waiting_on, coalesce(days_to_next_deadline::text, '-'), new_messages), ' / '), 'empty')
         FROM collaboration.mentor_student_overview() $q$)
$$;
SELECT is(pg_temp.overview('marko'), 't|f|f|master_thesis|Nacrt|1|2|not_submitted|student|10|0',
  'before the work is opened Marko sees Ana waiting on the first stage, ten days to its deadline');
SELECT is(pg_temp.overview(a), 'empty', a || ' mentors no open mentorship and sees nobody')
  FROM (VALUES ('ana'), ('vesna'), ('dora'), ('petra'), ('tomo')) AS t (a);
SELECT is(pg_temp.overview('nina'), 'empty', 'Nina, whose teacher role is unconfirmed, sees none of her mentorships');
SELECT matches(pg_temp.overview('anon'), '^ZD401', 'the overview needs a session');

SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 6),
  'opened', 'Ana opens her mentored work');

-- 3. The note to self: the owner alone.
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.get_work_self_note(%L) $$, pg_temp.mdoc())), '0',
  'no note is kept until Ana writes one');
SELECT is(pg_temp.ask('ana', format($$ SELECT note_text || '|' || (note_place->>'offset') FROM collaboration.set_work_self_note(%L, 'Provjeriti izvor u drugom poglavlju.', '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 12}') $$, pg_temp.mdoc())),
  'Provjeriti izvor u drugom poglavlju.|12', 'Ana writes a note at a place in her work');
SELECT is(pg_temp.ask('ana', format($$ SELECT (reading_place->>'offset') || '|' || note_text FROM collaboration.set_work_reading_place(%L, '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 40}') $$, pg_temp.mdoc())),
  '40|Provjeriti izvor u drugom poglavlju.', 'the reading place is kept next to the note');
SELECT is(pg_temp.ask(a, format($$ SELECT count(*) FROM collaboration.get_work_self_note(%L) $$, pg_temp.mdoc())), 'ZD403: forbidden',
  a || ' reads nothing of Ana''s note')
  FROM (VALUES ('marko'), ('vesna'), ('dora'), ('petra'), ('tomo'), ('boris')) AS t (a);
SELECT is(pg_temp.ask(a, format($$ SELECT count(*) FROM collaboration.set_work_self_note(%L, 'Tuđa bilješka.', NULL) $$, pg_temp.mdoc())), 'ZD403: forbidden',
  a || ' cannot write a note on Ana''s work')
  FROM (VALUES ('marko'), ('dora')) AS t (a);
SELECT is(pg_temp.ask('marko', format($$ SELECT count(*) FROM collaboration.set_work_reading_place(%L, '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 1}') $$, pg_temp.mdoc())), 'ZD403: forbidden',
  'the mentor cannot write the reading place');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-nema') $$), 'ZD403: forbidden',
  'a missing work reads as another''s');
SELECT matches(pg_temp.ask('anon', format($$ SELECT count(*) FROM collaboration.get_work_self_note(%L) $$, pg_temp.mdoc())), '^ZD401',
  'reading a note needs a session');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.set_work_self_note(%L, %L, %L::jsonb) $$, pg_temp.mdoc(), b.body, b.place)), 'ZD422: invalid input',
  'a note ' || b.why || ' is refused')
  FROM (VALUES (repeat('a', 281), NULL, 'over 280 characters'), ('   ', NULL, 'of blanks only'), (NULL, NULL, 'missing'),
               ('Bilješka.', '{"nodeId": "nije-uuid", "offset": 1}', 'at a malformed node'),
               ('Bilješka.', '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": -1}', 'at a negative offset'),
               ('Bilješka.', '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 1, "quote": "x"}', 'with a quote of the text')) AS b (body, place, why);
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.set_work_reading_place(%L, NULL) $$, pg_temp.mdoc())), 'ZD422: invalid input',
  'a missing reading place is refused');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.set_work_self_note(%L, %L, NULL) $$, pg_temp.mdoc(), repeat('ž', 280))), '1',
  '280 characters are allowed');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.clear_work_self_note(%L, 'sve') $$, pg_temp.mdoc())), 'ZD422: invalid input',
  'only the note or the reading place is cleared');
SELECT is(pg_temp.ask('ana', format($$ SELECT coalesce(note_text, '-') || '|' || (reading_place->>'offset') FROM collaboration.clear_work_self_note(%L, 'note') $$, pg_temp.mdoc())),
  '-|40', 'Ana deletes the note; the reading place stays');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.clear_work_self_note(%L, 'reading') $$, pg_temp.mdoc())), '0',
  'deleting the reading place too leaves nothing');
SELECT is((SELECT count(*) FROM collaboration.work_self_note), 0::bigint, 'and no row is kept');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.clear_work_self_note(%L, 'note') $$, pg_temp.mdoc())), '0',
  'deleting what is not there changes nothing');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.set_work_self_note(%L, 'Opet.', NULL) $$, pg_temp.mdoc())), '1',
  'Ana writes a note again');

-- 4. Seen marks: messages, a milestone revision and a published comment.
INSERT INTO ref SELECT 'msg_a', pg_temp.ask('ana', format($$ SELECT message_id FROM collaboration.create_work_message(%L, 'Poslala sam nacrt.') $$, pg_temp.mdoc()));
INSERT INTO ref SELECT 'msg_m', pg_temp.ask('marko', format($$ SELECT message_id FROM collaboration.create_work_message(%L, 'Pogledat ću do petka.') $$, pg_temp.mdoc()));
SELECT is(pg_temp.overview('marko'), 't|t|f|master_thesis|Nacrt|1|2|not_submitted|mentor|10|1',
  'an unopened message of Ana makes the work wait on Marko');
SELECT is(pg_temp.ask('marko', format($$ SELECT string_agg(item_kind, ',') FROM collaboration.mark_work_items_seen(%L, ARRAY['message', 'message'], ARRAY[%L, %L]::uuid[]) $$,
    pg_temp.mdoc(), pg_temp.id('msg_a'), pg_temp.id('msg_m'))),
  'message', 'Marko opens both messages; only Ana''s is recorded, his own is passed over');
SELECT is(pg_temp.overview('marko'), 't|t|f|master_thesis|Nacrt|1|2|not_submitted|student|10|0',
  'once opened, the message is no longer new');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.list_work_items_seen_by_student(%L) $$, pg_temp.mdoc())), '0',
  'nothing of Marko''s has been seen by Ana yet');
SELECT is(pg_temp.ask('marko', format($$ SELECT count(*) FROM collaboration.list_work_items_seen_by_student(%L) $$, pg_temp.mdoc())), '0',
  'Marko sees no mark before Ana opens his message');

SELECT is(substr(pg_temp.ask('ana', format('SELECT state FROM app.submit_work_milestone(%L, %L::uuid)', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000301')), 1, 9),
  'submitted', 'Ana submits the first stage');
SELECT is(pg_temp.overview('marko'), 't|t|f|master_thesis|Nacrt|1|2|submitted|mentor|10|0',
  'a submitted stage waits on the mentor');
SELECT is(pg_temp.ask('marko', format('SELECT state FROM app.request_work_milestone_revision(%L, %L::uuid, %L, %L::timestamptz)',
    pg_temp.mdoc(), '00000000-0000-4000-8000-000000000301', 'Dopuni uvod.', now() + interval '3 days')),
  'revision_requested', 'Marko asks for a revision within three days');
SELECT is(pg_temp.overview('marko'), 't|t|f|master_thesis|Nacrt|1|2|revision_requested|student|3|0',
  'the revision deadline is the next one, and the work waits on Ana');
INSERT INTO ref SELECT 'rev', e.id::text FROM institution.work_milestone_event e
 WHERE e.document_id = pg_temp.mdoc() AND e.kind = 'revision_requested';

SELECT is(pg_temp.ask('ana', format($$ SELECT string_agg(item_kind, ',' ORDER BY item_kind) FROM collaboration.mark_work_items_seen(%L, ARRAY['message', 'milestone_revision', 'message', 'comment'], ARRAY[%L, %L, %L, %L]::uuid[]) $$,
    pg_temp.mdoc(), pg_temp.id('msg_m'), pg_temp.id('rev'), pg_temp.id('msg_a'), '00000000-0000-4000-8000-000000000399')),
  'message,milestone_revision', 'Ana opens Marko''s message and the revision; her own message and an unknown comment are passed over');
CREATE TEMP TABLE first_seen AS SELECT item_kind, first_seen_at FROM collaboration.work_item_seen WHERE viewer_id = pg_temp.id('ana');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.mark_work_items_seen(%L, ARRAY['message'], ARRAY[%L]::uuid[]) $$, pg_temp.mdoc(), pg_temp.id('msg_m'))),
  '1', 'opening the message again answers it');
SELECT is((SELECT count(*) FROM collaboration.work_item_seen s JOIN first_seen f USING (item_kind)
            WHERE s.viewer_id = pg_temp.id('ana') AND s.first_seen_at = f.first_seen_at), 2::bigint,
  'and keeps the first instant');
SELECT is(pg_temp.ask('marko', format($$ SELECT string_agg(item_kind, ',' ORDER BY item_kind) FROM collaboration.list_work_items_seen_by_student(%L) $$, pg_temp.mdoc())),
  'message,milestone_revision', 'Marko, the author, sees that Ana has seen his message and his revision request');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.list_work_items_seen_by_student(%L) $$, pg_temp.mdoc())), '0',
  'the student reads no mark of her own');
SELECT is(pg_temp.ask(a, format($$ SELECT count(*) FROM collaboration.list_work_items_seen_by_student(%L) $$, pg_temp.mdoc())), 'ZD403: forbidden',
  a || ' reads no mark on Ana''s work')
  FROM (VALUES ('vesna'), ('dora'), ('petra'), ('tomo')) AS t (a);
SELECT is(pg_temp.ask(a, format($$ SELECT count(*) FROM collaboration.mark_work_items_seen(%L, ARRAY['message'], ARRAY[%L]::uuid[]) $$, pg_temp.mdoc(), pg_temp.id('msg_m'))), 'ZD403: forbidden',
  a || ' cannot mark anything on Ana''s work')
  FROM (VALUES ('vesna'), ('dora'), ('petra')) AS t (a);
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.mark_work_items_seen(%L, %s, %s) $$, pg_temp.mdoc(), b.kinds, b.ids)), 'ZD422: invalid input',
  'a report ' || b.why || ' is refused')
  FROM (VALUES ('ARRAY[]::text[]', 'ARRAY[]::uuid[]', 'of no item'),
               ('ARRAY[''message'']', 'ARRAY[]::uuid[]', 'of arrays of unequal length'),
               ('ARRAY[''nesto'']', format('ARRAY[%L]::uuid[]', pg_temp.id('msg_m')), 'of an unknown kind'),
               ('NULL::text[]', 'NULL::uuid[]', 'without items'),
               ('array_fill(''message''::text, ARRAY[201])', format('array_fill(%L::uuid, ARRAY[201])', pg_temp.id('msg_m')), 'of 201 items')) AS b (kinds, ids, why);

-- A draft comment is not seen; a published one is.
INSERT INTO ref SELECT 'thread', pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft('doc-a', 'Nacrt komentara.', '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "quote": "a", "prefix": "", "suffix": "", "startHint": 0, "endHint": 1}') $$);
INSERT INTO ref SELECT 'draft', c.id::text FROM collaboration.comment c WHERE c.thread_id = pg_temp.id('thread');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.mark_work_items_seen('doc-a', ARRAY['comment'], ARRAY[%L]::uuid[]) $$, pg_temp.id('draft'))),
  '0', 'a draft the student cannot read is not recorded as seen');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*)::text FROM collaboration.publish_comments('doc-a') $$), '1', 'Vesna publishes it');
SELECT is(pg_temp.ask('ana', format($$ SELECT item_kind FROM collaboration.mark_work_items_seen('doc-a', ARRAY['comment'], ARRAY[%L]::uuid[]) $$, pg_temp.id('draft'))),
  'comment', 'the published comment is recorded as seen');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(item_kind, ',') FROM collaboration.list_work_items_seen_by_student('doc-a') $$), 'comment',
  'Vesna, its author, sees that Ana has seen it');
SELECT is(pg_temp.ask('marko', format($$ SELECT string_agg(item_kind, ',' ORDER BY item_kind) FROM collaboration.list_work_items_seen_by_student(%L) $$, pg_temp.mdoc())),
  'message,milestone_revision', 'the marks of another work stay on it');

-- 5. Approved stages move the overview on; an ended mentorship leaves it.
SELECT is(substr(pg_temp.ask('ana', format('SELECT state FROM app.submit_work_milestone(%L, %L::uuid)', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000301')), 1, 9),
  'submitted', 'Ana submits the revision');
SELECT is(pg_temp.ask('marko', format('SELECT state FROM app.approve_work_milestone(%L, %L::uuid, NULL)', pg_temp.mdoc(), '00000000-0000-4000-8000-000000000301')),
  'approved', 'Marko approves the first stage');
SELECT is(pg_temp.overview('marko'), 't|t|f|master_thesis|Poglavlje|2|2|not_submitted|student|40|0',
  'the second stage is now the current one, forty days to its deadline');
SET LOCAL ROLE ductus_identity;
UPDATE institution.mentorship SET ended_at = now() WHERE id = pg_temp.id('ms1');
RESET ROLE;
SELECT is(pg_temp.overview('marko'), 'empty', 'an ended mentorship leaves the overview');

-- 6. Retention: the note and the marks go with the work.
SELECT is(pg_temp.ask_as('ductus_retention', 'ana', format('SELECT ''done'' FROM (SELECT collaboration.delete_work_self_notes(%L, %L::uuid)) x', pg_temp.mdoc(), pg_temp.id('fak_a'))), 'done',
  'the retention role deletes the notes of a work');
SELECT is(pg_temp.ask_as('ductus_retention', 'ana', format('SELECT ''done'' FROM (SELECT collaboration.delete_work_items_seen(%L, %L::uuid)) x', pg_temp.mdoc(), pg_temp.id('fak_a'))), 'done',
  'and its seen marks');
SELECT is((SELECT count(*) FROM collaboration.work_self_note WHERE document_id = pg_temp.mdoc()), 0::bigint, 'no note of the work is left');
SELECT is((SELECT count(*) FROM collaboration.work_item_seen WHERE document_id = pg_temp.mdoc()), 0::bigint, 'no mark of the work is left');
SELECT is((SELECT count(*) FROM collaboration.work_item_seen WHERE document_id = 'doc-a'), 1::bigint, 'the marks of another work stay');

SELECT * FROM finish();
ROLLBACK;
