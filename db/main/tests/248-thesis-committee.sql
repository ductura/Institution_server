-- SRV-V16-POVJERENSTVO-ZAPIS: the committee of a thesis as a list kept with the
-- work. Personas of mentorship.inc, all invented: Ana writes zm1 (a master
-- thesis) under her mentor Marko; Iva is the administrator of fak-a, Lea of
-- fak-b; Vesna teaches the course of z1 (doc-a); Dora is another student; Nina
-- has an unconfirmed teacher role; Petra teaches in fak-b. Three more confirmed
-- teachers of fak-a (e1 to e3) fill the committee up to the limit of five.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- Tables only through the RPCs, records only ever added.
SELECT ok(relrowsecurity AND relforcerowsecurity, relname || ' has forced row security')
  FROM pg_class WHERE oid IN ('institution.work_thesis_committee_change'::regclass,
    'institution.work_thesis_committee_member'::regclass);
SELECT ok(NOT has_table_privilege('ductus_app', name, 'SELECT,INSERT,UPDATE,DELETE'), 'only RPC access to ' || name)
  FROM (VALUES ('institution.work_thesis_committee_change'), ('institution.work_thesis_committee_member')) AS t(name);
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
  FROM (VALUES ('ductus_worker'), ('ductus_evidence'), ('public')) AS x(r)
  CROSS JOIN unnest(ARRAY['app.read_work_thesis_committee(text)', 'app.set_work_thesis_committee(text,jsonb)',
    'institution.thesis_committee_now(text)']) AS f;
SELECT ok(has_function_privilege('ductus_app', f, 'EXECUTE'), 'the web role calls ' || f)
  FROM unnest(ARRAY['app.read_work_thesis_committee(text)', 'app.set_work_thesis_committee(text,jsonb)']) AS f;
SELECT ok(NOT has_function_privilege('ductus_app', 'institution.thesis_committee_now(text)', 'EXECUTE'),
  'the web role does not call the internal reader (an internal helper)');
-- The list is not an access path: the work grants are untouched by it.
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.proname IN ('read_work_thesis_committee', 'set_work_thesis_committee')
              AND (pg_get_functiondef(p.oid) ~ 'work_grant' OR pg_get_functiondef(p.oid) ~ 'grant_can')), 0,
  'the committee RPCs never touch the work grants');

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 8),
  'opened', 'Ana opens her mentored work');

-- Three more teachers of fak-a, confirmed by Iva, and two names.
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
SELECT ('00000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid, pg_temp.id('fak_a'),
       'https://issuer.test', 'sub-e' || n, 'e' || n || '@a.example'
  FROM generate_series(1, 3) n;
INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
SELECT pg_temp.id('fak_a'), ('00000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid, 'teacher',
       pg_temp.id('iva'), now()
  FROM generate_series(1, 3) n;
INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
VALUES (pg_temp.id('marko'), pg_temp.id('fak_a'), 'Marko', 'Izmišljenić'),
       (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljanić');
CREATE FUNCTION pg_temp.e(n integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '00000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0') $$;

-- A readable line: role:name-or-dash per member in the order the RPC gives, and the time as set or not.
CREATE FUNCTION pg_temp.committee(p_actor text, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT coalesce((SELECT string_agg(m ->> 'role' || ':' || coalesce(m -> 'name' ->> 'familyName', '-'), ',' ORDER BY o)
                       FROM jsonb_array_elements(members) WITH ORDINALITY AS x(m, o)), 'empty')
           || '|' || CASE WHEN changed_at IS NULL THEN 'never' ELSE 'set' END
      FROM app.read_work_thesis_committee(%L) $q$, coalesce(p_doc, pg_temp.mdoc())))
$$;
CREATE FUNCTION pg_temp.replace(p_actor text, p_members jsonb, p_doc text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$
    SELECT coalesce((SELECT string_agg(m ->> 'role' || ':' || coalesce(m -> 'name' ->> 'familyName', '-'), ',' ORDER BY o)
                       FROM jsonb_array_elements(members) WITH ORDINALITY AS x(m, o)), 'empty')
           || '|' || CASE WHEN changed_at IS NULL THEN 'never' ELSE 'set' END
      FROM app.set_work_thesis_committee(%L, %L::jsonb) $q$, coalesce(p_doc, pg_temp.mdoc()), p_members::text))
$$;
CREATE FUNCTION pg_temp.m(p_user text, p_role text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('userId', p_user, 'role', p_role) $$;
CREATE FUNCTION pg_temp.changes() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM institution.work_thesis_committee_change $$;

-- Who has a part in the work reads the empty list.
SELECT is(pg_temp.committee(a), 'empty|never', a || ' reads no committee yet') FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.committee('anon'), 'ZD401: not authenticated', 'reading needs a session');
SELECT is(pg_temp.committee(a), 'ZD404: not found', a || ' has no part in the work')
  FROM (VALUES ('dora'), ('vesna'), ('nina'), ('lea'), ('petra'), ('tomo')) AS t(a);
SELECT is(pg_temp.committee(a, 'doc-a'), 'ZD404: not found', a || ': a course work has no committee')
  FROM (VALUES ('ana'), ('vesna'), ('iva')) AS t(a);
SELECT is(pg_temp.committee('ana', 'no-such-document'), 'ZD404: not found', 'an unknown work');

-- Writing: the administrator only; nobody else, whatever the list.
SELECT is(pg_temp.replace(a, jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'chair'))), 'ZD403: forbidden',
  a || ' cannot name the committee') FROM (VALUES ('ana'), ('marko')) AS t(a);
