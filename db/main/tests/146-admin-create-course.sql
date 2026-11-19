-- SRV-07 (Ductus#2028, c.7008147932; A-7): institution.admin_create_course.
-- An administrator of the institution creates a course with a holder; a
-- teacher, a student and an administrator of another institution cannot. The
-- holder becomes the course's first teacher and its open holder; the
-- administrator does not become a member.
-- Every person and course below is invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(35);

CREATE FUNCTION pg_temp.create(p_actor text, p_args text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT institution.admin_create_course(%s)::text', p_args))
$$;
CREATE FUNCTION pg_temp.courses() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.course $$;
-- How a role row is locked, read from its tuple header as in
-- 123-course-handover.sql: share while a transaction holds it FOR SHARE.
CREATE EXTENSION IF NOT EXISTS pageinspect;
CREATE FUNCTION pg_temp.role_lock(p_name text, p_role text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN i.t_infomask & 4096 <> 0 THEN (
                SELECT CASE WHEN bool_or(x.mode = 'sh') THEN 'share'
                            WHEN bool_or(x.mode = 'keysh') THEN 'key share'
                            ELSE 'none' END
                  FROM pg_get_multixact_members(i.t_xmax) x)
              WHEN i.t_infomask & 80 = 80 THEN 'share'
              WHEN i.t_infomask & 80 = 16 THEN 'key share'
              ELSE 'none' END
    FROM institution.institution_role r
    CROSS JOIN LATERAL heap_page_items(get_raw_page('institution.institution_role', (r.ctid::text::point)[0]::integer)) i
   WHERE r.user_id = pg_temp.id(p_name) AND r.role = p_role AND r.revoked_at IS NULL
     AND i.lp = (r.ctid::text::point)[1]::integer
$$;
SELECT isnt(pg_temp.role_lock('iva', 'admin') || ' ' || pg_temp.role_lock('marko', 'teacher'), 'share share',
            'before any call nothing holds Iva''s administrator row or Marko''s teacher row FOR SHARE');

-- 1. Only an administrator of the institution.
SELECT is(pg_temp.create(v.actor, $$ 'Izmišljeni seminar', '2026/2027', 'encouraged', {marko} $$), v.answer, v.actor || ': ' || v.what)
FROM (VALUES
  (1, 'anon', 'ZD401: not authenticated', 'without a session is refused'),
  (2, 'expired', 'ZD401: not authenticated', 'with an expired session is refused'),
  (3, 'vesna', 'ZD403: forbidden', 'a teacher is refused'),
  (4, 'nina', 'ZD403: forbidden', 'an unconfirmed teacher is refused'),
  (5, 'ana', 'ZD403: forbidden', 'a student is refused'),
  (6, 'boris', 'ZD403: forbidden', 'a user without a role is refused'),
  (7, 'lea', 'ZD422: invalid input', 'the administrator of fak-b cannot name a teacher of fak-a')
) AS v (n, actor, answer, what)
ORDER BY v.n;

-- 2. Input and holder.
SELECT is(pg_temp.create('iva', v.args), 'ZD422: invalid input', 'Iva: ' || v.what)
FROM (VALUES
  (1, $$ '', '2026/2027', 'encouraged', {marko} $$, 'an empty name, which is no plain label'),
  (2, $$ NULL, '2026/2027', 'encouraged', {marko} $$, 'no name'),
  (3, $$ 'Seminar', '2026/2028', 'encouraged', {marko} $$, 'an academic year of two years'),
  (4, $$ 'Seminar', '2026-2027', 'encouraged', {marko} $$, 'an academic year in another form'),
  (5, $$ 'Seminar', '2026/2027', 'allowed', {marko} $$, 'an AI policy outside the three'),
  (6, $$ 'Seminar', '2026/2027', 'encouraged', {nina} $$, 'a holder whose teacher role nobody confirmed'),
  (7, $$ 'Seminar', '2026/2027', 'encouraged', {ana} $$, 'a student as holder'),
  (8, $$ 'Seminar', '2026/2027', 'encouraged', {iva} $$, 'herself, an administrator without the teacher role'),
  (9, $$ 'Seminar', '2026/2027', 'encouraged', {petra} $$, 'a teacher of another institution'),
  (10, $$ 'Seminar', '2026/2027', 'encouraged', {nobody} $$, 'a user who does not exist'),
  (11, $$ 'Seminar', '2026/2027', 'encouraged', NULL $$, 'no holder')
) AS v (n, args, what)
ORDER BY v.n;
SELECT is(pg_temp.courses(), 3::bigint, 'the refused calls created no course');

-- 3. The course, its first teacher and its holder.
CREATE TEMP TABLE created AS
SELECT pg_temp.create('iva', $$ 'Izmišljeni seminar', '2026/2027', 'encouraged', {marko} $$) AS id;
SELECT matches((SELECT id FROM created), '^[0-9a-f-]{36}$', 'Iva creates the course with Marko as holder');
-- Codex finding on #362: a revocation of either role waits for the creation.
SELECT is(pg_temp.role_lock('iva', 'admin'), 'share', 'the creation holds Iva''s administrator row FOR SHARE');
SELECT is(pg_temp.role_lock('marko', 'teacher'), 'share', 'and Marko''s teacher row');
SELECT is(
  (SELECT concat_ws(' ', c.institution_id = pg_temp.id('fak_a'), c.created_by = pg_temp.id('iva'), c.name, c.academic_year, c.ai_policy)
     FROM institution.course c WHERE c.id = (SELECT id::uuid FROM created)),
  't t Izmišljeni seminar 2026/2027 encouraged', 'in fak-a, by Iva, as asked'
);
SELECT is(
  (SELECT string_agg(p.name || ':' || m.role, ' ' ORDER BY p.name) FROM institution.course_member m JOIN person p ON p.id = m.user_id
    WHERE m.course_id = (SELECT id::uuid FROM created) AND m.member_to IS NULL),
  'marko:teacher', 'Marko is its only member, as teacher; Iva is no member'
);
SELECT is(
  (SELECT string_agg(p.name || ' by ' || a.name, ' ') FROM institution.course_holder h
     JOIN person p ON p.id = h.user_id JOIN person a ON a.id = h.assigned_by
    WHERE h.course_id = (SELECT id::uuid FROM created) AND h.valid_to IS NULL),
  'marko by iva', 'Marko is its open holder, named by Iva'
);
SELECT is(pg_temp.ask('marko', format('SELECT name FROM institution.course WHERE id = %L', (SELECT id FROM created))),
          'Izmišljeni seminar', 'Marko reads the course at once');
SELECT is(pg_temp.ask(v.actor, format('SELECT count(*) FROM institution.course WHERE id = %L', (SELECT id FROM created))), '0',
          v.actor || ' does not read it: ' || v.why)
FROM (VALUES (1, 'vesna', 'a teacher of another course'), (2, 'lea', 'another institution'), (3, 'ana', 'not enrolled'))
  AS v (n, actor, why)
ORDER BY v.n;

-- 4. The same request again, and a different one for the same course.
SELECT is(pg_temp.create('iva', $$ 'Izmišljeni seminar', '2026/2027', 'encouraged', {marko} $$), (SELECT id FROM created),
          'the same request again returns the same course');
SELECT is(pg_temp.create('iva', $$ 'Izmišljeni seminar', '2026/2027', 'prohibited', {marko} $$), 'ZD409: conflict',
          'the same course with another AI policy is a conflict');
SELECT is(pg_temp.create('iva', $$ 'Izmišljeni seminar', '2026/2027', 'encouraged', {vesna} $$), 'ZD409: conflict',
          'the same course with another holder is a conflict');
SELECT is(pg_temp.courses() || ' ' || (SELECT count(*) FROM institution.course_holder WHERE course_id = (SELECT id::uuid FROM created)),
          '4 1', 'one new course and one holder row');

-- 5. The teacher's create_course is unchanged.
SELECT matches(pg_temp.ask('vesna', $$ SELECT institution.create_course('Kolegij Vesne', '2026/2027', 'prohibited')::text $$),
               '^[0-9a-f-]{36}$', 'a teacher still creates a course with create_course');

SELECT * FROM finish();
ROLLBACK;
