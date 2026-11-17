-- DAN-840-3a (contract on Ductus#1836): identity.webauthn_credentials_for_actor
-- lists the caller's own credentials that are not revoked, for the WebAuthn
-- routes. Person and institution come from the session; nobody else's key is
-- ever in the list. Personas of institution.inc; every byte below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- Ana: two live credentials (the older first) and a revoked one; Dora of the
-- same institution and Tomo of fak-b one each; Iva none.
INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count, created_at, revoked_at)
SELECT p.id, p.institution_id, v.credential, v.key, v.count, now() - v.age,
       CASE WHEN v.revoked THEN now() END
  FROM (VALUES ('ana', '\xa2'::bytea, '\x0a02'::bytea, 7::bigint, interval '1 hour', false),
               ('ana', '\xa1', '\x0a01', 0, interval '2 hours', false),
               ('ana', '\xa3', '\x0a03', 1, interval '3 hours', true),
               ('dora', '\xd1', '\x0d01', 2, interval '1 hour', false),
               ('tomo', '\xb1', '\x0b01', 3, interval '1 hour', false)) AS v (who, credential, key, count, age, revoked)
  JOIN person p ON p.name = v.who;

-- The list p_actor sees through the web role, one text: "id:key:count;..." in the
-- order the function returns (WITH ORDINALITY of one call), or the SQLSTATE.
CREATE FUNCTION pg_temp.list(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r IS NULL OR r ~ '^[0-9A-Z]{5}: ' THEN coalesce(left(r, 5), '') ELSE r END
    FROM pg_temp.ask(p_actor,
      'SELECT coalesce(string_agg(encode(f.credential_id, ''hex'') || '':'' || encode(f.public_key, ''hex'') || '':'' || f.sign_count,
                                  '';'' ORDER BY f.n), '''')
         FROM identity.webauthn_credentials_for_actor() WITH ORDINALITY AS f (credential_id, public_key, sign_count, n)') AS r
$$;

-- 1. Without a live session nothing is listed.
SELECT is(pg_temp.list(t), 'ZD401', 'no session: ' || t)
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t;

-- 2. Only the caller's own credentials that are not revoked, the older first.
SELECT is(pg_temp.list('ana'), 'a1:0a01:0;a2:0a02:7', 'Ana sees her two live keys in order, not the revoked one');
SELECT is(pg_temp.list('dora'), 'd1:0d01:2', 'Dora of the same institution sees only her own');
SELECT is(pg_temp.list('tomo'), 'b1:0b01:3', 'Tomo of fak-b sees only his own');
SELECT is(pg_temp.list('iva'), '', 'an account without keys gets an empty list, not an error');

-- 3. A key revoked in the middle drops out of the next call.
UPDATE identity.webauthn_credential SET revoked_at = now() WHERE credential_id = '\xa1';
SELECT is(pg_temp.list('ana'), 'a2:0a02:7', 'a key revoked now drops out of the list');

-- 4. The function from the catalogue; only the web role calls it.
SELECT is(
  (SELECT p.prosecdef::text || ' ' || p.proowner::regrole::text || ' ' || p.provolatile::text || ' '
          || array_to_string(p.proconfig, ',') || ' ' || pg_get_function_result(p.oid)
     FROM pg_proc p WHERE p.oid = 'identity.webauthn_credentials_for_actor()'::regprocedure),
  'true ductus_identity s search_path="" TABLE(credential_id bytea, public_key bytea, sign_count bigint)',
  'a stable definer of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND NOT rolcanlogin
                            UNION ALL SELECT 'public') AS r
      WHERE has_function_privilege(r.rolname, 'identity.webauthn_credentials_for_actor()', 'EXECUTE') $$,
  ARRAY['ductus_app', 'ductus_identity'], 'only the web role and the owner may call it');
SELECT is(pg_temp.ask_as('ductus_auth', 'ana', 'SELECT count(*)::text FROM identity.webauthn_credentials_for_actor()'),
  '42501: permission denied for function webauthn_credentials_for_actor', 'the login role cannot call it');
SELECT doesnt_imatch((SELECT prosrc FROM pg_proc WHERE oid = 'identity.webauthn_credentials_for_actor()'::regprocedure),
  '\mEXECUTE\M', 'webauthn_credentials_for_actor runs no dynamic SQL');
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM identity.webauthn_credential'),
  '42501: permission denied for table webauthn_credential', 'the web role still cannot read the table');

SELECT * FROM finish();
ROLLBACK;
