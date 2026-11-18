-- migrate:up
-- S-1N-a (DAN-847-1): the published versions of the legal texts (D-301). One
-- row is one published version of a text in one language; a change of the
-- text is a new row, and a row is never changed or removed. The text itself is
-- not here, only its SHA-256. Publishing (an RPC and its INSERT policy) comes
-- with DAN-848; the acceptances that point here come with 847-2.
--
-- The table lives in the application schema `legal`, never in public
-- (server/database/README.md, "Nova tablica"; the exception of the logs
-- database does not hold here). The migrator owns it; the app may resolve
-- names in it and holds nothing on the table: the one policy that passes every
-- row names only the owner, and the app reads a version through the RPC of
-- DAN-848 (SECURITY DEFINER, owned by the migrator).
--
-- No role inserts until DAN-848: the owner keeps INSERT, but with RLS forced
-- and no INSERT policy it is refused too. The owner gives up UPDATE; the
-- column UPDATE (id) that a foreign key's FOR KEY SHARE check needs comes
-- with the table that references this one (847-2).
--
-- Immutable in three layers, as public.log_entry of the logs database:
-- - rights: the owner (the migrator) gives up UPDATE, DELETE and TRUNCATE;
--   the app, PUBLIC and every other role hold nothing;
-- - RLS, enabled and forced, with one policy: the owner reads every version;
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

CREATE SCHEMA legal;
REVOKE ALL ON SCHEMA legal FROM PUBLIC;
GRANT USAGE ON SCHEMA legal TO ductus_legal_app;

CREATE TABLE legal.text_version (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- D-301: terms of use, privacy notice, cookie policy. The first two are the
  -- codes of the log catalogue (server/log/events/catalog.ts, LEGAL_TEXT).
  kind text NOT NULL CONSTRAINT text_version_kind CHECK (
    kind IN ('terms_of_use', 'privacy_notice', 'cookie_policy')
  ),
  -- The languages of the server's locales.
  language text NOT NULL CONSTRAINT text_version_language CHECK (language IN ('hr', 'en')),
  -- The range of `version` in the legal.* events of the log catalogue.
  version integer NOT NULL CONSTRAINT text_version_version CHECK (version BETWEEN 1 AND 1000000),
  content_sha256 bytea NOT NULL CONSTRAINT text_version_content_sha256 CHECK (
    pg_catalog.octet_length(content_sha256) = 32
  ),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  -- D-301: every version carries the date it enters into force; whether it
  -- may lie before the publication is the publishing RPC's rule (DAN-848).
  effective_at timestamptz NOT NULL,
  -- A row is never corrected, so neither time may be infinity.
  CONSTRAINT text_version_finite CHECK (
    pg_catalog.isfinite(published_at) AND pg_catalog.isfinite(effective_at)
  ),
  CONSTRAINT text_version_once UNIQUE (kind, language, version)
);

CREATE FUNCTION legal.text_version_refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'a published legal text version never changes: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION legal.text_version_refuse_change() FROM PUBLIC;

CREATE TRIGGER text_version_no_change BEFORE UPDATE OR DELETE ON legal.text_version
  FOR EACH ROW EXECUTE FUNCTION legal.text_version_refuse_change();
CREATE TRIGGER text_version_no_truncate BEFORE TRUNCATE ON legal.text_version
  FOR EACH STATEMENT EXECUTE FUNCTION legal.text_version_refuse_change();
ALTER TABLE legal.text_version ENABLE ALWAYS TRIGGER text_version_no_change;
ALTER TABLE legal.text_version ENABLE ALWAYS TRIGGER text_version_no_truncate;

ALTER TABLE legal.text_version ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY text_version_owner_read ON legal.text_version FOR SELECT TO ductus_legal_migrator
  USING (true);

REVOKE ALL ON legal.text_version FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON legal.text_version FROM ductus_legal_migrator;

-- migrate:down
DROP TABLE legal.text_version;
DROP FUNCTION legal.text_version_refuse_change();
DROP SCHEMA legal;
