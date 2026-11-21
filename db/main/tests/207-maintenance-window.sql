BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SET LOCAL ROLE ductus_identity;
SELECT lives_ok($$
  INSERT INTO identity.maintenance_window (kind, starts_at, ends_at) VALUES
    ('planned', now() - interval '1 hour', now() + interval '1 hour'),
    ('planned', now() + interval '2 hours', now() + interval '3 hours'),
    ('planned', now() - interval '3 hours', now() - interval '2 hours'),
    ('outage', now() - interval '2 hours', now() - interval '1 hour')
$$, 'the operator can record maintenance and a confirmed outage');
SELECT throws_ok($$
  INSERT INTO identity.maintenance_window (kind, starts_at, ends_at)
  VALUES ('planned', now() - interval '1 hour', now() + interval '1 hour')
$$, '23505', NULL, 'the same window cannot be recorded twice');
SELECT throws_ok($$
  INSERT INTO identity.maintenance_window (kind, starts_at, ends_at) VALUES ('planned', now(), now())
$$, '23514', NULL, 'an empty window is refused');
SELECT throws_ok($$
  INSERT INTO identity.maintenance_window (kind, starts_at, ends_at) VALUES ('planned', now(), 'infinity')
$$, '23514', NULL, 'an unbounded window is refused');
SELECT throws_ok($$
  INSERT INTO identity.maintenance_window (kind, starts_at, ends_at)
  VALUES ('outage', now(), now() + interval '1 hour')
$$, '23514', NULL, 'an outage must have ended to be recorded');
SELECT is((SELECT count(*) FROM identity.maintenance_window WHERE kind = 'outage'), 1::bigint,
  'the operator can retrieve an outage as evidence');

SET LOCAL ROLE ductus_app;
SELECT throws_ok($$
  INSERT INTO identity.maintenance_window (kind, starts_at, ends_at)
  VALUES ('planned', now(), now() + interval '1 hour')
$$, '42501', NULL, 'the application cannot write maintenance');
SELECT throws_ok('SELECT * FROM identity.maintenance_window', '42501', NULL, 'the application cannot read the ledger');
SELECT results_eq('SELECT * FROM identity.public_maintenance_windows()', $$ VALUES
  ((now() - interval '1 hour')::timestamptz(3), (now() + interval '1 hour')::timestamptz(3)),
  ((now() + interval '2 hours')::timestamptz(3), (now() + interval '3 hours')::timestamptz(3))
$$, 'only current and upcoming planned times are returned, in order');

SET LOCAL ROLE ductus_auth;
SELECT throws_ok('SELECT * FROM identity.public_maintenance_windows()', '42501', NULL,
  'the authentication role cannot call the public projection');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
