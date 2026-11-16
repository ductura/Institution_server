-- S-1K.5-a (DAN-835, part 835-1): public.operator_log, the operator's read of
-- the log chain (logins, sessions and other events, by kind). Refused first:
-- every role but the reader (the operator's read role) and the owner, and
-- every window that is not finite, ordered and at most 24 hours. Then what the
-- read hides (a token, a cookie, a full IP, in any form of key or value) and
-- that the window is read through the index on log_entry (at), not by a scan
-- of the whole table.
--
-- The search path and the guard against planted functions are those of
-- 000-rls-everywhere.sql. The file rolls back, so nothing stays.
BEGIN;
-- Nothing below resolves through the caller's search path: "$user" or any
-- schema before pgTAP's could hold a planted is_empty, ok or operator. The
-- path is pg_catalog, pg_temp (so the helper views below, which are also
-- named with pg_temp., come before anything in pgTAP's schema), then the
-- schema pgTAP lives in, and nothing else. pg_temp is never searched for
-- functions or operators.
SET LOCAL search_path TO pg_catalog, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA public;
SET LOCAL lc_messages TO 'C';
-- pgTAP's schema can also hold objects that are not pgTAP's (the migrator
-- owns each database and may create in public): a function there that is not
-- part of an extension and carries the name of a pgTAP or pg_catalog
-- function, or any such operator, could change what the assertions compute.
-- This raises rather than asserts, as a planted object could bend the
-- assertion itself.
DO $$
DECLARE
  tap_schema name;
  planted text;
BEGIN
  SELECT n.nspname INTO STRICT tap_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) e.extnamespace
  WHERE e.extname OPERATOR(pg_catalog.=) 'pgtap';
  PERFORM pg_catalog.set_config('search_path', pg_catalog.format('pg_catalog, pg_temp, %I', tap_schema), true);

  SELECT pg_catalog.string_agg(x.found, ', ') INTO planted FROM (
    SELECT p.oid::pg_catalog.regprocedure::text AS found FROM pg_catalog.pg_proc p
    WHERE p.pronamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND p.pronamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) p.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                  WHERE q.proname OPERATOR(pg_catalog.=) p.proname
                    AND (q.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace
                         OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                                    WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                                      AND d.objid OPERATOR(pg_catalog.=) q.oid
                                      AND d.deptype OPERATOR(pg_catalog.=) 'e')))
    UNION ALL
    SELECT o.oid::pg_catalog.regoperator::text FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND o.oprnamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_operator'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) o.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
  ) x;
  IF planted IS NOT NULL THEN
    RAISE EXCEPTION 'a function or operator beside pgTAP shadows pgTAP or pg_catalog: %', planted;
  END IF;
END
$$;


SELECT plan(37);

-- As in 030-metric-sample.sql: runs `sql` as `who`; the SQLSTATE, or 'ok'.
CREATE FUNCTION pg_temp.try_as(who text, sql text) RETURNS text
  LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', who);
    EXECUTE sql;
    RESET ROLE;
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
  END;
END
$$;
-- The read as the reader, one JSON object per row, in seq order.
CREATE FUNCTION pg_temp.read(p_from timestamptz, p_to timestamptz, p_after bigint DEFAULT 0) RETURNS jsonb
  LANGUAGE plpgsql AS $$
DECLARE
  got jsonb;
BEGIN
  SET LOCAL ROLE ductus_logs_reader;
  SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.seq), '[]') INTO got
  FROM public.operator_log(p_from, p_to, p_after) o;
  RESET ROLE;
  RETURN got;
END
$$;
-- Who holds EXECUTE, inherited or by SET ROLE; PUBLIC as 'public'.
CREATE VIEW pg_temp.read_right AS
  SELECT DISTINCT r.rolname || CASE WHEN g.rolname = r.rolname THEN '' ELSE ' via ' || g.rolname END AS found
  FROM (SELECT x.oid, x.rolname::text FROM pg_catalog.pg_roles x
        WHERE NOT x.rolsuper AND x.rolname NOT LIKE 'pg\_%'
        UNION ALL SELECT 0, 'public') AS r (oid, rolname)
  JOIN LATERAL (SELECT y.rolname::text FROM pg_catalog.pg_roles y
                WHERE r.oid = 0 AND y.oid = 0 OR r.oid <> 0 AND pg_has_role(r.oid, y.oid, 'MEMBER')
                UNION ALL SELECT 'public' WHERE r.oid = 0) AS g (rolname) ON true
  WHERE has_function_privilege(g.rolname, 'public.operator_log(timestamptz, timestamptz, bigint)', 'EXECUTE');

