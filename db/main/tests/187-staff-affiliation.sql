-- identity.staff_affiliation, the ten-argument open_session and
-- identity.my_staff_affiliation() (SRV-1403, M1.3, DAN-304, D-205 t. 4): a
-- teacher role is confirmed only for a person whose last login released a
-- staff affiliation of their own institution; each person reads only their
-- own row; the web process writes nothing. Synthetic fixtures only: every
-- person, name and organisation is invented.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';

SELECT no_plan();

-- The fixture has institutions without a home organisation or an issuer;
-- the login needs both.
UPDATE identity.institution SET aai_home_org = 'fak-a.example' WHERE id = pg_temp.id('fak_a');
UPDATE identity.institution SET aai_home_org = 'fak-b.example' WHERE id = pg_temp.id('fak_b');
INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES
  (pg_temp.id('fak_a'), 'https://issuer.test'),
  (pg_temp.id('fak_b'), 'https://issuer.test');

-- One login of a fixture person as ductus_auth through the ten-argument
-- form; 'ok' or the SQLSTATE and message of the refusal.
CREATE FUNCTION pg_temp.login(p_who text, p_source text, p_scope text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_org text;
  v_hash bytea := sha256(convert_to(gen_random_uuid()::text, 'UTF8'));
  v_result text := 'ok';
BEGIN
  SELECT faculty || '.example' INTO STRICT v_org FROM person WHERE name = p_who;
  SET LOCAL ROLE ductus_auth;
  BEGIN
    PERFORM identity.open_session('https://issuer.test', 'sub-' || p_who, p_who || '@' || v_org, v_org, v_hash,
                                  NULL, NULL, NULL, p_source, p_scope);
  EXCEPTION WHEN OTHERS THEN
    v_result := SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_result;
END
$$;
-- The same through the eight-argument form, which sends only the fact.
CREATE FUNCTION pg_temp.login8(p_who text, p_eligible boolean)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_org text;
  v_hash bytea := sha256(convert_to(gen_random_uuid()::text, 'UTF8'));
BEGIN
  SELECT faculty || '.example' INTO STRICT v_org FROM person WHERE name = p_who;
  SET LOCAL ROLE ductus_auth;
  PERFORM identity.open_session('https://issuer.test', 'sub-' || p_who, p_who || '@' || v_org, v_org, v_hash,
                                NULL, NULL, p_eligible);
  RESET ROLE;
  RETURN 'ok';
END
$$;
CREATE FUNCTION pg_temp.affiliation(p_name text) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce((SELECT source || ' ' || (institution_id = (SELECT institution_id FROM person WHERE name = p_name))::text
                     FROM identity.staff_affiliation WHERE user_id = pg_temp.id(p_name)), 'none')
$$;
CREATE FUNCTION pg_temp.has_right(p_name text) RETURNS boolean
LANGUAGE sql AS $$ SELECT EXISTS (SELECT 1 FROM identity.teacher_eligibility WHERE user_id = pg_temp.id(p_name)) $$;
CREATE FUNCTION pg_temp.confirm(p_admin text, p_candidate text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_admin, format($q$ SELECT 'done' FROM institution.confirm_teacher_role({%s}) $q$, p_candidate))
$$;
-- What the caller's own read returns, as one line.
CREATE FUNCTION pg_temp.mine(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT count(*)::text || ' ' || coalesce(string_agg(source, ','), '-')
                                     FROM identity.my_staff_affiliation() $q$)
$$;

-- 1. The catalogue: a forced-RLS table of ductus_identity, the owner policy
-- alone, the source as a closed set, and two definers with one role each.
SELECT ok(
  (SELECT c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
   FROM pg_class c WHERE c.oid = 'identity.staff_affiliation'::regclass),
  'staff_affiliation has ENABLE and FORCE ROW LEVEL SECURITY and belongs to ductus_identity'
);
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
     WHERE schemaname = 'identity' AND tablename = 'staff_affiliation' $$,
  ARRAY['staff_affiliation_owner ALL to ductus_identity'],
  'the only policy on staff_affiliation is the owner policy'
);
SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END,
                     ', ' ORDER BY a.attnum)
   FROM pg_attribute a WHERE a.attrelid = 'identity.staff_affiliation'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'user_id uuid not null, institution_id uuid not null, source text not null, confirmed_at timestamp with time zone not null',
  'staff_affiliation keeps the account, the institution, the source and the time, never a value or a scope'
);
SELECT col_is_pk('identity', 'staff_affiliation', 'user_id', 'one affiliation per account');
SELECT is(
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
   WHERE c.conrelid = 'identity.staff_affiliation'::regclass AND c.contype = 'c'),
  'CHECK ((source = ANY (ARRAY[''hrEduPersonAffiliation''::text, ''eduPersonAffiliation''::text, ''eduPersonScopedAffiliation''::text])))',
  'the source is one of three attributes'
);
SELECT is(
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
   WHERE c.conrelid = 'identity.staff_affiliation'::regclass AND c.contype = 'f'),
  'FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account(id, institution_id)',
  'the affiliation belongs to an account of its institution and does not cascade'
);
SELECT t FROM unnest(ARRAY['identity.open_session(text, text, text, text, bytea, text, text, text, text, text)',
                           'identity.my_staff_affiliation()']) AS f