SELECT is(pg_temp.replace(a, jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'chair'))), 'ZD404: not found',
  a || ' has no part, so 404 before anything') FROM (VALUES ('dora'), ('vesna'), ('lea'), ('nina'), ('petra')) AS t(a);
SELECT is(pg_temp.replace('anon', '[]'::jsonb), 'ZD401: not authenticated', 'writing needs a session');
SELECT is(pg_temp.changes(), 0, 'nothing written so far');

-- A bad list is ZD422 and writes nothing.
SELECT is(pg_temp.replace('iva', l), 'ZD422: invalid input', why)
  FROM (VALUES
    (jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'chair'), pg_temp.m(pg_temp.id('marko')::text, 'chair')), 'two chairs'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'member'), pg_temp.m(pg_temp.id('vesna')::text, 'chair')), 'the same person twice'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'member'), pg_temp.m(pg_temp.id('marko')::text, 'member'),
       pg_temp.m(pg_temp.e(1), 'member'), pg_temp.m(pg_temp.e(2), 'member'), pg_temp.m(pg_temp.e(3), 'member'),
       pg_temp.m(pg_temp.id('vesna')::text, 'member')), 'six entries'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('petra')::text, 'member')), 'a teacher of another institution'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('nina')::text, 'member')), 'a teacher nobody confirmed'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('iva')::text, 'member')), 'an administrator who is no teacher'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('ana')::text, 'member')), 'the student of the work'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('dora')::text, 'member')), 'another student'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('nobody')::text, 'member')), 'a person who does not exist'),
    (jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'president')), 'an unknown role'),
    (jsonb_build_array(pg_temp.m('not-a-uuid', 'member')), 'an id that is no uuid'),
    (jsonb_build_array(jsonb_build_object('userId', pg_temp.id('vesna')::text)), 'a member without a role'),
    (jsonb_build_array(jsonb_build_object('userId', pg_temp.id('vesna')::text, 'role', 'member', 'extra', 1)), 'a member with an extra key'),
    (jsonb_build_array('"text"'::jsonb), 'a member that is no object'),
    ('{"members": []}'::jsonb, 'not an array'),
    ('null'::jsonb, 'json null')
  ) AS x(l, why);
SELECT is(pg_temp.ask('iva', format('SELECT 1 FROM app.set_work_thesis_committee(%L, NULL)', pg_temp.mdoc())),
  'ZD422: invalid input', 'the list is required');
SELECT is(pg_temp.changes(), 0, 'a refused list writes nothing');

-- The empty list while there is none writes nothing.
SELECT is(pg_temp.replace('iva', '[]'::jsonb), 'empty|never', 'an empty list while none exists');
SELECT is(pg_temp.changes(), 0, 'and writes nothing');