-- 1. Refused first: every role but the reader and the owner (K1). The
-- application role and an ordinary login role stand in as ductus_app.
SELECT set_eq('SELECT found FROM pg_temp.read_right', ARRAY['ductus_logs_migrator', 'ductus_logs_reader'],
  'only the owner and the reader (the operator) may execute operator_log');
CREATE ROLE ductus_app NOLOGIN;
SELECT is(pg_temp.try_as(w.who, 'SELECT * FROM public.operator_log(now() - interval ''1 hour'', now())'),
  '42501', w.who || ' may not read operator_log')
FROM unnest(ARRAY['ductus_logs_writer', 'ductus_logs_retention', 'ductus_app']) w (who);
GRANT ductus_logs_writer TO ductus_app;
SELECT is(pg_temp.try_as('ductus_app', 'SELECT * FROM public.operator_log(now() - interval ''1 hour'', now())'),
  '42501', 'the application role is refused through membership of the writer as well');
GRANT ductus_logs_reader TO ductus_app;
SELECT set_eq($$ SELECT found FROM pg_temp.read_right WHERE found LIKE 'ductus\_app%' $$,
  ARRAY['ductus_app', 'ductus_app via ductus_logs_reader'], 'a right reached through membership of the reader is caught');
REVOKE ductus_logs_reader, ductus_logs_writer FROM ductus_app;
DROP ROLE ductus_app;

-- 2. Refused windows (K3): not finite, not ordered, longer than 24 hours.
SELECT is(pg_temp.try_as('ductus_logs_reader',
  pg_catalog.format('SELECT * FROM public.operator_log(%L, %L, %L)', w.f, w.t, w.a)), '22023', 'refused: ' || w.why)
FROM (VALUES
  (NULL, '2026-11-16 12:00+00', 0, 'no start'), ('2026-11-16 12:00+00', NULL, 0, 'no end'),
  ('2026-11-16 11:00+00', '2026-11-16 12:00+00', NULL, 'no seq to go on after'),
  ('-infinity', '2026-11-16 12:00+00', 0, 'start -infinity'), ('2026-11-16 12:00+00', 'infinity', 0, 'end infinity'),
  ('2026-11-16 12:00+00', '2026-11-16 12:00+00', 0, 'empty'), ('2026-11-16 12:00+00', '2026-11-16 11:00+00', 0, 'reversed'),
  ('2026-11-15 11:59:59.999999+00', '2026-11-16 12:00+00', 0, '24 hours and a microsecond')
) w (f, t, a, why);
SELECT is(pg_temp.try_as('ductus_logs_reader',
  $$ SELECT * FROM public.operator_log('2026-11-15 12:00+00', '2026-11-16 12:00+00') $$),
  'ok', 'a window of exactly 24 hours is read');

-- 3. The window: p_from in, p_to out; at most 1000 rows, then on after a seq.
CREATE TABLE pg_temp.edge AS SELECT clock_timestamp() AS started;
INSERT INTO public.log_entry (kind, payload) VALUES ('test.first', '{}');
SELECT pg_sleep(0.002);
INSERT INTO public.log_entry (kind, payload) VALUES ('test.middle', '{}');
SELECT pg_sleep(0.002);
INSERT INTO public.log_entry (kind, payload) VALUES ('test.last', '{}');
CREATE TABLE pg_temp.mark AS SELECT
  (SELECT at FROM public.log_entry WHERE kind = 'test.first' AND at >= (SELECT started FROM pg_temp.edge)) AS first_at,
  (SELECT at FROM public.log_entry WHERE kind = 'test.last' AND at >= (SELECT started FROM pg_temp.edge)) AS last_at;