JOIN pg_proc p ON p.oid = f::regprocedure
CROSS JOIN LATERAL (VALUES
  (ok(p.prosecdef, f || ' is SECURITY DEFINER')),
  (is(pg_get_userbyid(p.proowner)::text, 'ductus_identity', f || ' belongs to ductus_identity')),
  (is(p.proconfig, ARRAY['search_path=""'], f || ' runs with an empty search_path'))
) AS v (t);
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || f.fn FROM (SELECT rolname::text FROM pg_roles
                                           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_identity'
                                           UNION ALL SELECT 'public') AS r (rolname)
     CROSS JOIN (VALUES
       ('identity.open_session(text, text, text, text, bytea, text, text, text, text, text)', 'ductus_auth'),
       ('identity.my_staff_affiliation()', 'ductus_app')
     ) AS f (fn, allowed)
     WHERE has_function_privilege(r.rolname, f.fn::regprocedure, 'EXECUTE') <> (r.rolname = f.allowed) $$,
  'the login runs only for ductus_auth and the own read only for ductus_app, PUBLIC for neither'
);

-- 2. Nobody reads or writes the table directly; the web process
-- (ductus_app) is refused every write as every other role is.
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || c FROM (SELECT rolname::text FROM pg_roles
                                        WHERE rolname LIKE 'ductus\_%' AND rolname <> 'ductus_identity'
                                        UNION ALL SELECT 'public') AS r (rolname)
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS c
     WHERE has_table_privilege(r.rolname, 'identity.staff_affiliation', c) $$,
  'no role but the owner, nor PUBLIC, holds any privilege on staff_affiliation'
);
SELECT is_empty(
  $$ SELECT r || ' ' || left(s, 6) FROM unnest(ARRAY['ductus_app', 'ductus_auth', 'ductus_worker', 'ductus_retention',
                                                     'ductus_test_stranger']) AS r
     CROSS JOIN unnest(ARRAY[
       'SELECT count(*)::text FROM identity.staff_affiliation',
       'INSERT INTO identity.staff_affiliation (user_id, institution_id, source) VALUES ({boris}, {fak_a}, ''hrEduPersonAffiliation'')',
       'UPDATE identity.staff_affiliation SET confirmed_at = now()',
       'DELETE FROM identity.staff_affiliation'
     ]) AS s
     WHERE coalesce(pg_temp.ask_as(r, 'boris', s), 'ok') !~ '^42501: ' $$,
  'every role, ductus_app among them, is refused SELECT, INSERT, UPDATE and DELETE on staff_affiliation'
);
SELECT is(pg_temp.affiliation('boris'), 'none', 'the refused INSERT left no affiliation');
SELECT is(
  pg_temp.ask_as('ductus_app', 'boris',
    $$ SELECT identity.open_session('https://issuer.test', 'sub-boris', 'boris@fak-a.example', 'fak-a.example',
         sha256('web'), NULL, NULL, NULL, 'eduPersonScopedAffiliation', 'fak-a.example')::text $$),
  '42501: permission denied for function open_session',
  'the web process cannot open a login that would give an affiliation'
);

