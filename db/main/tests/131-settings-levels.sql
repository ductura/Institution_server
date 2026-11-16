-- DAN-801 (S-1J-e; contract on Ductus#1836, comment 6904644368, confirmed in
-- 6904658286): settings by level (D-298) and who changes which (D-297). The
-- access matrix of settings.value and settings.change, the matrix of account
-- kind by level for settings.set_value, the bound of a higher level, and the
-- append-only history. Personas of institution.inc, plus Boris as network
-- engineer of fak-a and Dora with a revoked appointment; every person is
-- invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by, appointed_at, revoked_at)
VALUES (pg_temp.id('fak_a'), pg_temp.id('boris'), pg_temp.id('iva'), now() - interval '1 day', NULL),
       (pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('iva'), now() - interval '2 days', now() - interval '1 day');

-- set_value as p_actor; 'ok' for any successful call, else "SQLSTATE: message".
CREATE FUNCTION pg_temp.put(p_actor text, p_level text, p_course text, p_key text, p_value text, p_bound text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN r LIKE 'ZD%' OR r LIKE '_____: %' THEN r ELSE 'ok' END
  FROM pg_temp.ask(p_actor, format('SELECT settings.set_value(%L, %s, %L, %L::jsonb, %L::jsonb)::text',
                                   p_level, coalesce('{' || p_course || '}::uuid', 'NULL'), p_key, p_value, p_bound)) AS r
$$;
CREATE FUNCTION pg_temp.stored(p_level text, p_key text) RETURNS text
LANGUAGE sql AS $$
  SELECT string_agg(coalesce(p.name, c.name, '-') || '=' || coalesce(v.value::text, '_') || coalesce(' ' || v.bound::text, ''),
                    ', ' ORDER BY coalesce(p.name, c.name, '-'))
  FROM settings.value v LEFT JOIN person p ON p.id = v.user_id
  LEFT JOIN institution.course c ON c.id = v.course_id
  WHERE v.level = p_level AND v.key = p_key
$$;

-- 1. Tables, owner, RLS, policies, triggers.
SELECT ok(
  (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole AND c.relkind = 'r')
   FROM pg_class c WHERE c.oid IN ('settings.value'::regclass, 'settings.change'::regclass)),
  'both tables are plain, belong to ductus_identity and have ENABLE and FORCE ROW LEVEL SECURITY');
SELECT is((SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'settings'), 'ductus_migrator',
  'the settings schema belongs to the migrator');
SELECT bag_eq(
  $$ SELECT tablename || ': ' || policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',')
     FROM pg_policies WHERE schemaname = 'settings' $$,
  ARRAY['value: value_owner ALL to ductus_identity',
        'change: change_owner_read SELECT to ductus_identity',
        'change: change_owner_append INSERT to ductus_identity'],
  'the owner''s policies only; on change, read and append alone');
SELECT bag_eq(
  $$ SELECT t.tgrelid::regclass || ' ' || t.tgname FROM pg_trigger t
     WHERE t.tgrelid IN ('settings.value'::regclass, 'settings.change'::regclass) AND NOT t.tgisinternal AND t.tgenabled = 'O' $$,
  ARRAY['settings.change change_refuse_row_rewrite', 'settings.change change_refuse_truncate'],
  'change has its two enabled refusal triggers, value none');

-- 2. The access matrix: no role but the owner holds a right on either table,
-- and the owner none to rewrite history. Login roles and PUBLIC included.
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || p.privilege || ' ' || c.relname
     FROM (SELECT rolname::text FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\_%' UNION ALL SELECT 'public') AS r
     CROSS JOIN pg_class c
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
     WHERE c.oid IN ('settings.value'::regclass, 'settings.change'::regclass)
       AND (has_table_privilege(r.rolname, c.oid, p.privilege)
            OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                AND has_any_column_privilege(r.rolname, c.oid, p.privilege))) $$,
  ARRAY['ductus_identity SELECT value', 'ductus_identity INSERT value', 'ductus_identity UPDATE value',
        'ductus_identity DELETE value', 'ductus_identity TRUNCATE value', 'ductus_identity REFERENCES value',
        'ductus_identity TRIGGER value',
        'ductus_identity SELECT change', 'ductus_identity INSERT change', 'ductus_identity REFERENCES change',
        'ductus_identity TRIGGER change'],
  'only the owner holds rights, and on change no UPDATE, DELETE or TRUNCATE');
