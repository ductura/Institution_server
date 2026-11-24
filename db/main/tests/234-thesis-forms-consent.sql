-- SRV-MENTOR-2: the forms of the faculty for a thesis, the state of each form of
-- one work, the mentor's consent to the submission and the stage after the
-- submission. Personas of institution.inc and mentorship.inc, all invented:
-- Ana writes zm1 (a master thesis) under her mentor Marko (ms1); Iva is the
-- administrator of fak-a, Lea of fak-b; Vesna teaches the course of z1 (doc-a,
-- Ana's work in a course); Dora is another student; Nina has an unconfirmed role.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- Tables only through the RPCs, records only ever added.
SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid IN ('institution.thesis_form'::regclass, 'institution.thesis_setting'::regclass,
    'institution.work_thesis_form_event'::regclass, 'institution.work_mentor_consent_event'::regclass,
    'institution.work_thesis_stage_event'::regclass);
SELECT ok(NOT has_table_privilege('ductus_app', name, 'SELECT,INSERT,UPDATE,DELETE'), 'only RPC access to ' || name)
  FROM (VALUES ('institution.thesis_form'), ('institution.thesis_setting'), ('institution.work_thesis_form_event'),
               ('institution.work_mentor_consent_event'), ('institution.work_thesis_stage_event')) AS t(name);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('ductus_evidence'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_thesis_forms()', 'app.publish_thesis_form(text,text,text[],boolean)',
    'app.read_thesis_setting()', 'app.set_thesis_setting(boolean)', 'app.read_work_thesis_forms(text)',
    'app.set_work_thesis_form_state(text,text,text)', 'app.read_work_mentor_consent(text)',
    'app.read_work_mentor_consent_events(text)', 'app.set_work_mentor_consent(text,boolean,text)',
    'app.read_work_thesis_stage(text)', 'app.set_work_thesis_stage(text,text,timestamptz)']) AS f;
SELECT ok(has_function_privilege('ductus_app', f, 'EXECUTE'), 'the web role calls ' || f)
  FROM unnest(ARRAY['app.read_thesis_forms()', 'app.publish_thesis_form(text,text,text[],boolean)',
    'app.set_work_mentor_consent(text,boolean,text)', 'app.set_work_thesis_stage(text,text,timestamptz)']) AS f;

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 8),
  'opened', 'Ana opens her mentored work');

-- (a) The catalogue of the faculty.
CREATE FUNCTION pg_temp.publish(p_actor text, p_code text, p_title text, p_types text, p_active boolean DEFAULT true) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, code, version, title, array_to_string(work_types, %L), active) FROM app.publish_thesis_form(%L, %L, %L::text[], %L)',
    '|', '+', p_code, p_title, p_types, p_active))
$$;
CREATE FUNCTION pg_temp.catalogue(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(code || %L || version || %L || active, %L ORDER BY code), %L) FROM app.read_thesis_forms()',
    ':', ':', ',', 'empty'))
$$;
SELECT is(pg_temp.catalogue('ana'), 'empty', 'no form before the administrator publishes one');
SELECT is(pg_temp.catalogue('anon'), 'ZD401: not authenticated', 'the catalogue needs a session');
SELECT is(pg_temp.publish(a, 'prijava-teme', 'Prijava teme', '{master_thesis}'), 'ZD403: forbidden', a || ' cannot publish a form')
  FROM (VALUES ('marko'), ('ana'), ('vesna')) AS t(a);
SELECT is(pg_temp.publish('iva', c, t, w), 'ZD422: invalid input', why)
  FROM (VALUES ('Prijava', 'Prijava teme', '{master_thesis}', 'the code is lower case'),
               ('prijava-teme', '   ', '{master_thesis}', 'the title is not blank'),
               ('prijava-teme', 'Prijava' || chr(10) || 'teme', '{master_thesis}', 'the title is one line'),
               ('prijava-teme', 'Prijava teme', '{}', 'at least one work type'),
               ('prijava-teme', 'Prijava teme', '{essay}', 'only thesis work types'),
               ('prijava-teme', 'Prijava teme', '{master_thesis,master_thesis}', 'no work type twice')) AS x(c, t, w, why);
SELECT is(pg_temp.publish('iva', 'prijava-teme', 'Prijava teme', '{master_thesis,bachelor_thesis}'),
  'prijava-teme|1|Prijava teme|bachelor_thesis+master_thesis|t', 'Iva publishes version 1 of a form');
SELECT is(pg_temp.publish('iva', 'izjava-o-izvornosti', 'Izjava o izvornosti rada', '{master_thesis}'),
  'izjava-o-izvornosti|1|Izjava o izvornosti rada|master_thesis|t', 'the official name of the statement form');