-- 3. A login without an affiliation leaves the person a student.
SELECT is(pg_temp.login('ana', NULL), 'ok', 'a login without an affiliation opens the session');
SELECT is(pg_temp.affiliation('ana'), 'none', 'it records no affiliation');
SELECT is(pg_temp.has_right('ana'), false, 'and gives no teacher right');
SELECT is(pg_temp.confirm('iva', 'ana'), 'ZD403: forbidden', 'the administrator cannot confirm Ana as a teacher');

-- 4. An unscoped staff value is of the home organisation.
SELECT is(pg_temp.login('nina', 'hrEduPersonAffiliation'), 'ok', 'a login with hrEduPersonAffiliation opens the session');
SELECT is(pg_temp.affiliation('nina'), 'hrEduPersonAffiliation true', 'it records the source with Nina''s own institution');
SELECT ok(pg_temp.has_right('nina'), 'and gives the teacher right');
SELECT is(pg_temp.confirm('iva', 'nina'), 'done', 'the administrator confirms Nina as a teacher');
SELECT is(pg_temp.login('marko', 'eduPersonAffiliation'), 'ok', 'a login with eduPersonAffiliation opens the session');
SELECT is(pg_temp.affiliation('marko'), 'eduPersonAffiliation true', 'eduPersonAffiliation is a source too');

-- 5. A scoped value counts only for the account's own institution.
SELECT is(pg_temp.login('boris', 'eduPersonScopedAffiliation', 'fak-a.example'), 'ok',
  'a login with a scoped affiliation of the own institution opens the session');
SELECT is(pg_temp.affiliation('boris'), 'eduPersonScopedAffiliation true', 'it records the scoped source');
SELECT is(pg_temp.confirm('iva', 'boris'), 'done', 'the administrator confirms Boris as a teacher');
SELECT is(pg_temp.login('vesna', 'eduPersonScopedAffiliation', ' FAK-A.Example'), 'ok',
  'the scope is compared as the home organisation is, without case or edge blanks');
SELECT is(pg_temp.affiliation('vesna'), 'eduPersonScopedAffiliation true', 'so Vesna is affiliated');

SELECT is(pg_temp.login('dora', 'eduPersonScopedAffiliation', 'fak-b.example'), 'ok',
  'a login with another institution''s affiliation still opens the session');
SELECT is(pg_temp.affiliation('dora'), 'none', 'another institution''s affiliation is refused');
SELECT is(pg_temp.has_right('dora'), false, 'and gives no teacher right');
SELECT is(pg_temp.confirm('iva', 'dora'), 'ZD403: forbidden', 'the administrator cannot confirm Dora');
SELECT is(pg_temp.confirm('lea', 'dora'), 'ZD403: forbidden', 'nor can the other institution''s administrator');
SELECT is(pg_temp.login('tomo', 'eduPersonScopedAffiliation', 'fak-b.example.evil'), 'ok', 'a scope that only starts alike');
SELECT is(pg_temp.affiliation('tomo'), 'none', 'is another institution''s');

-- 6. Malformed combinations give nothing and never refuse the login.
SELECT is(pg_temp.login('petra', 'eduPersonScopedAffiliation', NULL), 'ok', 'a scoped source without a scope');
SELECT is(pg_temp.affiliation('petra'), 'none', 'gives no affiliation');
SELECT is(pg_temp.login('petra', 'hrEduPersonAffiliation', 'fak-b.example'), 'ok', 'an unscoped source with a scope');
SELECT is(pg_temp.affiliation('petra'), 'none', 'gives no affiliation');
SELECT is(pg_temp.login('petra', 'student', NULL), 'ok', 'a source outside the set');
SELECT is(pg_temp.affiliation('petra'), 'none', 'gives no affiliation');

