-- SRV-V16-TEMA-PRIJEDLOG: the student proposes the topic of a thesis, the mentor
-- approves or returns it. Personas of mentorship.inc, all invented: Ana writes
-- zm1 (a master thesis) under her mentor Marko; Iva is the administrator of
-- fak-a, Lea of fak-b; Vesna teaches the course of z1 (doc-a); Dora is another
-- student; Nina has an unconfirmed role.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- Tables only through the RPCs, records only ever added.
SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid IN ('institution.work_thesis_topic_version'::regclass,
    'institution.work_thesis_topic_decision'::regclass);
SELECT ok(NOT has_table_privilege('ductus_app', name, 'SELECT,INSERT,UPDATE,DELETE'), 'only RPC access to ' || name)
  FROM (VALUES ('institution.work_thesis_topic_version'), ('institution.work_thesis_topic_decision')) AS t(name);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('ductus_evidence'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_work_thesis_topic(text)', 'app.read_work_thesis_topic_history(text)',
    'app.set_work_thesis_topic(text,text,text)', 'app.decide_work_thesis_topic(text,integer,text,text)',
    'institution.thesis_topic_now(text)']) AS f;
SELECT ok(has_function_privilege('ductus_app', f, 'EXECUTE'), 'the web role calls ' || f)
  FROM unnest(ARRAY['app.read_work_thesis_topic(text)', 'app.read_work_thesis_topic_history(text)',
    'app.set_work_thesis_topic(text,text,text)', 'app.decide_work_thesis_topic(text,integer,text,text)']) AS f;
SELECT ok(NOT has_function_privilege('ductus_app', 'institution.thesis_topic_now(text)', 'EXECUTE'),
  'the web role does not call the internal reader (an internal helper)');

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 8),
  'opened', 'Ana opens her mentored work');

CREATE FUNCTION pg_temp.topic(p_actor text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, state, coalesce(version::text, %L), coalesce(title, %L), coalesce(summary, %L), coalesce(decision, %L), coalesce(decision_comment, %L)) FROM app.read_work_thesis_topic(%L)',
    '|', '-', '-', '-', '-', '-', coalesce(p_doc, pg_temp.mdoc())))
$$;
CREATE FUNCTION pg_temp.propose(p_actor text, p_title text, p_summary text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, state, version, title, summary) FROM app.set_work_thesis_topic(%L, %L, %L)',
    '|', coalesce(p_doc, pg_temp.mdoc()), p_title, p_summary))
$$;
CREATE FUNCTION pg_temp.decide(p_actor text, p_version integer, p_decision text, p_comment text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, state, version, decision, coalesce(decision_comment, %L)) FROM app.decide_work_thesis_topic(%L, %L, %L, %L)',
    '|', '-', coalesce(p_doc, pg_temp.mdoc()), p_version, p_decision, p_comment))
$$;
CREATE FUNCTION pg_temp.versions(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(version || %L || title, %L ORDER BY version), %L) FROM app.read_work_thesis_topic_history(%L)',
    ':', ',', 'empty', pg_temp.mdoc()))
$$;

-- Who has a part in the work.
SELECT is(pg_temp.topic(a), 'none|-|-|-|-|-', a || ' reads no topic yet') FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.topic('anon'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.topic(a), 'ZD404: not found', a || ' has no part in the work')
  FROM (VALUES ('dora'), ('vesna'), ('nina'), ('lea'), ('petra'), ('tomo')) AS t(a);
SELECT is(pg_temp.topic(a, 'doc-a'), 'ZD404: not found', a || ': a course work has no thesis topic')
  FROM (VALUES ('ana'), ('vesna'), ('iva')) AS t(a);
SELECT is(pg_temp.topic('ana', 'no-such-document'), 'ZD404: not found', 'an unknown work');
SELECT is(pg_temp.versions('dora'), 'ZD404: not found', 'a stranger reads no history');
SELECT is(pg_temp.versions('ana'), 'empty', 'no history yet');

-- Proposing: the student owner only.
SELECT is(pg_temp.propose(a, 'Izmišljena tema', ''), 'ZD403: forbidden', a || ' cannot propose')
  FROM (VALUES ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.propose(a, 'Izmišljena tema', ''), 'ZD404: not found', a || ' has no part, so 404 before anything')
  FROM (VALUES ('dora'), ('vesna'), ('lea')) AS t(a);