SELECT is(pg_temp.publish('iva', 'izjava-o-pohrani', 'Izjava o pohrani', '{bachelor_thesis}'),
  'izjava-o-pohrani|1|Izjava o pohrani|bachelor_thesis|t', 'a form only for a bachelor thesis');
SELECT is(pg_temp.publish('iva', 'stari-obrazac', 'Stari obrazac', '{master_thesis}'),
  'stari-obrazac|1|Stari obrazac|master_thesis|t', 'a form that will be retired');
SELECT is(pg_temp.publish('iva', 'prijava-teme', 'Prijava teme (izmišljena verzija 2)', '{master_thesis}'),
  'prijava-teme|2|Prijava teme (izmišljena verzija 2)|master_thesis|t', 'a new version of the same code');
SELECT is(pg_temp.catalogue('ana'), 'izjava-o-izvornosti:1:true,izjava-o-pohrani:1:true,prijava-teme:2:true,stari-obrazac:1:true',
  'everyone signed in at the faculty reads the forms in force');
SELECT is(pg_temp.catalogue('lea'), 'empty', 'another faculty sees none of them');
SELECT is(pg_temp.publish('lea', 'prijava-teme', 'Prijava teme', '{master_thesis}'),
  'prijava-teme|1|Prijava teme|master_thesis|t', 'another faculty has its own versions');

-- The faculty's switch: off by default, the administrator only.
SELECT is(pg_temp.ask('iva', 'SELECT mentor_consent_required::text FROM app.read_thesis_setting()'), 'false', 'off by default');
SELECT is(pg_temp.ask(a, 'SELECT mentor_consent_required::text FROM app.read_thesis_setting()'), 'ZD403: forbidden', a || ' does not read the setting')
  FROM (VALUES ('marko'), ('ana')) AS t(a);
SELECT is(pg_temp.ask('marko', 'SELECT mentor_consent_required::text FROM app.set_thesis_setting(true)'), 'ZD403: forbidden', 'the mentor does not set it');
SELECT is(pg_temp.ask('iva', 'SELECT mentor_consent_required::text FROM app.set_thesis_setting(NULL)'), 'ZD422: invalid input', 'the value is required');
SELECT is(pg_temp.ask('iva', 'SELECT mentor_consent_required::text FROM app.set_thesis_setting(false)'), 'false', 'setting the value in force');
SELECT is((SELECT count(*)::int FROM institution.thesis_setting), 0, 'writes nothing');

-- Who has a part in the work.
CREATE FUNCTION pg_temp.forms(p_actor text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(string_agg(code || %L || state, %L ORDER BY code), %L) FROM app.read_work_thesis_forms(%L)',
    ':', ',', 'empty', coalesce(p_doc, pg_temp.mdoc())))
$$;
CREATE FUNCTION pg_temp.form(p_actor text, p_code text, p_state text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, code, version, state, state_form_version, changed_by_part) FROM app.set_work_thesis_form_state(%L, %L, %L)',
    '|', coalesce(p_doc, pg_temp.mdoc()), p_code, p_state))
$$;
SELECT is(pg_temp.forms(a), 'izjava-o-izvornosti:not_submitted,prijava-teme:not_submitted,stari-obrazac:not_submitted',
  a || ' reads the forms of a master thesis') FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.forms('anon'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.forms(a), 'ZD404: not found', a || ' has no part in the work')
  FROM (VALUES ('dora'), ('vesna'), ('nina'), ('lea'), ('petra'), ('tomo')) AS t(a);
SELECT is(pg_temp.forms(a, 'doc-a'), 'ZD404: not found', a || ': a course work has no thesis forms')
  FROM (VALUES ('ana'), ('vesna'), ('iva')) AS t(a);
SELECT is(pg_temp.forms('ana', 'no-such-document'), 'ZD404: not found', 'an unknown work');

