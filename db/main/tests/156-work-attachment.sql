-- SRV-10B (Ductus#2051; schema v4 §5): the attachments of a student's work,
-- the images of the document. The student records the own; a reader of the
-- work (teacher or collaborator of the course, seminar group teacher, mentor)
-- reads them, by work and by id; nobody changes or removes one. Every person,
-- course, hash and storage reference below is invented
-- (fixtures/institution.inc, fixtures/mentorship.inc).
BEGIN;
\ir fixtures/institution.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SET LOCAL lc_messages TO 'C';

SELECT plan(65);

-- 'ok' (new), 'same' (the row already there) or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.add(p_actor text, p_assignment text, p_sha text,
                            p_type text DEFAULT 'image/png', p_size integer DEFAULT 2048,
                            p_ref text DEFAULT 'privitci/izmisljeno',
                            p_width integer DEFAULT 640, p_height integer DEFAULT 480) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r = 'true' THEN 'ok' WHEN r = 'false' THEN 'same' ELSE substr(r, 1, 5) END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT created::text FROM institution.add_work_attachment(%s, %L, %s, %L, %L, %s, %s)',
      p_assignment, p_type, coalesce(p_size::text, 'NULL'), p_sha, p_ref,
      coalesce(p_width::text, 'NULL'), coalesce(p_height::text, 'NULL'))) AS r) x
$$;
-- The first five hex digits of each hash read, oldest first and joined with
-- '|', '-' for none, or the SQLSTATE.
CREATE FUNCTION pg_temp.hashes(p_actor text, p_assignment text, p_student text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT coalesce(string_agg(left(sha256, 5), ''|'' ORDER BY created_at, id), ''-'') FROM institution.work_attachments(%s, %s)',
      p_assignment, p_student)) AS r) x
$$;
CREATE FUNCTION pg_temp.read(p_actor text, p_attachment text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT left(sha256, 5) || '' '' || media_type || '' '' || byte_size FROM institution.read_work_attachment(%s)',
      p_attachment)) AS r) x
$$;

-- 1. Catalogue: the table, its RLS, its triggers and who may call what.
SELECT table_owner_is('institution', 'work_attachment', 'ductus_identity', 'the owner role owns the attachments');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.work_attachment'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'institution' AND tablename = 'work_attachment' $$,
  ARRAY['work_attachment_owner ALL to ductus_identity'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_app')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.add_work_attachment(uuid,text,integer,text,text,integer,integer)',
                             'institution.work_attachments(uuid,uuid)',
                             'institution.read_work_attachment(uuid)',
                             'institution.refuse_work_attachment_change()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role and the owner execute the RPCs; nobody else, nor PUBLIC'
);
SELECT ok(NOT has_function_privilege('ductus_app', 'institution.refuse_work_attachment_change()', 'EXECUTE'),
  'the web role does not execute the trigger function');

-- 2. The input: checked before the relation, so a refusal says nothing of
-- the assignment.
SELECT is(pg_temp.add('ana', '{z1}', t.sha, t.typ, t.size, t.ref, t.w, t.h), 'ZD422', t.label)
FROM (VALUES
  (repeat('a', 64), 'image/svg+xml', 2048, 'privitci/x', 640, 480, 'an SVG is refused'),
  (repeat('a', 64), 'image/gif', 2048, 'privitci/x', 640, 480, 'a GIF is refused'),
  (repeat('a', 64), 'IMAGE/PNG', 2048, 'privitci/x', 640, 480, 'a file type in capitals is refused'),
  (repeat('a', 64), NULL, 2048, 'privitci/x', 640, 480, 'no file type is refused'),
  (repeat('a', 64), 'image/png', 0, 'privitci/x', 640, 480, 'an empty file is refused'),
  (repeat('a', 64), 'image/png', 5242881, 'privitci/x', 640, 480, 'a file over 5 MiB is refused'),
  (repeat('a', 64), 'image/png', NULL, 'privitci/x', 640, 480, 'no size is refused'),
  (repeat('A', 64), 'image/png', 2048, 'privitci/x', 640, 480, 'a hash in capitals is refused'),
  (repeat('a', 63), 'image/png', 2048, 'privitci/x', 640, 480, 'a hash of 63 digits is refused'),
  (repeat('g', 64), 'image/png', 2048, 'privitci/x', 640, 480, 'a hash that is not hex is refused'),
  (repeat('a', 64), 'image/png', 2048, 'privitci/a b', 640, 480, 'a storage reference with a space is refused'),
  (repeat('a', 64), 'image/png', 2048, '', 640, 480, 'an empty storage reference is refused'),
  (repeat('a', 64), 'image/png', 2048, repeat('r', 1025), 640, 480, 'a storage reference over 1024 is refused'),
  (repeat('a', 64), 'image/png', 2048, 'privitci/x', 640, NULL, 'a width without a height is refused'),
  (repeat('a', 64), 'image/png', 2048, 'privitci/x', 0, 480, 'a width of 0 is refused'),
  (repeat('a', 64), 'image/png', 2048, 'privitci/x', 640, 20001, 'a height over 20000 is refused')
) AS t (sha, typ, size, ref, w, h, label);
SELECT is(pg_temp.add('boris', '{z1}', repeat('a', 63)), 'ZD422',
  'the input is checked before the relation, so its refusal says nothing of the assignment');