SELECT is(pg_temp.propose('anon', 'Izmišljena tema', ''), 'ZD401: not authenticated', 'proposing needs a session');
SELECT is(pg_temp.propose('ana', t, s), 'ZD422: invalid input', why)
  FROM (VALUES ('   ', '', 'the title is not blank'),
               ('', '', 'the title is not empty'),
               ('Naslov' || chr(10) || 'drugi', '', 'the title is one line'),
               (repeat('a', 201), '', 'the title is at most 200 characters'),
               ('Naslov', repeat('b', 1001), 'the summary is at most 1000 characters'),
               ('Naslov', '   ', 'a summary is not only blanks'),
               ('Naslov', 'Opis' || chr(7), 'no control character in the summary')) AS x(t, s, why);
SELECT is(pg_temp.ask('ana', format('SELECT state FROM app.set_work_thesis_topic(%L, NULL, NULL)', pg_temp.mdoc())),
  'ZD422: invalid input', 'the title is required');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_topic_version), 0, 'a refused proposal writes nothing');
SELECT is(pg_temp.propose('ana', repeat('a', 200), repeat('b', 1000)),
  'proposed|1|' || repeat('a', 200) || '|' || repeat('b', 1000), 'the limits themselves are allowed');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema prva', 'Izmišljeni kratak opis.'),
  'proposed|2|Izmišljena tema prva|Izmišljeni kratak opis.', 'Ana proposes: a new version');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema prva', 'Izmišljeni kratak opis.'),
  'proposed|2|Izmišljena tema prva|Izmišljeni kratak opis.', 'the same content writes nothing');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_topic_version), 2, 'two versions so far');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema prva', NULL), 'proposed|3|Izmišljena tema prva|',
  'a missing summary is the empty one, which differs from the last');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema prva', ''), 'proposed|3|Izmišljena tema prva|', 'and the empty summary is the same content');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema prva', 'Izmišljeni kratak opis.'),
  'proposed|4|Izmišljena tema prva|Izmišljeni kratak opis.', 'going back to an older text is a new version');

-- Everyone with a part reads it; the history is in order.
SELECT is(pg_temp.topic(a), 'proposed|4|Izmišljena tema prva|Izmišljeni kratak opis.|-|-', a || ' reads the proposal')
  FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.ask(a, format('SELECT string_agg(version::text, %L ORDER BY version) FROM app.read_work_thesis_topic_history(%L)', ',', pg_temp.mdoc())),
  '1,2,3,4', a || ' reads the history in order') FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);

-- Deciding: the mentor only, on the newest version.
SELECT is(pg_temp.decide(a, 4, 'approved', NULL), 'ZD403: forbidden', a || ' cannot decide') FROM (VALUES ('ana'), ('iva')) AS t(a);
SELECT is(pg_temp.decide(a, 4, 'approved', NULL), 'ZD404: not found', a || ' has no part, so 404')
  FROM (VALUES ('dora'), ('vesna'), ('lea'), ('nina')) AS t(a);
SELECT is(pg_temp.decide('anon', 4, 'approved', NULL), 'ZD401: not authenticated', 'deciding needs a session');
SELECT is(pg_temp.decide('marko', 4, 'returned', NULL), 'ZD422: invalid input', 'returning needs a comment');
SELECT is(pg_temp.decide('marko', 4, 'returned', '   '), 'ZD422: invalid input', 'and not a blank one');
SELECT is(pg_temp.decide('marko', 4, 'prihvaceno', NULL), 'ZD422: invalid input', 'an unknown decision');
SELECT is(pg_temp.decide('marko', 0, 'approved', NULL), 'ZD422: invalid input', 'a version is at least 1');
SELECT is(pg_temp.decide('marko', 4, 'approved', repeat('c', 1001)), 'ZD422: invalid input', 'a comment is at most 1000 characters');
SELECT is(pg_temp.ask('marko', format('SELECT state FROM app.decide_work_thesis_topic(%L, NULL, %L, NULL)', pg_temp.mdoc(), 'approved')),
  'ZD422: invalid input', 'the version is required');
SELECT is(pg_temp.decide('marko', 3, 'approved', NULL), 'ZD409: conflict', 'a decision on an old version');
SELECT is(pg_temp.decide('marko', 5, 'approved', NULL), 'ZD409: conflict', 'or on a version that does not exist');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_topic_decision), 0, 'a refused decision writes nothing');
SELECT is(pg_temp.decide('marko', 4, 'returned', 'Izmišljeni komentar: suzite temu.'),
  'returned|4|returned|Izmišljeni komentar: suzite temu.', 'the mentor returns it with a comment');