-- (a) The state of a form of the work.
SELECT is(pg_temp.form('ana', 'prijava-teme', 'accepted'), 'ZD403: forbidden', 'the student does not accept');
SELECT is(pg_temp.form('ana', 'prijava-teme', 'odobreno'), 'ZD422: invalid input', 'an unknown state');
SELECT is(pg_temp.form('ana', 'izjava-o-pohrani', 'submitted'), 'ZD404: not found', 'a form of another work type');
SELECT is(pg_temp.form('ana', 'nema-ga', 'submitted'), 'ZD404: not found', 'an unknown form');
SELECT is(pg_temp.form('vesna', 'prijava-teme', 'submitted'), 'ZD404: not found', 'a course teacher has no part');
SELECT is(pg_temp.form('ana', 'prijava-teme', 'submitted'), 'prijava-teme|2|submitted|2|student', 'Ana marks the form as submitted');
SELECT is(pg_temp.form('ana', 'prijava-teme', 'not_submitted'), 'prijava-teme|2|not_submitted|2|student', 'and takes it back');
SELECT is(pg_temp.form('ana', 'prijava-teme', 'submitted'), 'prijava-teme|2|submitted|2|student', 'and submits again');
SELECT is(pg_temp.form('ana', 'prijava-teme', 'submitted'), 'prijava-teme|2|submitted|2|student', 'the state in force writes nothing');
SELECT is(pg_temp.form('marko', 'prijava-teme', 'accepted'), 'prijava-teme|2|accepted|2|mentor', 'the mentor accepts');
SELECT is(pg_temp.form('ana', 'prijava-teme', 'not_submitted'), 'ZD409: conflict', 'the student cannot undo an accepted form');
SELECT is(pg_temp.form('iva', 'izjava-o-izvornosti', 'accepted'), 'izjava-o-izvornosti|1|accepted|1|faculty', 'the faculty accepts a form');
SELECT is(pg_temp.form('iva', 'izjava-o-izvornosti', 'not_submitted'), 'izjava-o-izvornosti|1|not_submitted|1|faculty', 'and corrects it');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_form_event WHERE form_code = 'prijava-teme'), 4,
  'four changes recorded for the topic application');
SELECT is(pg_temp.forms('ana'), 'izjava-o-izvornosti:not_submitted,prijava-teme:accepted,stari-obrazac:not_submitted',
  'the student sees the states');
SELECT is(pg_temp.form('ana', 'stari-obrazac', 'submitted'), 'stari-obrazac|1|submitted|1|student', 'a state on a form');
SELECT is(pg_temp.publish('iva', 'stari-obrazac', 'Stari obrazac', '{master_thesis}', false),
  'stari-obrazac|2|Stari obrazac|master_thesis|f', 'which is then retired');
SELECT is(pg_temp.catalogue('ana'), 'izjava-o-izvornosti:1:true,izjava-o-pohrani:1:true,prijava-teme:2:true', 'a retired form leaves the catalogue');
SELECT is(pg_temp.catalogue('iva'), 'izjava-o-izvornosti:1:true,izjava-o-pohrani:1:true,prijava-teme:2:true,stari-obrazac:2:false',
  'the administrator still sees it');
SELECT is(pg_temp.forms('ana'), 'izjava-o-izvornosti:not_submitted,prijava-teme:accepted,stari-obrazac:submitted',
  'a retired form with a state stays on the work');
SELECT is(pg_temp.form('ana', 'stari-obrazac', 'not_submitted'), 'ZD404: not found', 'but takes no change');

-- (b) The mentor's consent.
CREATE FUNCTION pg_temp.consent(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, state, coalesce(comment, %L), changed_by = %L::uuid, required_for_submission) FROM app.read_work_mentor_consent(%L)',
    '|', '-', pg_temp.id('marko'), pg_temp.mdoc()))
$$;
CREATE FUNCTION pg_temp.give(p_actor text, p_given boolean, p_comment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, state, coalesce(comment, %L)) FROM app.set_work_mentor_consent(%L, %L, %L)',
    '|', '-', pg_temp.mdoc(), p_given, p_comment))
$$;
SELECT is(pg_temp.consent(a), 'none|-|f', a || ' reads no consent yet') FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.consent(a), 'ZD404: not found', a || ' has no part') FROM (VALUES ('dora'), ('vesna'), ('lea')) AS t(a);
SELECT is(pg_temp.give(a, true, NULL), 'ZD403: forbidden', a || ' does not give the consent') FROM (VALUES ('ana'), ('iva')) AS t(a);
SELECT is(pg_temp.give('vesna', true, NULL), 'ZD404: not found', 'a course teacher has no part');
SELECT is(pg_temp.give('marko', false, NULL), 'ZD409: conflict', 'nothing to withdraw');
SELECT is(pg_temp.give('marko', true, '  '), 'ZD422: invalid input', 'a comment is not blank');
SELECT is(pg_temp.give('marko', true, NULL), 'given|-', 'the mentor gives the consent');
SELECT is(pg_temp.give('marko', true, NULL), 'ZD409: conflict', 'not twice');
SELECT is(pg_temp.give('marko', false, 'Izmišljeni razlog: nedostaje zaključak.'), 'withdrawn|Izmišljeni razlog: nedostaje zaključak.', 'and withdraws it with a comment');
SELECT is(pg_temp.consent('ana'), 'withdrawn|Izmišljeni razlog: nedostaje zaključak.|t|f', 'the student sees who and why');
SELECT is(pg_temp.give('marko', true, 'Izmišljeno: sada je u redu.'), 'given|Izmišljeno: sada je u redu.', 'and gives it again');
SELECT is(pg_temp.ask('ana', format('SELECT string_agg(given::text, %L ORDER BY changed_at) FROM app.read_work_mentor_consent_events(%L)', ',', pg_temp.mdoc())),
  'true,false,true', 'every change is in the history, in order');