SELECT matches(pg_temp.ask_as(r.role, 'iva', o.sql), '^42501: permission denied for (schema settings|table ' || o.tbl || ')$',
  format('%s: %s refused', r.role, o.sql))
FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_queue',
                  'ductus_migrator', 'ductus_test_stranger']) AS r (role)
CROSS JOIN (VALUES
  ('value', 'SELECT count(*)::text FROM settings.value'),
  ('value', $$INSERT INTO settings.value (level, key, value) VALUES ('system', 'x', '1') RETURNING 'w'$$),
  ('value', $$UPDATE settings.value SET value = '1' RETURNING 'w'$$),
  ('value', $$DELETE FROM settings.value RETURNING 'w'$$),
  ('value', 'TRUNCATE settings.value'),
  ('change', 'SELECT count(*)::text FROM settings.change'),
  ('change', $$INSERT INTO settings.change (level, key, cause, changed_by, changed_by_institution) VALUES ('system', 'x', 'set', {iva}, {fak_a}) RETURNING 'w'$$),
  ('change', $$UPDATE settings.change SET key = 'y' RETURNING 'w'$$),
  ('change', $$DELETE FROM settings.change RETURNING 'w'$$),
  ('change', 'TRUNCATE settings.change')
) AS o (tbl, sql);
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || p.oid::regprocedure::text
     FROM (SELECT rolname::text FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\_%' UNION ALL SELECT 'public') AS r
     CROSS JOIN pg_proc p
     WHERE p.pronamespace = 'settings'::regnamespace AND r.rolname <> 'ductus_identity'
       AND has_function_privilege(r.rolname, p.oid, 'EXECUTE') $$,
  ARRAY['ductus_app settings.set_value(text,uuid,text,jsonb,jsonb)',
        'ductus_app_local settings.set_value(text,uuid,text,jsonb,jsonb)'],
  'only the web process calls a function of settings, and only set_value');
SELECT is(
  (SELECT string_agg(p.proname || CASE WHEN p.prosecdef THEN ' definer' ELSE '' END, ', ' ORDER BY p.proname)
   FROM pg_proc p WHERE p.pronamespace = 'settings'::regnamespace),
  'bound_within, fits, is_bound, refuse_change_rewrite, set_value definer',
  'set_value is the one SECURITY DEFINER function of the schema');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.prosecdef AND p.pronamespace <> pg_my_temp_schema()
       AND p.oid <> 'settings.set_value(text,uuid,text,jsonb,jsonb)'::regprocedure
       AND (coalesce(p.prosrc, '') ~* 'settings\.(value|change)\M'
            OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                         AND d.refobjid IN ('settings.value'::regclass, 'settings.change'::regclass))) $$,
  'no other SECURITY DEFINER function names either table');
SELECT doesnt_imatch((SELECT prosrc FROM pg_proc WHERE oid = 'settings.set_value(text,uuid,text,jsonb,jsonb)'::regprocedure),
  '\mEXECUTE\M', 'set_value runs no dynamic SQL');

-- 3. Account kind by level. Iva admin fak-a, Vesna teacher of K1, Ana
-- student, Boris network engineer, Lea admin fak-b, Nina unconfirmed teacher.
SELECT is(pg_temp.put(m.actor, m.level, m.course, CASE m.level WHEN 'network_security' THEN 'network.k' ELSE 'm.k' END || m.n, '1'), m.expect,
  format('%s on %s%s: %s', m.actor, m.level, coalesce(' ' || m.course, ''), m.expect))
