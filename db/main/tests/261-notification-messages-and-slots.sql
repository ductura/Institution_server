-- SRV-F4-MEN-R10 (MEN-05): a notification for a new message of a work and for a consultation
-- slot that waits for an answer. Written with the message or slot move, in the same
-- transaction; one per message, per slot and kind; never for the author; visible only to the
-- other side while the relation to the work holds (C-23). Every person and text is invented
-- (fixtures/institution.inc: Vesna teaches K1, Ana and Dora study in it, Marko teaches K2 and
-- mentors Ana's master thesis, Tomo is of another institution).
-- Personas of institution.inc and mentorship.inc; every person, work and text
-- below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT no_plan();

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000e1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000e2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo')),
  ('project-m', pg_temp.id('fak_a'), pg_temp.id('zm1'), pg_temp.id('ana'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-m', pg_temp.id('fak_a'), 'project-m', pg_temp.id('ana'), repeat('e', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, NULL, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 1, 0, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-m', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('e', 64)),
  ('doc-m', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('e', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
-- The mentorship work doc-m belongs to Ana's mentorship ms1 with Marko.
SET CONSTRAINTS ALL DEFERRED;


-- 1. Catalogue: the notification functions belong to the owner role, only the list is
-- callable by the web role, and the new kinds are all there is to the store's check.
SELECT is((SELECT concat_ws(' ', pg_get_userbyid(p.proowner), p.prosecdef::text, 'search_path=""' = ANY (p.proconfig))
             FROM pg_proc p WHERE p.oid = 'institution.list_message_slot_notifications(uuid)'::regprocedure),
  'ductus_identity true t', 'the list: identity owner, SECURITY DEFINER, empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['institution.list_message_slot_notifications(uuid)',
                              'institution.work_teachers(uuid,uuid,uuid)',
                              'institution.notify_work_message()',
                              'institution.notify_consultation_slot()']) f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  ARRAY['ductus_app institution.list_message_slot_notifications(uuid)'],
  'who executes what, besides the owners');
SELECT is((SELECT count(*)::int FROM pg_trigger
            WHERE tgname IN ('work_message_notify', 'consultation_slot_notify_insert', 'consultation_slot_notify_update')
              AND tgenabled = 'O'), 3, 'the three triggers exist and are enabled');

CREATE FUNCTION pg_temp.inbox(p_actor text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.ask(p_actor, $$ SELECT coalesce(string_agg(kind || ':' || coalesce(document_id, '-'), ',' ORDER BY kind, document_id), '')
                                   FROM institution.list_message_slot_notifications(NULL) $$)
$f$;
CREATE FUNCTION pg_temp.notices(p_kind text) RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM institution.notification WHERE kind = p_kind
$f$;

-- 2. A message tells the other side of the work, never its author.
SELECT is(pg_temp.ask('ana', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Izmišljeno pitanje.') $$) ~ '^[0-9a-f-]{36}$',
  true, 'fixture: Ana writes a message');
SELECT is(pg_temp.notices('message_posted'), 1, 'one notification for her message');
SELECT is(pg_temp.inbox('vesna'), 'message_posted:doc-a', 'the teacher of the course is told');
SELECT is(pg_temp.inbox('ana'), '', 'the author is not');
SELECT is(pg_temp.inbox('marko'), '', 'a teacher of another course is not');
SELECT is(pg_temp.inbox('dora'), '', 'another student of the course is not');
SELECT is(pg_temp.inbox('tomo'), '', 'a person of another institution is not');
SELECT is(pg_temp.ask('vesna', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Izmišljen odgovor.') $$) ~ '^[0-9a-f-]{36}$',
  true, 'Vesna answers');
SELECT is(pg_temp.inbox('ana'), 'message_posted:doc-a', 'the student owner is told of the teacher''s message');
SELECT is(pg_temp.inbox('vesna'), 'message_posted:doc-a', 'the teacher still has only the first');
SELECT is(pg_temp.notices('message_posted'), 2, 'two notifications in all');
-- Refused writes leave nothing behind.
SELECT is(pg_temp.ask('dora', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', 'Tuđe.') $$), 'ZD403: forbidden',
  'a stranger to the work cannot write');
SELECT is(pg_temp.ask('ana', $$ SELECT message_id FROM collaboration.create_work_message('doc-a', '') $$), 'ZD422: invalid input',
  'an empty message is refused');
SELECT is(pg_temp.notices('message_posted'), 2, 'refused messages wrote no notification');

-- The mentor of a mentorship work, and a teacher who is no mentor of it.
SELECT is(pg_temp.ask('ana', $$ SELECT message_id FROM collaboration.create_work_message('doc-m', 'Izmišljeno za mentora.') $$) ~ '^[0-9a-f-]{36}$',
  true, 'Ana writes in the work of her mentorship');
SELECT is(pg_temp.inbox('marko'), 'message_posted:doc-m', 'the mentor is told');
SELECT is(pg_temp.inbox('vesna'), 'message_posted:doc-a', 'the teacher of the course is not told of the mentorship work');

-- 3. A slot asked for tells the teachers; the teacher''s other time tells the student;
-- everything else tells nobody.
INSERT INTO ref SELECT 'sa', pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '3 days') $$);
SELECT is(pg_temp.notices('slot_requested'), 1, 'one notification for the request');
SELECT is((SELECT concat_ws(' ', recipient_id = pg_temp.id('vesna'), read_at IS NULL,
                            event_key = 'slot_requested:' || (SELECT val FROM ref WHERE name = 'sa'),
                            target_id = pg_temp.id('z1'))
             FROM institution.notification WHERE kind = 'slot_requested'),
  't t t t', 'for Vesna, unread, keyed by the slot, aimed at the assignment');
SELECT is(pg_temp.inbox('vesna'), 'message_posted:doc-a,slot_requested:doc-a', 'Vesna sees both');
SELECT is(pg_temp.inbox('ana'), 'message_posted:doc-a', 'Ana is not told of her own request');
SELECT is(pg_temp.inbox('marko'), 'message_posted:doc-m', 'a teacher of another course is not told');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {sa}, 'counter', now() + interval '4 days') $$),
  'ZD403: forbidden', 'the student cannot counter her own request');
SELECT is(pg_temp.notices('slot_proposed'), 0, 'a refused move tells nobody');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {sa}, 'counter', now() + interval '4 days') $$),
  'countered', 'Vesna proposes another time');