SELECT is(pg_temp.topic('ana'), 'returned|4|Izmišljena tema prva|Izmišljeni kratak opis.|returned|Izmišljeni komentar: suzite temu.',
  'the student sees the decision and the comment');
SELECT is(pg_temp.decide('marko', 4, 'approved', NULL), 'ZD409: conflict', 'a returned version is not approved afterwards');
SELECT is(pg_temp.decide('marko', 4, 'returned', 'Opet.'), 'ZD409: conflict', 'nor returned twice');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema druga', 'Uža tema.'), 'proposed|5|Izmišljena tema druga|Uža tema.',
  'returned -> proposed: the student proposes again');
SELECT is(pg_temp.topic('marko'), 'proposed|5|Izmišljena tema druga|Uža tema.|-|-', 'the decision belongs to the old version');
SELECT is(pg_temp.decide('marko', 4, 'approved', NULL), 'ZD409: conflict', 'the old version cannot be decided on now');
SELECT is(pg_temp.decide('marko', 5, 'approved', NULL), 'approved|5|approved|-', 'the mentor approves, a comment is optional');
SELECT is(pg_temp.decide('marko', 5, 'approved', 'Opet.'), 'ZD409: conflict', 'approving twice');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema treća', ''), 'ZD409: conflict', 'after approval the student cannot propose');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema druga', 'Uža tema.'), 'ZD409: conflict', 'not even the same content');
SELECT is(pg_temp.propose('marko', 'Izmišljena tema treća', ''), 'ZD403: forbidden', 'and the mentor never proposes');
SELECT is(pg_temp.decide('marko', 5, 'returned', NULL), 'ZD422: invalid input', 'taking an approval back needs a reason');
SELECT is(pg_temp.decide('marko', 5, 'returned', 'Izmišljen razlog: tema se preklapa.'),
  'returned|5|returned|Izmišljen razlog: tema se preklapa.', 'approved -> returned, by the mentor with a reason');
SELECT is(pg_temp.propose('ana', 'Izmišljena tema treća', ''), 'proposed|6|Izmišljena tema treća|', 'the student proposes again');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_topic_decision), 3, 'three decisions recorded');
SELECT is(pg_temp.versions('iva'), '1:' || repeat('a', 200) || ',2:Izmišljena tema prva,3:Izmišljena tema prva,4:Izmišljena tema prva,5:Izmišljena tema druga,6:Izmišljena tema treća',
  'the faculty reads every version');

-- The cap of 100 versions.
INSERT INTO institution.work_thesis_topic_version (institution_id, document_id, version, title, summary, proposed_by)
  SELECT v.institution_id, v.document_id, g, 'Izmišljena verzija ' || g, '', v.proposed_by
    FROM institution.work_thesis_topic_version v, generate_series(7, 100) g WHERE v.version = 1;
SELECT is(pg_temp.propose('ana', 'Još jedna', ''), 'ZD409: conflict', 'the 101st version is refused');

-- Nothing of the topic touches the faculty form or the content of the work.
SELECT is((SELECT count(*)::int FROM institution.work_thesis_form_event), 0, 'the form prijava-teme is untouched');

-- Another faculty's administrator and a student of another institution see nothing, 404 not 403.
SELECT is(pg_temp.topic('lea'), 'ZD404: not found', 'the administrator of another faculty');
SELECT is(pg_temp.decide('lea', 100, 'approved', NULL), 'ZD404: not found', 'cannot decide either');

-- Every record is only ever added, for the owner too.
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', format(stmt, tbl)), 'ZD409: conflict', format(what, tbl))
  FROM unnest(ARRAY['work_thesis_topic_version', 'work_thesis_topic_decision']) AS tbl
  CROSS JOIN (VALUES ('UPDATE institution.%I SET id = id', '%s cannot be updated'),
                     ('DELETE FROM institution.%I', '%s cannot be deleted'),
                     ('TRUNCATE institution.%I', '%s cannot be truncated')) AS t(stmt, what)
  WHERE NOT (stmt LIKE 'TRUNCATE%' AND tbl = 'work_thesis_topic_version');

SELECT * FROM finish();
ROLLBACK;