-- 3. A new attachment, the same bytes again, the stored row.
SELECT is(pg_temp.add('ana', '{z1}', repeat('a', 64), 'image/png', 5242880, repeat('r', 1024), NULL, NULL), 'ok',
  'Ana records a PNG of 5 MiB without a known size in pixels');
SELECT is(pg_temp.add('ana', '{z1}', repeat('a', 64), 'image/jpeg', 10, 'privitci/drugi'), 'same',
  'the same bytes again answer the row already there');
SELECT is(pg_temp.add('ana', '{z1}', repeat('b', 64), 'image/jpeg', 4096, 'privitci/b'), 'ok',
  'Ana records a JPEG');
SELECT results_eq(
  $$ SELECT p.name, w.institution_id, w.media_type, w.byte_size, w.pixel_width, length(w.storage_ref)
       FROM institution.work_attachment w JOIN person p ON p.id = w.student_id ORDER BY w.created_at, w.id $$,
  $$ VALUES ('ana', pg_temp.id('fak_a'), 'image/png', 5242880, NULL::integer, 1024),
            ('ana', pg_temp.id('fak_a'), 'image/jpeg', 4096, 640, 10) $$,
  'two rows, Ana''s, of her institution; the repeat kept the first type, size and reference'
);
SELECT ok((SELECT bool_and(id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
             FROM institution.work_attachment),
  'every id is a lowercase UUID v4, as the document''s attachmentId');
INSERT INTO ref SELECT 'att_a', id::text FROM institution.work_attachment WHERE sha256 = repeat('a', 64);
SELECT is(pg_temp.hashes('ana', '{z1}', 'NULL'), 'aaaaa|bbbbb', 'Ana reads both, oldest first');
SELECT is(pg_temp.read('ana', '{att_a}'), 'aaaaa image/png 5242880', 'and one by id');
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.work_attachment (institution_id, assignment_id, student_id, media_type, byte_size, sha256, storage_ref) VALUES (%L, %L, %L, %L, 1, %L, %L)',
  pg_temp.id('fak_b'), pg_temp.id('z1'), pg_temp.id('ana'), 'image/png', repeat('c', 64), 'x')), 1, 5), '23503',
  'an attachment cannot combine an assignment and a student of another institution');
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.work_attachment (id, institution_id, assignment_id, student_id, media_type, byte_size, sha256, storage_ref) VALUES (%L, %L, %L, %L, %L, 1, %L, %L)',
  'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'image/png',
  repeat('c', 64), 'x')), 1, 5), '23514',
  'the table refuses an id that is not a UUID v4');

-- 4. Append-only, even for the owner role.
SELECT throws_ok($$ UPDATE institution.work_attachment SET byte_size = 1 $$, 'ZD403', NULL, 'no row is changed');
SELECT throws_ok($$ DELETE FROM institution.work_attachment $$, 'ZD403', NULL, 'no row is removed');
SELECT throws_ok($$ TRUNCATE institution.work_attachment $$, 'ZD403', NULL, 'the table is not truncated');

-- 5. Who reads besides the student: teacher, seminar group teacher, mentor.
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok',
  'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok',
  'fixture: Ana joins G1');
SELECT is(pg_temp.add('dora', '{z1}', repeat('a', 64)), 'ok',
  'Dora records the same bytes in her own work: another work, another attachment');
INSERT INTO ref SELECT 'att_d', id::text FROM institution.work_attachment
 WHERE student_id = pg_temp.id('dora');