FROM (VALUES
  (1, 'ana', 'personal', NULL, 'ok'), (2, 'ana', 'course', 'k1', 'ZD403: not allowed'),
  (3, 'ana', 'institution', NULL, 'ZD403: not allowed'), (4, 'ana', 'system', NULL, 'ZD403: not allowed'),
  (5, 'ana', 'network_security', NULL, 'ZD403: not allowed'),
  (6, 'vesna', 'personal', NULL, 'ok'), (7, 'vesna', 'course', 'k1', 'ok'), (8, 'vesna', 'course', 'k2', 'ZD403: not allowed'),
  (9, 'vesna', 'course', 'k3', 'ZD403: not allowed'), (10, 'vesna', 'institution', NULL, 'ZD403: not allowed'),
  (11, 'vesna', 'system', NULL, 'ZD403: not allowed'), (12, 'vesna', 'network_security', NULL, 'ZD403: not allowed'),
  (13, 'iva', 'personal', NULL, 'ok'), (14, 'iva', 'course', 'k1', 'ok'), (15, 'iva', 'course', 'k2', 'ok'),
  (16, 'iva', 'course', 'k3', 'ZD403: not allowed'), (17, 'iva', 'course', 'nobody', 'ZD403: not allowed'),
  (18, 'iva', 'institution', NULL, 'ok'), (19, 'iva', 'system', NULL, 'ZD403: not allowed'),
  (20, 'iva', 'network_security', NULL, 'ZD403: not allowed'),
  (21, 'boris', 'personal', NULL, 'ok'), (22, 'boris', 'course', 'k1', 'ZD403: not allowed'),
  (23, 'boris', 'institution', NULL, 'ZD403: not allowed'), (24, 'boris', 'system', NULL, 'ZD403: not allowed'),
  (25, 'boris', 'network_security', NULL, 'ok'),
  (26, 'lea', 'course', 'k1', 'ZD403: not allowed'), (27, 'lea', 'course', 'k3', 'ok'), (28, 'lea', 'institution', NULL, 'ok'),
  (29, 'nina', 'course', 'k1', 'ZD403: not allowed'), (30, 'dora', 'network_security', NULL, 'ZD403: not allowed'),
  (31, 'petra', 'course', 'k1', 'ZD403: not allowed'), (32, 'marko', 'course', 'k1', 'ZD403: not allowed')
) AS m (n, actor, level, course, expect);
SELECT is(pg_temp.stored('institution', 'm.k28'), '-=1', 'Lea''s institution row is fak-b''s own');
SELECT is((SELECT institution_id FROM settings.value WHERE key = 'm.k28'), pg_temp.id('fak_b'),
  'the institution comes from the session, not from an argument');
SELECT is((SELECT institution_id FROM settings.value WHERE key = 'network.k25'), NULL,
  'network_security is application-wide');

-- A revoked admin role and a revoked teacher membership lose the level.
UPDATE institution.institution_role SET revoked_at = now() WHERE user_id = pg_temp.id('iva') AND role = 'admin';
SELECT is(pg_temp.put('iva', 'institution', NULL, 'm.r', '1'), 'ZD403: not allowed', 'revoked admin: institution refused');
SELECT is(pg_temp.put('iva', 'course', 'k1', 'm.r', '1'), 'ZD403: not allowed', 'revoked admin: course refused');
UPDATE institution.institution_role SET revoked_at = NULL WHERE user_id = pg_temp.id('iva') AND role = 'admin';
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('vesna') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.put('vesna', 'course', 'k1', 'm.r', '1'), 'ZD403: not allowed', 'ended membership: course refused');
UPDATE institution.course_member SET member_to = NULL WHERE user_id = pg_temp.id('vesna') AND course_id = pg_temp.id('k1');

-- An appointment that has not started yet does not count.
UPDATE identity.network_engineer_appointment SET appointed_at = now() + interval '1 day' WHERE user_id = pg_temp.id('boris');
SELECT is(pg_temp.put('boris', 'network_security', NULL, 'network.r', '1'), 'ZD403: not allowed', 'future appointment: refused');
UPDATE identity.network_engineer_appointment SET appointed_at = now() - interval '1 day' WHERE user_id = pg_temp.id('boris');

-- The network engineer reaches network keys alone: another institution's
-- settings of any other key stay out of reach (D-297).
SELECT is(pg_temp.put('lea', 'institution', NULL, 'citation.style', '"apa"', '{"locked": true}'), 'ok', 'Lea locks fak-b citation.style');
SELECT is(pg_temp.put('boris', 'network_security', NULL, n.key, NULL, '{"locked": true}'), 'ZD422: invalid input',
  format('Boris cannot set %s at network_security', n.key))
FROM unnest(ARRAY['citation.style', 'networking', 'network', 'm.network.x']) AS n (key);
SELECT is(pg_temp.stored('institution', 'citation.style'), '-="apa" {"locked": true}', 'Lea''s row is untouched');

