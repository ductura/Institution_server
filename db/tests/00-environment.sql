-- DAN-721: smoke test of the CI database job. The job runs PostgreSQL with the
-- production major version (scripts/ci/postgres.ts) and pgTAP; this file makes
-- sure the job never passes with zero tests and fails on a version drift.
BEGIN;
SELECT plan(2);
SELECT is(current_setting('server_version_num')::int / 10000, 17, 'PostgreSQL major version matches production');
SELECT has_extension('pgtap', 'pgTAP is installed');
SELECT * FROM finish();
ROLLBACK;