-- 7. The next login decides alone: losing the affiliation takes the right,
-- and another institution's affiliation takes an earlier one too. A
-- confirmed role stays (D-200 P7).
SELECT is(pg_temp.login('boris', 'eduPersonScopedAffiliation', 'fak-b.example'), 'ok', 'Boris logs in with fak-b''s affiliation');
SELECT is(pg_temp.affiliation('boris'), 'none', 'his earlier affiliation is gone');
SELECT is(pg_temp.has_right('boris'), false, 'and so is the right');
SELECT is(
  (SELECT count(*)::int FROM institution.institution_role
    WHERE user_id = pg_temp.id('boris') AND role = 'teacher' AND confirmed_at IS NOT NULL AND revoked_at IS NULL),
  1, 'the role confirmed before stays (D-200 P7)'
);
SELECT is(pg_temp.login('marko', NULL), 'ok', 'Marko logs in without an affiliation');
SELECT is(pg_temp.affiliation('marko'), 'none', 'his affiliation is gone');

-- 8. The older forms keep the two rows together.
SELECT is(pg_temp.login8('lea', true), 'ok', 'the eight-argument form with the fact');
SELECT is(pg_temp.affiliation('lea'), 'hrEduPersonAffiliation true', 'records an unscoped hrEduPersonAffiliation');
SELECT ok(pg_temp.has_right('lea'), 'next to the right');
SELECT is(pg_temp.login8('lea', false), 'ok', 'the eight-argument form without the fact');
SELECT is(pg_temp.affiliation('lea'), 'none', 'removes the affiliation');
SELECT is(pg_temp.has_right('lea'), false, 'with the right');

-- 9. Each person reads only their own row; no session reads nothing.
SELECT is(pg_temp.mine('nina'), '1 hrEduPersonAffiliation', 'Nina reads her own affiliation');
SELECT is(pg_temp.mine('vesna'), '1 eduPersonScopedAffiliation', 'Vesna reads hers');
SELECT is(pg_temp.mine('ana'), '0 -', 'Ana, without one, reads no row and never Nina''s');
SELECT is(pg_temp.mine('dora'), '0 -', 'Dora, refused, reads no row');
SELECT is(pg_temp.mine('petra'), '0 -', 'Petra of fak-b reads no row of fak-a');
SELECT is(pg_temp.mine('anon'), 'ZD401: not authenticated', 'a request without a session is refused');
SELECT is(pg_temp.mine('expired'), 'ZD401: not authenticated', 'an expired session is refused');
SELECT is(
  pg_temp.ask('nina', $$ SELECT confirmed_at IS NOT NULL AND confirmed_at <= statement_timestamp() FROM identity.my_staff_affiliation() $$)::text,
  'true', 'the read carries the time a login last confirmed the affiliation'
);
SELECT is(
  pg_temp.ask_as('ductus_auth', 'nina', $$ SELECT count(*)::text FROM identity.my_staff_affiliation() $$),
  '42501: permission denied for function my_staff_affiliation',
  'the login role does not read affiliations'
);

-- 10. The affiliation follows the right out (no foreign-key action, 033):
-- removing the right removes the affiliation, so whatever deletes an account
-- after its right (024, item 25) is not stopped by the affiliation.
SELECT is(
  (SELECT string_agg(t.tgname || ' ' || (t.tgtype & 8 <> 0)::text, ',') FROM pg_trigger t
    WHERE t.tgrelid = 'identity.teacher_eligibility'::regclass AND NOT t.tgisinternal),
  'staff_affiliation_follows_right true',
  'one trigger on teacher_eligibility, after DELETE'
);
SELECT is_empty(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND rolname <> 'ductus_identity'
                           UNION ALL SELECT 'public') AS r (rolname)
     WHERE has_function_privilege(r.rolname, 'identity.staff_affiliation_follows_right()', 'EXECUTE') $$,
  'nobody but the owner may call the trigger function'
);
SELECT is(pg_temp.affiliation('nina'), 'hrEduPersonAffiliation true', 'Nina still has her affiliation');
DELETE FROM identity.teacher_eligibility WHERE user_id = pg_temp.id('nina');
SELECT is(pg_temp.affiliation('nina'), 'none', 'removing the right removed the affiliation');
SELECT is(pg_temp.affiliation('vesna'), 'eduPersonScopedAffiliation true', 'and only that person''s');

SELECT * FROM finish();
ROLLBACK;