-- 4. No live session: ZD401, nothing written.
SELECT is(pg_temp.put(t.name, 'personal', NULL, 'm.s', '1'), 'ZD401: not authenticated', format('ZD401 for %s', t.name))
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t (name);
SELECT is((SELECT count(*)::int FROM settings.value WHERE key IN ('m.s', 'm.r')), 0, 'no refused call wrote a row');

-- 5. Input of a wrong shape: ZD422.
SELECT is(pg_temp.put('iva', b.level, b.course, b.key, b.value, b.bound), 'ZD422: invalid input', 'ZD422: ' || b.what)
FROM (VALUES
  ('course id with personal', 'personal', 'k1', 'x', '1', NULL),
  ('course id with institution', 'institution', 'k1', 'x', '1', NULL),
  ('course without its id', 'course', NULL, 'x', '1', NULL),
  ('unknown level', 'global', NULL, 'x', '1', NULL),
  ('NULL level', NULL, NULL, 'x', '1', NULL),
  ('empty key', 'personal', NULL, '', '1', NULL),
  ('path key', 'personal', NULL, '../x', '1', NULL),
  ('upper case key', 'personal', NULL, 'Key', '1', NULL),
  ('key with a newline', 'personal', NULL, E'x\n', '1', NULL),
  ('key with a quote', 'personal', NULL, 'x''', '1', NULL),
  ('empty key segment', 'personal', NULL, 'a..b', '1', NULL),
  ('key of 65 characters', 'personal', NULL, repeat('k', 65), '1', NULL),
  ('NULL key', 'personal', NULL, NULL, '1', NULL),
  ('value over 8192 bytes', 'personal', NULL, 'x', to_jsonb(repeat('v', 8200))::text, NULL),
  ('bound on personal', 'personal', NULL, 'x', '1', '{"max": 2}'),
  ('bound on course', 'course', 'k1', 'x', '1', '{"max": 2}'),
  ('unknown bound field', 'institution', NULL, 'x', NULL, '{"max": 2, "step": 1}'),
  ('empty bound', 'institution', NULL, 'x', NULL, '{}'),
  ('text min', 'institution', NULL, 'x', NULL, '{"min": "1"}'),
  ('min above max', 'institution', NULL, 'x', NULL, '{"min": 3, "max": 2}'),
  ('locked false', 'institution', NULL, 'x', NULL, '{"locked": false}'),
  ('locked with max', 'institution', NULL, 'x', NULL, '{"locked": true, "max": 2}'),
  ('bound as an array', 'institution', NULL, 'x', NULL, '[1, 2]'),
  ('own value outside own bound', 'institution', NULL, 'x', '5', '{"max": 4}'),
  ('text value inside own numeric bound', 'institution', NULL, 'x', '"3"', '{"max": 4}')
) AS b (what, level, course, key, value, bound);
SELECT is((SELECT count(*)::int FROM settings.value WHERE key = 'x'), 0, 'no ZD422 call wrote a row');

-- 6. The bound of a higher level. Iva bounds fak-a's key network.limit to [2, 10].
SELECT is(pg_temp.put('iva', 'institution', NULL, 'network.limit', '6', '{"min": 2, "max": 10}'), 'ok', 'Iva sets [2, 10] with 6');
SELECT is(pg_temp.put('vesna', 'course', 'k1', 'network.limit', v.value), v.expect, format('K1 value %s: %s', v.value, v.expect))
FROM (VALUES ('10', 'ok'), ('2', 'ok'), ('10.0', 'ok'), ('1e1', 'ok'),
             ('10.0000000001', 'ZD409: crosses a higher bound'), ('11', 'ZD409: crosses a higher bound'),
             ('1.9999999999', 'ZD409: crosses a higher bound'), ('-0', 'ZD409: crosses a higher bound'),
             ('1e400', 'ZD409: crosses a higher bound'), ('"5"', 'ZD409: crosses a higher bound'),
             ('true', 'ZD409: crosses a higher bound'), ('[5]', 'ZD409: crosses a higher bound'),
             ('{"n": 5}', 'ZD409: crosses a higher bound'), ('null', 'ZD409: crosses a higher bound'),
             ('5', 'ok')) AS v (value, expect);