SELECT is((SELECT jsonb_agg(x->>'kind' ORDER BY (x->>'seq')::bigint)
           FROM jsonb_array_elements(pg_temp.read((SELECT first_at FROM pg_temp.mark), (SELECT last_at FROM pg_temp.mark))) x),
  '["test.first", "test.middle"]'::jsonb, 'a row at p_from is read, a row at p_to is not');
INSERT INTO public.log_entry (kind, payload) SELECT 'test.bulk', '{}' FROM generate_series(1, 1001);
CREATE TABLE pg_temp.page AS SELECT pg_temp.read((SELECT first_at FROM pg_temp.mark), clock_timestamp()) AS rows;
SELECT is((SELECT jsonb_array_length(rows) FROM pg_temp.page), 1000, 'a call gives at most 1000 rows');
SELECT is(jsonb_array_length(pg_temp.read((SELECT first_at FROM pg_temp.mark), clock_timestamp(),
                                          (SELECT (rows->-1->>'seq')::bigint FROM pg_temp.page))),
  4, 'the next call goes on after the last seq and gives the rest');

-- 4. What the read hides (K2), one record per class, as the writer stores it.
CREATE TABLE pg_temp.mask_case (n int PRIMARY KEY, fields jsonb, expected jsonb, why text);
INSERT INTO pg_temp.mask_case VALUES
  (1, '{"method": "GET", "route": "/api/v1/auth/logout", "ip": "192.0.2.77", "status": 200, "durationMs": 12, "ipRule": "allowed", "rateLimit": "allowed"}',
      '{"method": "GET", "route": "/api/v1/auth/logout", "ip": "192.0.2.0/24", "status": 200, "durationMs": 12, "ipRule": "allowed", "rateLimit": "allowed"}',
      'traffic.request as checkEvent makes it: the IP keeps its /24, the rest stays'),
  (2, '{"IP": "2001:db8:1234:5678::1"}', '{"IP": "2001:db8:1234::/48"}', 'IPv6 keeps its /48'),
  (3, '{"ip": "10.1.2.3/8"}', '{"ip": "10.0.0.0/8"}', 'a wider mask is not narrowed, the host is cut'),
  (4, '{"ip": "::ffff:192.0.2.77"}', '{"ip": "::/48"}', 'IPv4-mapped IPv6'),
  (5, '{"host": "192.0.2.77", "peer": "198.51.100.9", "origin": "203.0.113.5"}',
      '{"host": "192.0.2.0/24", "peer": "198.51.100.0/24", "origin": "203.0.113.0/24"}', 'an address under any key'),
  (6, '{"forwardedFor": "192.0.2.77, 198.51.100.9", "note": "from 192.0.2.77", "v6": "fe80::1%eth0"}',
      '{"forwardedFor": "hidden", "note": "hidden", "v6": "hidden"}', 'an address inside a longer string'),
  (7, '{"ipAddress": 3221226061, "remoteAddr": null, "ipv4": true}',
      '{"ipAddress": "hidden", "remoteAddr": "hidden", "ipv4": "hidden"}', 'a number, null or flag under an address key'),
  (8, '{"ip": "none", "membership": "member"}', '{"ip": "none", "membership": "member"}', 'none and a plain word stay'),
  (9, '{"ip": "192.0.2.77\r\n", "peerIp": " 192.0.2.77"}', '{"ip": "hidden", "peerIp": "hidden"}', 'CRLF or a space'),
  (10, '{"ip": {"v": "192.0.2.77"}, "route": ["x"]}', '{"ip": "hidden", "route": "hidden"}', 'an object or an array'),
  (11, '{"ip ": "1", "ip\t": "1", "ip\r\n": "1", "ip\u007f": "1", "client_ip": "1", "іp": "1"}', '{}',
       'a key with NBSP, tab, CRLF, DEL, an underscore or a homoglyph is left out'),
  (12, '{"__proto__": "x", "toString": "y"}', '{"toString": "y"}', 'inherited names: only the plain key stays'),
  (13, '{"token": "a", "idToken": "b", "SessionCookie": "c", "sessionId": "d", "clientSecret": "e", "Password": "f", "Authorization": "g", "bearer": "h", "credential": "i"}',
       '{}', 'keys naming a token, cookie, session, secret, password, authorization, bearer or credential'),
  (14, '{"sid": "Qm9vX2EzZjk4NzY1NDMyMXp5", "jwt": "eyJhbGciOiJIUzI1NiJ9.e30.x", "hex": "0123456789abcdef0123", "reason": "second_factor_required"}',
       '{"sid": "hidden", "jwt": "hidden", "hex": "hidden", "reason": "second_factor_required"}',
       'a token under an innocent key is hidden, a long code stays');