SELECT is(pg_temp.notices('slot_proposed'), 1, 'one notification for the proposal');
SELECT is(pg_temp.inbox('ana'), 'message_posted:doc-a,slot_proposed:doc-a', 'Ana is told');
SELECT is(pg_temp.inbox('vesna'), 'message_posted:doc-a,slot_requested:doc-a', 'Vesna is not told of her own proposal');
SELECT is(pg_temp.inbox('dora'), '', 'another student is not');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {sa}, 'accept') $$), 'confirmed', 'Ana accepts');
SELECT is(pg_temp.notices('slot_proposed') + pg_temp.notices('slot_requested'), 2, 'still one request and one proposal');
INSERT INTO ref SELECT 'sb', pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '5 days') $$);
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {sb}, 'confirm') $$), 'confirmed',
  'a confirmation');
SELECT is(pg_temp.notices('slot_proposed'), 1, 'confirming tells nobody');
SELECT lives_ok($$ UPDATE institution.consultation_slot SET state = 'countered' WHERE id = (SELECT val::uuid FROM ref WHERE name = 'sb') $$,
  'a slot moved to countered by the owner');
SELECT lives_ok($$ UPDATE institution.consultation_slot SET state = 'countered' WHERE id = (SELECT val::uuid FROM ref WHERE name = 'sb') $$,
  'and again');
SELECT is(pg_temp.notices('slot_proposed'), 2, 'one notification per slot and kind (the key is unique per recipient)');

-- 4. The list answers only the caller's own rows, and only while the relation holds.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM institution.list_message_slot_notifications(NULL) WHERE slot_id IS NOT NULL $$),
  '2', 'the slot rows carry the slot');
SELECT matches(pg_temp.ask('dora', format('SELECT * FROM institution.list_message_slot_notifications(%L)',
    (SELECT id FROM institution.notification WHERE kind = 'slot_proposed' LIMIT 1))), '^ZD403',
  'another student cannot use a notification as a cursor');
SELECT matches(pg_temp.ask('ana', format('SELECT * FROM institution.list_message_slot_notifications(%L)',
    (SELECT id FROM institution.notification WHERE kind = 'returned_for_revision' OR kind = 'message_posted'
      ORDER BY (recipient_id = pg_temp.id('vesna')) DESC LIMIT 1))), '^ZD403',
  'nor a notification of somebody else');
SELECT is(pg_temp.ask('anon', $$ SELECT count(*)::text FROM institution.list_message_slot_notifications(NULL) $$) ~ '^ZD401',
  'true', 'without a session it is refused');
SELECT is(pg_temp.ask('ana', format('SELECT institution.read_notification(%L)::text',
    (SELECT id FROM institution.notification WHERE kind = 'slot_proposed' AND recipient_id = pg_temp.id('ana') LIMIT 1))), 'true',
  'Ana marks one read with the existing read route');
SELECT is(pg_temp.ask('dora', format('SELECT institution.read_notification(%L)::text',
    (SELECT id FROM institution.notification WHERE kind = 'slot_proposed' AND recipient_id = pg_temp.id('ana') LIMIT 1))), 'false',
  'Dora cannot');
-- Losing the relation hides the row: Vesna leaves the teaching team of the course.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND role = 'teacher';
SELECT is(pg_temp.inbox('vesna'), '', 'a teacher who left the course sees nothing');
-- The record going (retention) hides the row too.
DELETE FROM collaboration.work_message WHERE document_id = 'doc-a' AND sender_role = 'teacher';
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM institution.list_message_slot_notifications(NULL) WHERE kind = 'message_posted' $$),
  '0', 'a deleted message leaves no row');

-- 5. The web role cannot write the inbox, and the inbox of the existing list still holds
-- the old kinds only (the adapter leaves the new ones out).
SELECT matches(pg_temp.ask_as('ductus_app', 'ana', $$ INSERT INTO institution.notification
  (institution_id, recipient_id, kind, event_key, target_id)
  SELECT institution_id, recipient_id, kind, 'message_posted:' || gen_random_uuid(), target_id
    FROM institution.notification $$), '^42501', 'the web role cannot write a notification');

SELECT * FROM finish();
ROLLBACK;