SELECT is(pg_temp.put('ana', 'personal', NULL, 'network.limit', '11'), 'ZD409: crosses a higher bound', 'a personal value is bound by the institution');
SELECT is(pg_temp.put('ana', 'personal', NULL, 'network.limit', '3'), 'ok', 'a personal value inside the bound');
SELECT is(pg_temp.put('tomo', 'personal', NULL, 'network.limit', '99'), 'ok', 'fak-a''s bound does not reach fak-b');
SELECT is(pg_temp.put('lea', 'course', 'k3', 'network.limit', '99'), 'ok', 'nor a fak-b course');
SELECT is(pg_temp.stored('course', 'network.limit'), 'K1=5, K3=99', 'only the values inside the bound were stored');

-- The application-wide level bounds the institution too, and a lower bound
-- may not widen a higher one.
SELECT is(pg_temp.put('boris', 'network_security', NULL, 'network.limit', NULL, '{"max": 50}'), 'ok', 'Boris bounds network.limit to 50 everywhere');
SELECT is(pg_temp.stored('course', 'network.limit'), 'K1=5', 'the fak-b course value of 99 is gone');
SELECT is(pg_temp.stored('personal', 'network.limit'), 'ana=3', 'and so is Tomo''s 99');
SELECT is(pg_temp.put('lea', 'institution', NULL, 'network.limit', NULL, '{"max": 60}'), 'ZD409: crosses a higher bound',
  'a lower bound wider than the higher one is refused');
SELECT is(pg_temp.put('lea', 'institution', NULL, 'network.limit', NULL, '{"min": 0}'), 'ZD409: crosses a higher bound',
  'a lower bound without the higher end is refused');
SELECT is(pg_temp.put('lea', 'institution', NULL, 'network.limit', NULL, '{"locked": true}'), 'ok', 'a lock lies inside any bound');
SELECT is(pg_temp.put('petra', 'course', 'k3', 'network.limit', '1'), 'ZD409: crosses a higher bound', 'under a lock, nothing lower is set');
SELECT is(pg_temp.put('lea', 'institution', NULL, 'network.limit', NULL, '{"max": 50.0}'), 'ok', 'an equal bound is inside');

-- Narrowing deletes every lower row that breaks the new bound, each with a
-- history row (cause 'bound', author the narrowing person); rows inside stay.
SELECT is(pg_temp.put('vesna', 'course', 'k1', 'network.limit', '9'), 'ok', 'K1 at 9');
SELECT is(pg_temp.put('marko', 'course', 'k2', 'network.limit', '4'), 'ok', 'K2 at 4');
SELECT is(pg_temp.put('dora', 'personal', NULL, 'network.limit', '8'), 'ok', 'Dora at 8');
SELECT is(pg_temp.put('iva', 'institution', NULL, 'network.limit', '4', '{"min": 2, "max": 4}'), 'ok', 'Iva narrows to [2, 4]');
SELECT is(pg_temp.stored('course', 'network.limit'), 'K2=4', 'K1 at 9 is deleted, K2 at 4 stays');
SELECT is(pg_temp.stored('personal', 'network.limit'), 'ana=3', 'Dora at 8 is deleted, Ana at 3 stays');
SELECT bag_eq(
  $$ SELECT coalesce(p.name, c.name) || ' ' || h.old_value::text || ' by ' || a.name FROM settings.change h
     LEFT JOIN person p ON p.id = h.user_id LEFT JOIN institution.course c ON c.id = h.course_id
     JOIN person a ON a.id = h.changed_by
     WHERE h.key = 'network.limit' AND h.cause = 'bound' AND h.new_value IS NULL AND h.new_bound IS NULL
       AND h.changed_by_institution = a.institution_id $$,
  ARRAY['K3 99 by boris', 'tomo 99 by boris', 'K1 9 by iva', 'dora 8 by iva'],
  'every deleted lower row has its own history row naming who set the bound');
SELECT is(pg_temp.put('boris', 'network_security', NULL, 'network.limit', NULL, '{"locked": true}'), 'ok', 'Boris locks network.limit');
SELECT is((SELECT count(*)::int FROM settings.value WHERE key = 'network.limit'), 1, 'only the locking row is left');
SELECT is(pg_temp.put('iva', 'institution', NULL, 'network.limit', '3'), 'ZD409: crosses a higher bound', 'the institution is locked out too');
SELECT is(pg_temp.put('ana', 'personal', NULL, 'network.limit', NULL), 'ok', 'removing what is not there changes nothing');