-- Naming the committee. The chair comes first, then by user id; a name is null when none is held.
SELECT is(pg_temp.replace('iva', jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'member'),
    pg_temp.m(pg_temp.id('marko')::text, 'chair'))), 'chair:Izmišljenić,member:Izmišljanić|set',
  'Iva names the committee: the chair first');
SELECT is(pg_temp.changes(), 1, 'one change');
SELECT is(pg_temp.replace('iva', jsonb_build_array(pg_temp.m(pg_temp.id('marko')::text, 'chair'),
    pg_temp.m(pg_temp.id('vesna')::text, 'member'))), 'chair:Izmišljenić,member:Izmišljanić|set',
  'the same list in another order writes nothing');
SELECT is(pg_temp.changes(), 1, 'still one change');
SELECT is(pg_temp.committee(a), 'chair:Izmišljenić,member:Izmišljanić|set', a || ' reads the committee')
  FROM (VALUES ('ana'), ('marko'), ('iva')) AS t(a);
SELECT is(pg_temp.committee(a), 'ZD404: not found', a || ' still has no part') FROM (VALUES ('dora'), ('lea')) AS t(a);

-- The time and the writer of the change; the list is no access to the work.
SELECT is((SELECT count(*)::int FROM institution.work_thesis_committee_change
            WHERE changed_by = pg_temp.id('iva') AND document_id = pg_temp.mdoc()), 1, 'the change names Iva as its writer');
SELECT is((SELECT count(*)::int FROM institution.work_grant), 0, 'nothing was granted: the list gives no right to the work');

-- A replacement: the whole list is swapped, a name missing from the institution is null,
-- the history stays, the limit of five holds and a chair is optional.
SELECT is(pg_temp.replace('iva', jsonb_build_array(pg_temp.m(pg_temp.e(1), 'chair'), pg_temp.m(pg_temp.e(2), 'member'),
    pg_temp.m(pg_temp.e(3), 'member'), pg_temp.m(pg_temp.id('vesna')::text, 'member'), pg_temp.m(pg_temp.id('marko')::text, 'member'))),
  'chair:-,member:Izmišljanić,member:Izmišljenić,member:-,member:-|set', 'five members, the limit itself (the chair first, then by user id)');
SELECT is(pg_temp.changes(), 2, 'a second change, the first stays');
SELECT is((SELECT count(*)::int FROM institution.work_thesis_committee_member), 7, 'both lists are kept');
SELECT is(pg_temp.replace('iva', jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'member'))), 'member:Izmišljanić|set',
  'a committee with no chair');
SELECT is(pg_temp.replace('iva', '[]'::jsonb), 'empty|set', 'the committee can be emptied: that is a change too');
SELECT is(pg_temp.changes(), 4, 'four changes');
SELECT is(pg_temp.replace('iva', '[]'::jsonb), 'empty|set', 'emptying an empty committee writes nothing');
SELECT is(pg_temp.changes(), 4, 'still four');

-- A teacher whose role was revoked after the naming cannot be named again.
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('vesna');
SELECT is(pg_temp.replace('iva', jsonb_build_array(pg_temp.m(pg_temp.id('vesna')::text, 'member'))), 'ZD422: invalid input',
  'a revoked teacher is not named');

-- Another faculty's administrator and a student of another institution see nothing, 404 not 403.
SELECT is(pg_temp.committee('lea'), 'ZD404: not found', 'the administrator of another faculty');
SELECT is(pg_temp.replace('lea', '[]'::jsonb), 'ZD404: not found', 'cannot name either');
SELECT is(pg_temp.changes(), 4, 'and nothing was written');

-- Every record is only ever added, for the owner too.
SELECT is(pg_temp.ask_as('ductus_identity', 'iva', format(stmt, tbl)), 'ZD409: conflict', format(what, tbl))
  FROM unnest(ARRAY['work_thesis_committee_change', 'work_thesis_committee_member']) AS tbl
  CROSS JOIN (VALUES ('UPDATE institution.%I SET institution_id = institution_id', '%s cannot be updated'),
                     ('DELETE FROM institution.%I', '%s cannot be deleted'),
                     ('TRUNCATE institution.%I', '%s cannot be truncated')) AS t(stmt, what)
  WHERE NOT (stmt LIKE 'TRUNCATE%' AND tbl = 'work_thesis_committee_change');

SELECT * FROM finish();
ROLLBACK;
