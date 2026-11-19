-- SRV-06 (Ductus#2028, c.7008147932; PO-7): institution.notice_read and
-- institution.mark_notice_read. The student writes only through the RPC and
-- reads their own row; a teacher of the course reads the rows of its
-- assignments; another student, a teacher of another course, an
-- administrator without a relation and another institution read nothing
-- (C-23). The table is append-only, for the owner too.
-- Every person, course and assignment below is invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(31);

CREATE FUNCTION pg_temp.mark(p_actor text, p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT institution.mark_notice_read(%s)::text', p_assignment))
$$;
CREATE FUNCTION pg_temp.seen(p_actor text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT coalesce(string_agg(p.name, ' ' ORDER BY p.name), '-')
                                  FROM institution.notice_read n JOIN person p ON p.id = n.student_id $q$)
$$;
CREATE FUNCTION pg_temp.rows() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.notice_read $$;

-- 1. Only a student of the assignment marks it, and only for themselves.
SELECT is(pg_temp.mark(v.actor, v.assignment), v.answer, v.actor || ': ' || v.what)
FROM (VALUES
  (1, 'anon', '{z1}', 'ZD401: not authenticated', 'without a session is refused'),
  (2, 'expired', '{z1}', 'ZD401: not authenticated', 'with an expired session is refused'),
  (3, 'vesna', '{z1}', 'ZD403: forbidden', 'the teacher of K1 cannot mark it for herself'),
  (4, 'marko', '{z1}', 'ZD403: forbidden', 'a teacher of another course is refused'),
  (5, 'iva', '{z1}', 'ZD403: forbidden', 'the administrator, without a relation, is refused'),
  (6, 'boris', '{z1}', 'ZD403: forbidden', 'a user in no course is refused'),
  (7, 'tomo', '{z1}', 'ZD403: forbidden', 'a student of another institution is refused'),
  (8, 'ana', '{z2}', 'ZD403: forbidden', 'a student of K1 is refused for the assignment of K2'),
  (9, 'ana', '{nobody}', 'ZD403: forbidden', 'an assignment that does not exist reads as another''s'),
  (10, 'ana', 'NULL', 'ZD403: forbidden', 'no assignment is refused')
) AS v (n, actor, assignment, answer, what)
ORDER BY v.n;
SELECT is(pg_temp.rows(), 0::bigint, 'the refused calls wrote nothing');

SELECT isnt(pg_temp.mark('ana', '{z1}'), NULL, 'Ana marks the notice of Z1 as read');
SELECT is(
  (SELECT concat_ws(' ', pg_temp.id('fak_a') = institution_id, pg_temp.id('ana') = student_id, pg_temp.id('z1') = assignment_id)
     FROM institution.notice_read),
  't t t', 'one row, with her institution, herself and Z1'
);
SELECT is(pg_temp.mark('ana', '{z1}'), (SELECT read_at::text FROM institution.notice_read),
          'marking again returns the first read_at');
SELECT is(pg_temp.rows(), 1::bigint, 'and writes no second row');
SELECT isnt(pg_temp.mark('dora', '{z1}'), NULL, 'Dora marks her own');
SELECT isnt(pg_temp.mark('tomo', '{z3}'), NULL, 'Tomo of fak-b marks Z3');

-- 2. Who reads which rows.
SELECT is(pg_temp.seen(v.actor), v.seen, v.actor || ' ' || v.what)
FROM (VALUES
  (1, 'ana', 'ana', 'reads her own row only, not Dora''s'),
  (2, 'dora', 'dora', 'reads her own row only, not Ana''s'),
  (3, 'vesna', 'ana dora', 'the teacher of K1, reads both rows of Z1'),
  (4, 'marko', '-', 'a teacher of another course, reads nothing'),
  (5, 'iva', '-', 'the administrator without a relation, reads nothing'),
  (6, 'boris', '-', 'a user in no course, reads nothing'),
  (7, 'petra', 'tomo', 'the teacher of K3 at fak-b, reads only Tomo''s row'),
  (8, 'anon', '-', 'without a session, reads nothing')
) AS v (n, actor, seen, what)
ORDER BY v.n;

-- 3. The client never writes the table; the owner cannot change a row.
SELECT matches(pg_temp.ask('ana', v.sql), '^42501: permission denied for table notice_read', 'Ana: ' || v.what)
FROM (VALUES
  (1, $$ INSERT INTO institution.notice_read (institution_id, assignment_id, student_id) VALUES ({fak_a}, {z1}, {boris}) RETURNING 'x' $$, 'a direct INSERT is refused'),
  (2, $$ UPDATE institution.notice_read SET read_at = now() - interval '1 day' RETURNING 'x' $$, 'a direct UPDATE is refused'),
  (3, $$ DELETE FROM institution.notice_read RETURNING 'x' $$, 'a direct DELETE is refused')
) AS v (n, sql, what)
ORDER BY v.n;
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', v.sql), 'ZD403: notice read is append-only', 'owner: ' || v.what)
FROM (VALUES
  (1, $$ UPDATE institution.notice_read SET read_at = now() - interval '1 day' RETURNING 'x' $$, 'UPDATE is refused'),
  (2, $$ DELETE FROM institution.notice_read RETURNING 'x' $$, 'DELETE is refused'),
  (3, $$ TRUNCATE institution.notice_read $$, 'TRUNCATE is refused')
) AS v (n, sql, what)
ORDER BY v.n;

SELECT * FROM finish();
ROLLBACK;