-- A level may lock its own value; the levels below then change nothing.
SELECT is(pg_temp.put('iva', 'institution', NULL, 's.cite', '"apa"', '{"locked": true}'), 'ok', 'Iva locks s.cite at "apa"');
SELECT is(pg_temp.put('vesna', 'course', 'k1', 's.cite', '"mla"'), 'ZD409: crosses a higher bound', 'K1 cannot change it');

-- 7. History: author, time, old and new value, for every change; removing a
-- value is a change too. Nothing changes when the value is the same.
SELECT is(pg_temp.put('dora', 'personal', NULL, 'h.k', '"a"'), 'ok', 'Dora sets h.k');
SELECT is(pg_temp.put('dora', 'personal', NULL, 'h.k', '"b"'), 'ok', 'Dora changes h.k');
SELECT is(pg_temp.ask('dora', $$SELECT settings.set_value('personal', NULL, 'h.k', '"b"')::text$$), NULL,
  'the same value again: NULL, no history row');
SELECT is(pg_temp.put('dora', 'personal', NULL, 'h.k', NULL), 'ok', 'Dora removes h.k');
SELECT is(
  (SELECT string_agg(coalesce(h.old_value::text, '_') || '>' || coalesce(h.new_value::text, '_') || ' ' || (h.cause = 'set')::text
                     || ' ' || (h.changed_by = pg_temp.id('dora'))::text || ' ' || (h.changed_at BETWEEN now() AND clock_timestamp())::text,
                     ', ' ORDER BY h.id)
   FROM settings.change h WHERE h.key = 'h.k'),
  '_>"a" true true true, "a">"b" true true true, "b">_ true true true',
  'three history rows, each with author, time, old and new value');
SELECT is(pg_temp.stored('personal', 'h.k'), NULL, 'the removed value is gone');
SELECT is((SELECT count(*)::int FROM settings.change WHERE changed_at IS NULL OR changed_by IS NULL), 0,
  'no history row lacks author or time');

-- 8. History cannot be changed or deleted: not by the owner, nor by the
-- migrator through SET ROLE; each layer refuses on its own.
CREATE FUNCTION pg_temp.try_as(p_role text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_result text := 'ok';
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_result := SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_result;
END
$$;
SELECT is(pg_temp.try_as(r.role, o.sql), '42501', format('%s: %s refused by the rights', r.role, o.sql))
FROM unnest(ARRAY['ductus_identity', 'ductus_migrator']) AS r (role)
CROSS JOIN unnest(ARRAY['UPDATE settings.change SET new_value = ''1''', 'DELETE FROM settings.change',
                        'TRUNCATE settings.change']) AS o (sql);
-- With the rights handed back, the policies still let no row be rewritten,
-- and with a policy for every command, the trigger still refuses.
GRANT UPDATE, DELETE, TRUNCATE ON settings.change TO ductus_identity;
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$WITH x AS (UPDATE settings.change SET new_value = '1' RETURNING 1) SELECT count(*)::text FROM x$$),
  '0', 'no policy lets the owner update a row');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', 'WITH x AS (DELETE FROM settings.change RETURNING 1) SELECT count(*)::text FROM x'),
  '0', 'no policy lets the owner delete a row');
SELECT is(pg_temp.try_as('ductus_identity', 'TRUNCATE settings.change'), 'ZD409', 'TRUNCATE by the owner: the trigger refuses');
CREATE POLICY test_all ON settings.change TO ductus_identity USING (true) WITH CHECK (true);
SELECT is(pg_temp.try_as('ductus_identity', o.sql), 'ZD409', format('%s with every right and policy: the trigger refuses', o.sql))
FROM unnest(ARRAY['UPDATE settings.change SET new_value = ''1''', 'DELETE FROM settings.change']) AS o (sql);
DROP POLICY test_all ON settings.change;
REVOKE UPDATE, DELETE, TRUNCATE ON settings.change FROM ductus_identity;
SELECT ok((SELECT count(*) FROM settings.change) > 10, 'the history is all still there');

SELECT * FROM finish();
ROLLBACK;
