-- migrate:up
-- S-1N-a (DAN-847-1): the published versions of the legal texts (D-301). One
-- row is one published version of a text in one language; a change of the
-- text is a new row, and a row is never changed or removed. The text itself is
-- not here, only its SHA-256. Publishing (an RPC and its INSERT policy) comes
-- with DAN-848; the acceptances that point here come with 847-2.
--
-- No role inserts until DAN-848: the owner keeps INSERT, but with RLS forced
-- and no INSERT policy it is refused too. The owner gives up UPDATE; the
-- column UPDATE (id) that a foreign key's FOR KEY SHARE check needs comes
-- with the table that references this one (847-2).
--
-- Immutable in three layers, as public.log_entry of the logs database:
-- - rights: the app may only SELECT; the owner (the migrator) gives up UPDATE,
--   DELETE and TRUNCATE; PUBLIC and every other role hold nothing;
-- - RLS, enabled and forced, with one policy: the app reads every version (the
--   current version of each text is public, D-301);
-- - triggers ENABLE ALWAYS that refuse UPDATE, DELETE and TRUNCATE for
--   everyone, a superuser and session_replication_role = replica included.
DO $$
BEGIN
  IF current_user <> 'ductus_legal_migrator' OR current_database() <> 'ductus_legal' THEN
    RAISE EXCEPTION 'legal migrations run only as ductus_legal_migrator in ductus_legal (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE TABLE public.legal_text_version (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- D-301: terms of use, privacy notice, cookie policy. The first two are the
  -- codes of the log catalogue (server/log/events/catalog.ts, LEGAL_TEXT).
  kind text NOT NULL CONSTRAINT legal_text_version_kind CHECK (
    kind IN ('terms_of_use', 'privacy_notice', 'cookie_policy')
  ),
  -- The languages of the server's locales.
  language text NOT NULL CONSTRAINT legal_text_version_language CHECK (language IN ('hr', 'en')),
  -- The range of `version` in the legal.* events of the log catalogue.
  version integer NOT NULL CONSTRAINT legal_text_version_version CHECK (version BETWEEN 1 AND 1000000),
  content_sha256 bytea NOT NULL CONSTRAINT legal_text_version_content_sha256 CHECK (
    pg_catalog.octet_length(content_sha256) = 32
  ),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  -- D-301: every version carries the date it enters into force; whether it
  -- may lie before the publication is the publishing RPC's rule (DAN-848).
  effective_at timestamptz NOT NULL,
  CONSTRAINT legal_text_version_once UNIQUE (kind, language, version)
);

CREATE FUNCTION public.legal_text_version_refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'a published legal text version never changes: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION public.legal_text_version_refuse_change() FROM PUBLIC;

CREATE TRIGGER legal_text_version_no_change BEFORE UPDATE OR DELETE ON public.legal_text_version
  FOR EACH ROW EXECUTE FUNCTION public.legal_text_version_refuse_change();
CREATE TRIGGER legal_text_version_no_truncate BEFORE TRUNCATE ON public.legal_text_version
  FOR EACH STATEMENT EXECUTE FUNCTION public.legal_text_version_refuse_change();
ALTER TABLE public.legal_text_version ENABLE ALWAYS TRIGGER legal_text_version_no_change;
ALTER TABLE public.legal_text_version ENABLE ALWAYS TRIGGER legal_text_version_no_truncate;

ALTER TABLE public.legal_text_version ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_text_version_read ON public.legal_text_version FOR SELECT TO ductus_legal_app
  USING (true);

REVOKE ALL ON public.legal_text_version FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.legal_text_version FROM ductus_legal_migrator;
GRANT SELECT ON public.legal_text_version TO ductus_legal_app;

-- migrate:down
DROP TABLE public.legal_text_version;
DROP FUNCTION public.legal_text_version_refuse_change();
