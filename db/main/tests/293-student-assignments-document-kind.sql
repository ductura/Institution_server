-- F4-V13-R04-SRV2 (migration 20261220890000): institution.student_assignments()
-- also answers the kind of document an assignment asks for
-- (institution.assignment.document_kind), so student.assignments.get can tell
-- a slides assignment from a text one. Without the migration every read of
-- s.document_kind below fails (no such column). The rows a student reads are
-- unchanged: the same students read the same assignments, and the function
-- keeps SECURITY DEFINER, its empty search_path and its one grant.
-- Personas of institution.inc; the content is invented. Vesna teaches K1
-- (Ana and Dora are its students), Tomo is a student of K3 at fak-b.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT plan(14);

-- Vesna creates a slides and a spreadsheet assignment in K1; the id, or "SQLSTATE: ...".
CREATE FUNCTION pg_temp.create_kind(p_key text, p_title text, p_kind text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format($q$
    SELECT institution.create_assignment_with_groups({k1}, %L::uuid,
      %L, 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      'partially_allowed', '{}', 'basic', false, NULL, NULL, 1, false, false, false, '{}'::uuid[], %L)::text
  $q$, p_key, p_title, p_kind))
$$;
-- "title kind" of every assignment the actor reads, by title, or '-'.
CREATE FUNCTION pg_temp.kinds(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor,
    $q$ SELECT coalesce(string_agg(s.title || ' ' || s.document_kind, ' | ' ORDER BY s.title), '-')
          FROM institution.student_assignments() s $q$)
$$;

SELECT is(pg_temp.kinds('ana'), 'Z1 text', 'before: Ana reads Z1 of K1, a text assignment');

SELECT matches(pg_temp.create_kind('00000000-0000-4000-8000-0000000f0001', 'Izmišljena prezentacija', 'slides'),
               '^[0-9a-f-]{36}$', 'Vesna creates a slides assignment in K1');
SELECT matches(pg_temp.create_kind('00000000-0000-4000-8000-0000000f0002', 'Izmišljena tablica', 'spreadsheet'),
               '^[0-9a-f-]{36}$', 'and a spreadsheet assignment');

-- 1. The kind as stored, for each kind.
SELECT is(pg_temp.kinds('ana'),
          'Izmišljena prezentacija slides | Izmišljena tablica spreadsheet | Z1 text',
          'Ana reads each assignment of K1 with its kind: slides, spreadsheet, text');
SELECT is(pg_temp.kinds('dora'), pg_temp.kinds('ana'), 'Dora, also of K1, reads the same kinds');

-- 2. No one reads more than before.
SELECT is(pg_temp.kinds('tomo'), 'Z3 text', 'Tomo of fak-b reads only Z3 of his course, never the new ones');
SELECT is(pg_temp.kinds('vesna'), '-', 'Vesna teaches K1 and is no student: reads nothing');
SELECT is(pg_temp.kinds('boris'), '-', 'Boris in no course reads nothing');
SELECT is(pg_temp.kinds('anon'), 'ZD401: not authenticated', 'without a session the read is refused');

-- 3. The function keeps its security settings and its one grant.
SELECT is((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'institution.student_assignments()'::regprocedure),
          true, 'still SECURITY DEFINER');
SELECT is((SELECT p.proconfig::text FROM pg_proc p WHERE p.oid = 'institution.student_assignments()'::regprocedure),
          '{search_path=""}', 'still with an empty search_path');
SELECT is((SELECT p.provolatile::text FROM pg_proc p WHERE p.oid = 'institution.student_assignments()'::regprocedure),
          's', 'still STABLE');
SELECT ok(has_function_privilege('ductus_app', 'institution.student_assignments()', 'EXECUTE'),
          'ductus_app may execute it');
SELECT is((SELECT count(*)::integer FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.oid = 'institution.student_assignments()'::regprocedure
              AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
              AND a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'ductus_app')),
          0, 'and no one else but its owner, PUBLIC included');

SELECT * FROM finish();
ROLLBACK;