SELECT is(pg_temp.ask('ana', format('SELECT count(*)::text FROM app.read_work_mentor_consent_events(%L)', pg_temp.mdoc())), '3', 'three changes');
SELECT is(pg_temp.ask('iva', 'SELECT mentor_consent_required::text FROM app.set_thesis_setting(true)'), 'true', 'the faculty turns the switch on');
SELECT is(pg_temp.consent('ana'), 'given|Izmišljeno: sada je u redu.|t|t', 'the student sees that the faculty requires the consent');
SELECT is((SELECT count(*)::int FROM institution.thesis_setting), 1, 'one change of the switch');

-- (c) The stage after the submission.
CREATE FUNCTION pg_temp.stage(p_actor text, p_stage text, p_at text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT concat_ws(%L, stage, coalesce(to_char(defense_at AT TIME ZONE %L, %L), %L), changed_by_part) FROM app.set_work_thesis_stage(%L, %L, %L::timestamptz)',
    '|', 'UTC', 'YYYY-MM-DD HH24:MI', '-', pg_temp.mdoc(), p_stage, p_at))
$$;
SELECT is(pg_temp.ask(a, format('SELECT stage FROM app.read_work_thesis_stage(%L)', pg_temp.mdoc())), 'none', a || ' reads no stage yet')
  FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.ask('dora', format('SELECT stage FROM app.read_work_thesis_stage(%L)', pg_temp.mdoc())), 'ZD404: not found', 'a stranger reads nothing');
SELECT is(pg_temp.stage('ana', 'submitted_to_office', NULL), 'ZD403: forbidden', 'the student does not set the stage');
SELECT is(pg_temp.stage('vesna', 'submitted_to_office', NULL), 'ZD404: not found', 'a course teacher has no part');
SELECT is(pg_temp.stage('marko', s, a), 'ZD422: invalid input', why)
  FROM (VALUES ('obranjen', NULL, 'an unknown stage'),
               ('defense_scheduled', NULL, 'a defense needs its date'),
               ('submitted_to_office', '2027-02-10T09:00:00Z', 'no date before the defense is scheduled'),
               ('defense_scheduled', '1999-12-31T09:00:00Z', 'a date in this era')) AS x(s, a, why);
SELECT is(pg_temp.stage('marko', 'submitted_to_office', NULL), 'submitted_to_office|-|mentor', 'the mentor records the delivery to the office');
SELECT is(pg_temp.stage('iva', 'defense_scheduled', '2027-02-10T09:00:00Z'), 'defense_scheduled|2027-02-10 09:00|faculty', 'the faculty schedules the defense');
SELECT is(pg_temp.stage('iva', 'defense_scheduled', '2027-02-10T09:00:00Z'), 'defense_scheduled|2027-02-10 09:00|faculty', 'the stage in force writes nothing');
SELECT is(pg_temp.stage('marko', 'defended', '2027-02-10T09:00:00Z'), 'defended|2027-02-10 09:00|mentor', 'the thesis is defended');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_stage_event), 3, 'three stages recorded');
SELECT is(pg_temp.ask('ana', format('SELECT stage FROM app.read_work_thesis_stage(%L)', pg_temp.mdoc())), 'defended', 'the student sees the stage');

-- Every record is only ever added, for the owner too.
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', format(stmt, tbl)), 'ZD409: conflict', format(what, tbl))
  FROM unnest(ARRAY['thesis_form', 'thesis_setting', 'work_thesis_form_event', 'work_mentor_consent_event',
                    'work_thesis_stage_event']) AS tbl
  CROSS JOIN (VALUES ('UPDATE institution.%I SET created_at = created_at', '%s cannot be updated'),
                     ('DELETE FROM institution.%I', '%s cannot be deleted'),
                     ('TRUNCATE institution.%I', '%s cannot be truncated')) AS t(stmt, what)
  WHERE NOT (stmt LIKE 'UPDATE%' AND tbl LIKE 'work\_%')
    -- An event row refers to a form, so TRUNCATE of the catalogue stops at the foreign key first.
    AND NOT (stmt LIKE 'TRUNCATE%' AND tbl = 'thesis_form');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', format('UPDATE institution.%I SET occurred_at = occurred_at', tbl)), 'ZD409: conflict', tbl || ' events cannot be updated')
  FROM unnest(ARRAY['work_thesis_form_event', 'work_mentor_consent_event', 'work_thesis_stage_event']) AS tbl;

SELECT * FROM finish();
ROLLBACK;