SELECT is(pg_temp.hashes(c.actor, c.assignment, c.student), c.outcome,
  format('%s reads the attachments of %s on %s: %s', c.actor, c.student, c.assignment, c.outcome))
FROM (VALUES
  ('marko', '{z1}', '{ana}', 'aaaaa|bbbbb'), ('marko', '{z1}', '{dora}', 'ZD403'),
  ('vesna', '{z1}', '{dora}', 'aaaaa'), ('dora', '{z1}', '{dora}', 'aaaaa'),
  ('ana', '{z1}', '{dora}', 'ZD403'), ('vesna', '{z1}', '{vesna}', 'ZD403'), ('vesna', '{z1}', '{nobody}', 'ZD403'),
  ('vesna', 'NULL', '{ana}', 'ZD403')
) AS c (actor, assignment, student, outcome);
SELECT is(pg_temp.read(c.actor, c.att), c.outcome, format('%s reads %s by id: %s', c.actor, c.att, c.outcome))
FROM (VALUES
  ('marko', '{att_a}', 'aaaaa image/png 5242880'), ('marko', '{att_d}', 'ZD403'),
  ('ana', '{att_d}', 'ZD403'), ('dora', '{att_d}', 'aaaaa image/png 2048'), ('lea', '{att_a}', 'ZD403'),
  ('vesna', 'NULL', 'ZD403')
) AS c (actor, att, outcome);
SELECT is(pg_temp.add('marko', '{z1}', repeat('e', 64)), 'ZD403',
  'the seminar group teacher records no attachment in his own name');
SELECT is(pg_temp.add('ana', '{zm1}', repeat('c', 64)), 'ok',
  'Ana records an attachment on the mentorship''s assignment, apart from Z1');
SELECT is(pg_temp.hashes('marko', '{zm1}', '{ana}'), 'ccccc', 'her mentor reads it');
SELECT is(pg_temp.hashes('vesna', '{zm1}', '{ana}'), 'ZD403', 'the teacher of K1 does not');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'no read of the attachments writes the access log');

-- 6. At most 200 attachments and 100 MiB per work; the same bytes still pass.
INSERT INTO institution.work_attachment (institution_id, assignment_id, student_id, media_type, byte_size, sha256, storage_ref)
SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), 'image/png', 1, lpad(to_hex(n), 64, 'f'), 'x'
  FROM generate_series(1, 199) n;
SELECT is(pg_temp.add('dora', '{z1}', repeat('d', 64)), 'ZD422', 'the 201st attachment is refused');
SELECT is(pg_temp.add('dora', '{z1}', repeat('a', 64)), 'same', 'the same bytes as one of the 200 still answer it');
SELECT is(pg_temp.add('ana', '{z1}', repeat('d', 64), 'image/png', 5242880), 'ok',
  'Ana''s work has its own bound');
INSERT INTO institution.work_attachment (institution_id, assignment_id, student_id, media_type, byte_size, sha256, storage_ref)
SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'image/png', 5242880, lpad(to_hex(n), 64, 'e'), 'x'
  FROM generate_series(1, 17) n;
SELECT is(pg_temp.add('ana', '{z1}', repeat('6', 64), 'image/png', 5238784), 'ok',
  'an attachment that makes exactly 100 MiB together passes');
SELECT is(pg_temp.add('ana', '{z1}', repeat('9', 64), 'image/png', 1), 'ZD422',
  'one more byte over 100 MiB together is refused');

-- 7. A removed student keeps the attachments but neither adds nor reads them.
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('ana') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.add('ana', '{z1}', repeat('8', 64)), 'ZD403', 'removed: no new attachment');
SELECT is(pg_temp.read('ana', '{att_a}'), 'ZD403', 'removed: no read');

-- 8. A mistaken grant to the web role still reaches no row.
GRANT SELECT, INSERT, UPDATE, DELETE ON institution.work_attachment TO ductus_app;
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM institution.work_attachment'), '0',
  'mistaken grant: SELECT sees 0 rows');
SELECT is(substr(pg_temp.ask('dora', format(
  'INSERT INTO institution.work_attachment (institution_id, assignment_id, student_id, media_type, byte_size, sha256, storage_ref) VALUES (%L, %L, %L, %L, 1, %L, %L)',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), 'image/png', repeat('7', 64), 'x')), 1, 5), '42501',
  'mistaken grant: INSERT is refused by RLS');

SELECT * FROM finish();
ROLLBACK;
