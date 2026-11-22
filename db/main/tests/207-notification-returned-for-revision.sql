-- SRV-1607: the student is told when the teacher returns the work for revision. The
-- notification is written with the return, in the same transaction: one per return,
-- none when the return is refused, visible only to the student owner (C-23). Every
-- person and date is invented (fixtures/institution.inc: Vesna teaches K1, Ana and
-- Dora study in it, Marko teaches another course, Tomo is of another institution).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.back(p_actor text, p_doc text DEFAULT 'doc-a', p_comment text DEFAULT 'Doradi uvod.',
                             p_due text DEFAULT 'NULL')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.return_work_for_revision(%L, %L, %s)', p_doc, p_comment, p_due))
$$;
CREATE FUNCTION pg_temp.inbox(p_actor text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.ask(p_actor, $$ SELECT count(*)::text FROM institution.list_revision_notifications(NULL) $$)
$f$;

-- 1. Catalogue.
SELECT is((SELECT concat_ws(' ', pg_get_userbyid(p.proowner), p.prosecdef::text, 'search_path=""' = ANY (p.proconfig))
             FROM pg_proc p WHERE p.oid = 'institution.list_revision_notifications(uuid)'::regprocedure),
  'ductus_identity true t', 'the list: identity owner, SECURITY DEFINER, empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['institution.list_revision_notifications(uuid)',
                              'app.notify_work_returned(uuid,uuid,uuid)',
                              'app.notify_submission_return()']) f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  ARRAY['ductus_app institution.list_revision_notifications(uuid)',
        'ductus_evidence app.notify_work_returned(uuid,uuid,uuid)',
        'ductus_evidence app.notify_submission_return()'],
  'who executes what, besides the owners');
SELECT is((SELECT count(*)::int FROM pg_trigger
            WHERE tgrelid = 'evidence.submission_return'::regclass AND tgname = 'submission_return_notify'), 1,
  'the return has its notification trigger');
SELECT has_function('app', 'return_work_for_revision', ARRAY['text', 'text', 'timestamptz'], 'the RPC is unchanged');

-- 2. Ana's submission, recorded and not yet returned.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
                       repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 1) $$),
  'requested 1', 'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');
SELECT is((SELECT count(*)::int FROM institution.notification WHERE kind = 'returned_for_revision'), 0,
  'nothing yet: the work was only submitted');

-- 3. A refused return writes no notification.
SELECT is(pg_temp.back(a.name), a.result, a.name || ': ' || a.result)
FROM (VALUES ('anon', 'unauthorized'), ('ana', 'forbidden'), ('dora', 'not_found'), ('marko', 'not_found'),
             ('tomo', 'not_found')) AS a (name, result);
SELECT is(pg_temp.back('vesna', 'doc-a', ''), 'invalid', 'a blank comment is refused');
SELECT is((SELECT count(*)::int FROM institution.notification WHERE kind = 'returned_for_revision'), 0,
  'no notification when the return fails');

-- 4. The return writes exactly one, for the student owner.
SELECT is(pg_temp.back('vesna', 'doc-a', 'Doradi uvod.', $$'2027-01-15T12:00:00Z'$$), 'returned',
  'Vesna returns the work with a comment and a new due date');
SELECT is((SELECT count(*)::int FROM institution.notification WHERE kind = 'returned_for_revision'), 1,
  'one notification for the return');
SELECT is((SELECT concat_ws(' ', recipient_id = pg_temp.id('ana'), read_at IS NULL,
                            event_key = 'returned_for_revision:' || (SELECT id FROM evidence.submission_return),
                            target_id = (SELECT assignment_id FROM evidence.submission_return))
             FROM institution.notification WHERE kind = 'returned_for_revision'),
  't t t t', 'for Ana, unread, keyed by the return, aimed at the assignment');
SELECT is(pg_temp.back('vesna'), 'not_submitted', 'returning again is refused');
SELECT is((SELECT count(*)::int FROM institution.notification WHERE kind = 'returned_for_revision'), 1,
  'still one notification');
SELECT lives_ok(
  $$ SELECT app.notify_work_returned(r.id, r.principal_id, r.assignment_id) FROM evidence.submission_return r $$,
  'the same return noted twice');
SELECT is((SELECT count(*)::int FROM institution.notification WHERE kind = 'returned_for_revision'), 1,
  'is still one notification (the key is unique per recipient)');

-- 5. Who sees it.
SELECT is(pg_temp.inbox('ana'), '1', 'Ana sees it');
SELECT is(pg_temp.inbox('vesna'), '0', 'the teacher does not');
SELECT is(pg_temp.inbox('dora'), '0', 'another student does not');
SELECT is(pg_temp.inbox('marko'), '0', 'a teacher of another course does not');
SELECT is(pg_temp.inbox('tomo'), '0', 'a person of another institution does not');
SELECT is(pg_temp.ask('ana', $$ SELECT (comment || ' ' || (revision_due_at IS NOT NULL)::text || ' ' || document_id)
  FROM institution.list_revision_notifications(NULL) n JOIN evidence.submission_return r ON r.id = n.return_id $$),
  'Doradi uvod. true doc-a', 'Ana reads the comment, the new due date and the work through the return');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*)::text FROM institution.list_revision_notifications(NULL) n
  JOIN evidence.submission_return r ON r.id = n.return_id $$), '0', 'the return itself is hidden from Dora');
SELECT matches(pg_temp.ask('dora', format(
    'SELECT * FROM institution.list_revision_notifications(%L)', (SELECT id FROM institution.notification
      WHERE kind = 'returned_for_revision'))), '^ZD403',
  'another student cannot use the notification as a cursor');
SELECT is(pg_temp.ask('anon', $$ SELECT count(*)::text FROM institution.list_revision_notifications(NULL) $$) ~ '^ZD401',
  'true', 'without a session it is refused');
SELECT is(pg_temp.ask('ana', format('SELECT institution.read_notification(%L)::text',
    (SELECT id FROM institution.notification WHERE kind = 'returned_for_revision'))), 'true',
  'Ana marks it read with the existing read route');
SELECT is(pg_temp.ask('dora', format('SELECT institution.read_notification(%L)::text',
    (SELECT id FROM institution.notification WHERE kind = 'returned_for_revision'))), 'false',
  'Dora cannot');

-- 6. The web role cannot write the inbox.
SELECT matches(pg_temp.ask_as('ductus_app', 'ana', $$ INSERT INTO institution.notification
  (institution_id, recipient_id, kind, event_key, target_id)
  SELECT institution_id, recipient_id, kind, 'returned_for_revision:' || gen_random_uuid(), target_id
    FROM institution.notification $$), '^42501', 'the web role cannot write a notification');

SELECT * FROM finish();
ROLLBACK;