INSERT INTO public.log_entry (kind, payload)
  SELECT 'test.mask_' || c.n, jsonb_build_object('time', '2026-11-16T12:00:00.000Z', 'event', 'traffic.request',
           'requestId', '0b7e4f0e-6a43-4c3c-9d7e-2f1a5b6c7d8e', 'accountKind', 'anonymous', 'fields', c.fields)
  FROM pg_temp.mask_case c ORDER BY c.n;
INSERT INTO public.log_entry (kind, payload)
  VALUES ('test.shape', '{"requestId": "0B7E-not-a-uuid", "accountKind": "Anonymous ", "fields": "192.0.2.77", "cookie": "c"}');
CREATE TABLE pg_temp.got AS
  SELECT x FROM jsonb_array_elements(pg_temp.read(clock_timestamp() - interval '1 hour', clock_timestamp(),
    (SELECT max(seq) FROM public.log_entry WHERE kind = 'test.bulk'))) x;
SELECT is((SELECT g.x->'fields' FROM pg_temp.got g WHERE g.x->>'kind' = 'test.mask_' || c.n), c.expected, c.why)
FROM pg_temp.mask_case c ORDER BY c.n;
SELECT is((SELECT g.x - 'seq' - 'at' FROM pg_temp.got g WHERE g.x->>'kind' = 'test.mask_1'),
  '{"kind": "test.mask_1", "request_id": "0b7e4f0e-6a43-4c3c-9d7e-2f1a5b6c7d8e", "account_kind": "anonymous", "fields": {"method": "GET", "route": "/api/v1/auth/logout", "ip": "192.0.2.0/24", "status": 200, "durationMs": 12, "ipRule": "allowed", "rateLimit": "allowed"}}'::jsonb,
  'a row gives seq, at, kind, request id, account kind and fields, nothing else of the record');
SELECT is((SELECT g.x - 'seq' - 'at' FROM pg_temp.got g WHERE g.x->>'kind' = 'test.shape'),
  '{"kind": "test.shape", "request_id": null, "account_kind": null, "fields": {}}'::jsonb,
  'a request id or account kind out of shape, fields that are no object and other keys give nothing');

-- 5. The window is read through log_entry_at, not by a scan of the table or
-- of another index (K3). enable_seqscan = off shows that the predicate can
-- use the index; the negative control drops it and the check sees the change.
CREATE FUNCTION pg_temp.scans() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_object_agg(c.relname, pg_stat_get_xact_numscans(c.oid)) FROM pg_class c
  WHERE c.oid = 'public.log_entry'::regclass
     OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = 'public.log_entry'::regclass) $$;
CREATE FUNCTION pg_temp.scan_change() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  before jsonb := pg_temp.scans();
  after jsonb;
BEGIN
  PERFORM pg_temp.read(clock_timestamp() - interval '1 hour', clock_timestamp());
  after := pg_temp.scans();
  RETURN (SELECT jsonb_object_agg(k, (after->>k)::bigint - (before->>k)::bigint) FROM jsonb_object_keys(after) k);
END
$$;
SET LOCAL enable_seqscan = off;
SELECT is(pg_temp.scan_change(),
  '{"log_entry": 0, "log_entry_at": 1, "log_entry_pkey": 0, "log_entry_seq_unique": 0, "log_entry_prev_hash_unique": 0}'::jsonb,
  'a call scans log_entry_at once, and no table and no other index');
SAVEPOINT without_index;
DROP INDEX public.log_entry_at;
SELECT isnt((pg_temp.scan_change()->>'log_entry_seq_unique')::int + (pg_temp.scan_change()->>'log_entry')::int, 0,
  'negative control: without log_entry_at the read scans the table or another index');
ROLLBACK TO SAVEPOINT without_index;
RESET enable_seqscan;
SELECT is_empty('SELECT * FROM public.log_chain_verify()', 'the chain stays whole');

SELECT * FROM finish();
ROLLBACK;
