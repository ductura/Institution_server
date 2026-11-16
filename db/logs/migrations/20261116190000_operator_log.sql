-- migrate:up
-- S-1K.5-a (DAN-835, part 835-1): the operator's read of the log chain
-- (S-1K.2-b): logins (authn.*), sessions (session.*) and every other event, by
-- kind. A function, not a view, because the read takes a window: finite,
-- p_from before p_to, at most 24 hours, read through log_entry_at, so a call
-- never reads the whole table. At most 1000 rows a call, in seq order; the
-- next call goes on after the last seq (p_after_seq). Only the reader (the
-- operator's read role, as for metric_sample) executes it, as the caller.
--
-- The payload is the LogRecord of the writer (server/log/writer.ts):
-- requestId and accountKind come out only in their shape, time and any other
-- key not at all, and of fields, per key:
-- - a key that is not ASCII letters and digits, or names a token, cookie,
--   secret, password, credential, bearer, authorization or session: left out;
-- - an object or an array: "hidden"; "none" stays;
-- - a string that is an IP address: its network, /24 for IPv4, /48 for IPv6;
-- - anything else under a key naming an address (ip, ipv4 or ipv6 as a word
--   of a camelCase key, so not membership; addr, forwarded, host, peer,
--   remote, origin anywhere): "hidden";
-- - a string holding an IPv4 or IPv6 shape, a JWT, a run of 20 or more token
--   characters with an upper-case letter and a digit, or of 20 or more hex
--   digits: "hidden".
-- The writer's catalog (S-1K.1) is the first net; this is the second.
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE INDEX log_entry_at ON public.log_entry (at);

CREATE FUNCTION public.operator_log(p_from timestamptz, p_to timestamptz, p_after_seq bigint DEFAULT 0)
RETURNS TABLE (seq bigint, at timestamptz, kind text, request_id text, account_kind text, fields jsonb)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_after_seq IS NULL
     OR NOT pg_catalog.isfinite(p_from) OR NOT pg_catalog.isfinite(p_to)
     OR p_from OPERATOR(pg_catalog.>=) p_to
     OR p_to OPERATOR(pg_catalog.-) p_from OPERATOR(pg_catalog.>) interval '24 hours' THEN
    RAISE EXCEPTION 'operator_log reads a finite window of at most 24 hours' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT e.seq, e.at, e.kind,
    CASE WHEN e.payload OPERATOR(pg_catalog.->>) 'requestId' OPERATOR(pg_catalog.~)
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN e.payload OPERATOR(pg_catalog.->>) 'requestId' END,
    CASE WHEN e.payload OPERATOR(pg_catalog.->>) 'accountKind' OPERATOR(pg_catalog.~) '^[a-z_]{1,32}$'
         THEN e.payload OPERATOR(pg_catalog.->>) 'accountKind' END,
    coalesce((
      SELECT pg_catalog.jsonb_object_agg(f.key, CASE
        WHEN pg_catalog.jsonb_typeof(f.value) OPERATOR(pg_catalog.=) ANY (ARRAY['object', 'array'])
          THEN '"hidden"'::jsonb
        WHEN f.value OPERATOR(pg_catalog.=) '"none"'::jsonb THEN f.value
        WHEN v.s IS NOT NULL AND pg_catalog.pg_input_is_valid(v.s, 'inet')
          THEN pg_catalog.to_jsonb(pg_catalog.network(pg_catalog.set_masklen(v.s::inet,
                 LEAST(pg_catalog.masklen(v.s::inet), CASE pg_catalog.family(v.s::inet) WHEN 4 THEN 24 ELSE 48 END)))::text)
        WHEN f.key OPERATOR(pg_catalog.~) '^(ip|Ip|IP)(v4|v6)?$|[a-z0-9](Ip|IP)(v4|v6)?$'
          OR pg_catalog.lower(f.key) OPERATOR(pg_catalog.~) 'addr|forwarded|host|peer|remote|origin'
          THEN '"hidden"'::jsonb
        WHEN v.s OPERATOR(pg_catalog.~) '[0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f]{0,4}:[0-9A-Fa-f]{0,4}:|eyJ|[0-9A-Fa-f]{20}'
          OR EXISTS (SELECT 1 FROM pg_catalog.regexp_matches(v.s, '[A-Za-z0-9+/_=-]{20,}', 'g') r (m)
                     WHERE r.m[1] OPERATOR(pg_catalog.~) '[A-Z]' AND r.m[1] OPERATOR(pg_catalog.~) '[0-9]')
          THEN '"hidden"'::jsonb
        ELSE f.value END)
      FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(e.payload OPERATOR(pg_catalog.->) 'fields')
                                           OPERATOR(pg_catalog.=) 'object'
                                      THEN e.payload OPERATOR(pg_catalog.->) 'fields' ELSE '{}'::jsonb END) f
      CROSS JOIN LATERAL (SELECT CASE WHEN pg_catalog.jsonb_typeof(f.value) OPERATOR(pg_catalog.=) 'string'
                                      THEN f.value OPERATOR(pg_catalog.->>) 0 END AS s) v
      WHERE f.key OPERATOR(pg_catalog.~) '^[A-Za-z][A-Za-z0-9]*$'
        AND NOT pg_catalog.lower(f.key)
          OPERATOR(pg_catalog.~) 'token|cookie|secret|password|credential|bearer|authorization|session'
    ), '{}'::jsonb)
  FROM public.log_entry e
  WHERE e.at OPERATOR(pg_catalog.>=) p_from AND e.at OPERATOR(pg_catalog.<) p_to
    AND e.seq OPERATOR(pg_catalog.>) p_after_seq
  ORDER BY e.seq
  LIMIT 1000;
END
$$;

REVOKE ALL ON FUNCTION public.operator_log(timestamptz, timestamptz, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_log(timestamptz, timestamptz, bigint) TO ductus_logs_reader;

-- migrate:down
DROP FUNCTION public.operator_log(timestamptz, timestamptz, bigint);
DROP INDEX public.log_entry_at;
