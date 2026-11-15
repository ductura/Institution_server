-- Local and CI stack only (compose.yaml, service postgres-main); `pnpm
-- db:migrate:legal` runs it in the main database, as the compose superuser,
-- before db/legal/local/migrator.sql (S-1F-c a2, DAN-779). It stands in for
-- B0.1 and makes the legal texts database once; a second run changes nothing.
-- CREATE DATABASE cannot run in a function or a transaction, hence \gexec.
SELECT 'CREATE DATABASE ductus_legal'
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = 'ductus_legal')
\gexec
