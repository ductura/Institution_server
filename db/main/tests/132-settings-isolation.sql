-- DAN-801 (S-1J-e): settings.set_value orders the writes of a key with an
-- advisory lock, which holds only when every statement takes a fresh
-- snapshot. Under REPEATABLE READ a bound and a lower write could miss each
-- other, so the call refuses any level but READ COMMITTED (ZD500) before it
-- reads anything, as institution.enroll_with_code does. The fixture cannot
-- be loaded under REPEATABLE READ (sessions need READ COMMITTED), and no
-- person is needed: the refusal comes first.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lc_messages TO 'C';
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

-- The SQLSTATE and message of p_sql run as ductus_app, or 'ok'.
CREATE FUNCTION pg_temp.as_app(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_result text := 'ok';
BEGIN
  SET LOCAL ROLE ductus_app;
  PERFORM set_config('app.session_token', repeat('A', 43), true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_result := SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_result;
END
$$;

SELECT is(current_setting('transaction_isolation'), 'repeatable read', 'this file runs under REPEATABLE READ');
SELECT is(pg_temp.as_app($$SELECT settings.set_value('personal', NULL, 'a.b', '1')$$),
  'ZD500: READ COMMITTED required', 'a personal write is refused');
SELECT is(pg_temp.as_app($$SELECT settings.set_value('institution', NULL, 'a.b', NULL, '{"max": 1}')$$),
  'ZD500: READ COMMITTED required', 'a bound is refused');

SELECT * FROM finish();
ROLLBACK;
