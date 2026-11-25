-- SRV-V19-RECENZIJA-BAZA (val 19, docs/contracts/peer-review-v1.md): anonymous
-- peer review between students, led by the teacher. The teacher sets one round
-- per assignment and allocates it once (deterministic by the round id, no self
-- review, no mutual pair, at least max(5, 2k + 1) submitted works); the reviewer
-- reads only the blocks {kind, text} of the one work allocated to them while the
-- round runs, and writes a review once; the author reads the reviews of their
-- own work without the reviewer and without the withdrawn ones; the teacher
-- sees both ends and withdraws a review; every record is only ever added;
-- anything that is not the relation (another course, another institution, an
-- unknown id, another's task, an author's own work) is the same refusal.
-- Personas of institution.inc and evidence-acceptance.inc, plus invented
-- students Ivo, Jana, Karlo, Lena and Maja of K1 (Boris joins K1 too). Ana has
-- only an opened work (the fixture) and never submits. Every
-- work is an invented document that carries markers (MARK) in the cover, the
-- sources, attributes, link addresses, captions and atoms: none may leave.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- More students of K1 (invented names; sessions of one letter each, lowercase).
INSERT INTO person (name, id, institution_id, faculty)
SELECT n.name, ('00000000-0000-4000-8000-0000000002' || lpad(n.n::text, 2, '0'))::uuid,
       pg_temp.id('fak_a'), 'fak-a'
  FROM (VALUES ('ivo', 1), ('jana', 2), ('karlo', 3), ('lena', 4), ('maja', 5)) AS n (name, n);
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
SELECT p.id, p.institution_id, 'https://issuer.test', 'sub-' || p.name, p.name || '@fak-a.example'
  FROM person p WHERE p.name IN ('ivo', 'jana', 'karlo', 'lena', 'maja');
INSERT INTO tok SELECT p.name, repeat(chr(96 + row_number() OVER (ORDER BY p.id)::integer), 43)
  FROM person p WHERE p.name IN ('ivo', 'jana', 'karlo', 'lena', 'maja');
INSERT INTO ref SELECT p.name, p.id::text FROM person p WHERE p.name IN ('ivo', 'jana', 'karlo', 'lena', 'maja');
INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
SELECT sha256(convert_to(t.token, 'UTF8')), p.id, p.institution_id, now() + interval '1 hour'
  FROM person p JOIN tok t USING (name) WHERE p.name IN ('ivo', 'jana', 'karlo', 'lena', 'maja');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
SELECT pg_temp.id('k1'), pg_temp.id('fak_a'), p.id, 'student'
  FROM person p WHERE p.name IN ('boris', 'ivo', 'jana', 'karlo', 'lena', 'maja');
INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
SELECT pg_temp.id(n.who), pg_temp.id('fak_a'), n.given, n.family
  FROM (VALUES ('ana', 'Ana', 'Horvat'), ('dora', 'Dora', 'Babić'), ('boris', 'Boris', 'Anić'),
               ('ivo', 'Ivo', 'Kovač'), ('jana', 'Jana', 'Lukić'), ('karlo', 'Karlo', 'Marić'),
               ('lena', 'Lena', 'Novak'), ('maja', 'Maja', 'Opačak')) AS n (who, given, family);

-- 'ok' or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.code(p_actor text, p_sql text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE 'ok' END FROM (SELECT pg_temp.ask(p_actor, p_sql) AS r) x
$$;
-- The refusal with its message ('ZD409: already_allocated').
CREATE FUNCTION pg_temp.msg(p_actor text, p_sql text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN r ELSE 'ok' END FROM (SELECT pg_temp.ask(p_actor, p_sql) AS r) x
$$;
-- The assignment of the course round, as rubric json.
CREATE FUNCTION pg_temp.rubrics(p_n integer) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_agg(jsonb_build_object('key', 'r' || g, 'label', 'Rubrika ' || g))::text FROM generate_series(1, p_n) g
$$;
-- Set the round of Z1: k reviews, two rubrics, open since an hour, due in a day.
CREATE FUNCTION pg_temp.set_round(p_actor text, p_k integer, p_rubrics text DEFAULT NULL,
                                  p_assignment text DEFAULT '{z1}') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.msg(p_actor, format(
    'SELECT 1 FROM app.set_peer_review_round(%s, now() - interval ''1 hour'', now() + interval ''1 day'', %s, %L::jsonb)',
    p_assignment, p_k, coalesce(p_rubrics, pg_temp.rubrics(2))))
$$;
-- The task ids of a reviewer (owner's reading), in the order of the ids.
CREATE FUNCTION pg_temp.task(p_reviewer text, p_n integer DEFAULT 1) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM institution.peer_review_allocation WHERE reviewer_id = pg_temp.id(p_reviewer)
   ORDER BY id LIMIT 1 OFFSET p_n - 1
$$;
-- Who wrote the work of a task (owner's reading).
CREATE FUNCTION pg_temp.author_of(p_task uuid) RETURNS text LANGUAGE sql AS $$
  SELECT p.name FROM institution.peer_review_allocation a JOIN person p ON p.id = a.author_id WHERE a.id = p_task
$$;
-- The whole result of the work of a task, as json (to look for anything that must not be in it).
CREATE FUNCTION pg_temp.work_json(p_actor text, p_task uuid) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.ord)::text, '[]') FROM app.peer_review_work(%L) w $q$, p_task))
$$;
-- The blocks of the work of a task as one line.
CREATE FUNCTION pg_temp.work_blocks(p_actor text, p_task uuid) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT string_agg(w.kind || ':' || w.body, '|' ORDER BY w.ord) FROM app.peer_review_work(%L) w $q$, p_task))
$$;
CREATE FUNCTION pg_temp.review(p_actor text, p_task uuid, p_by_rubric text, p_general text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.msg(p_actor, format('SELECT 1 FROM app.add_peer_review(%L, %L::jsonb, %L)', p_task, p_by_rubric, p_general))
$$;
CREATE FUNCTION pg_temp.good_review(p_n integer DEFAULT 2) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_agg(jsonb_build_object('key', 'r' || g, 'text', 'Tekst recenzije ' || g))::text FROM generate_series(1, p_n) g
$$;
CREATE FUNCTION pg_temp.round_line(p_actor text, p_assignment text DEFAULT '{z1}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT concat_ws('|', state, submitted_works, min_submissions, reviews_per_student,
                                                          allocated_at IS NOT NULL) FROM app.peer_review_round(%s) $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.tasks_line(p_actor text, p_assignment text DEFAULT '{z1}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT string_agg(concat_ws(' ', round_state, task_state), ' / ' ORDER BY task_state)
                                          FROM app.peer_review_tasks(%s) $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.received_json(p_actor text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.submitted_at, r.review_id)::text, '[]')
                                    FROM app.peer_reviews_received({z1}) r $q$)
$$;

-- The words of a work are not the name of its author (what an author writes about themselves is theirs).
CREATE FUNCTION pg_temp.lbl(p_tag text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'T' || substr(md5(p_tag), 1, 6) $$;
-- An invented work: heading, a paragraph with a link and a citation, a bullet
-- item, a quote, a box, a code block with a caption, a table and a formula, an
-- empty paragraph; the cover, the sources, an attribute on every block and a
-- signature carry markers.
CREATE FUNCTION pg_temp.doc(p_tag text) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 4,
    'cover', jsonb_build_object('study', 'COVERMARK-' || p_tag, 'place', 'Zagreb', 'date', 'studeni 2026.'),
    'signature', 'SIGNMARK-' || p_tag,
    'sources', jsonb_build_array(jsonb_build_object('id', 'SRC-' || p_tag, 'title', 'SRCMARK-' || p_tag)),
    'nodes', jsonb_build_array(
      jsonb_build_object('type', 'heading', 'id', gen_random_uuid(), 'level', 1, 'author', 'ATTRMARK-' || p_tag,
        'children', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Naslov ' || pg_temp.lbl(p_tag), 'marks', '[]'::jsonb))),
      jsonb_build_object('type', 'paragraph', 'id', gen_random_uuid(), 'author', 'ATTRMARK-' || p_tag,
        'children', jsonb_build_array(
          jsonb_build_object('type', 'text', 'text', 'Prvi ', 'marks', '[]'::jsonb),
          jsonb_build_object('type', 'text', 'text', 'odlomak',
            'marks', jsonb_build_array(jsonb_build_object('type', 'link', 'href', 'https://example.invalid/HREFMARK-' || p_tag))),
          jsonb_build_object('type', 'citation', 'sourceId', 'SRC-' || p_tag),
          jsonb_build_object('type', 'text', 'text', ' kraj', 'marks', '[]'::jsonb))),
      jsonb_build_object('type', 'bulletItem', 'id', gen_random_uuid(),
        'children', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Stavka ' || pg_temp.lbl(p_tag), 'marks', '[]'::jsonb))),
      jsonb_build_object('type', 'quote', 'id', gen_random_uuid(),
        'children', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Navod ' || pg_temp.lbl(p_tag), 'marks', '[]'::jsonb))),
      jsonb_build_object('type', 'box', 'id', gen_random_uuid(), 'kind', 'remark', 'children', jsonb_build_array(
        jsonb_build_object('type', 'paragraph', 'id', gen_random_uuid(),
          'children', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'U okviru ' || pg_temp.lbl(p_tag), 'marks', '[]'::jsonb))))),
      jsonb_build_object('type', 'codeBlock', 'id', gen_random_uuid(), 'caption', 'CAPTIONMARK-' || p_tag,
        'children', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'x = 1', 'marks', '[]'::jsonb))),
      jsonb_build_object('type', 'table', 'id', gen_random_uuid(), 'title', 'TABLEMARK-' || p_tag),
      jsonb_build_object('type', 'formula', 'id', gen_random_uuid(), 'tex', 'FORMULAMARK-' || p_tag),
      jsonb_build_object('type', 'paragraph', 'id', gen_random_uuid(), 'children', '[]'::jsonb)
    ))::text
$$;
-- What a reviewer must read of the work of p_tag.
CREATE FUNCTION pg_temp.expected(p_tag text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format('heading:Naslov %1$s|paragraph:Prvi odlomak kraj|list_item:Stavka %1$s|quote:Navod %1$s|'
                'paragraph:U okviru %1$s|paragraph:x = 1', pg_temp.lbl(p_tag))
$$;

-- Submit the works of the given students (written by the evidence owner, as the submission is in the real flow).
CREATE TEMP TABLE due AS
SELECT due_at AS z1_due FROM institution.assignment_version WHERE assignment_id = pg_temp.id('z1') AND version_no = 2;
GRANT SELECT ON due TO PUBLIC;
CREATE TEMP TABLE works (who text PRIMARY KEY, body text NOT NULL, hash text NOT NULL, req uuid NOT NULL DEFAULT gen_random_uuid());
GRANT SELECT ON works TO PUBLIC;
CREATE FUNCTION pg_temp.submit(p_names text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO works (who, body, hash) SELECT n, pg_temp.doc(n), '' FROM unnest(p_names) n;
  UPDATE works SET hash = encode(sha256(convert_to(body, 'UTF8')), 'hex') WHERE who = ANY (p_names);
  SET CONSTRAINTS ALL DEFERRED;
  SET LOCAL ROLE ductus_evidence;
  INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
  SELECT 'project-pr-' || w.who, pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id(w.who)
    FROM works w WHERE w.who = ANY (p_names);
  INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
  SELECT 'doc-pr-' || w.who, pg_temp.id('fak_a'), 'project-pr-' || w.who, pg_temp.id(w.who),
         encode(sha256(convert_to('rev0-' || w.who, 'UTF8')), 'hex')
    FROM works w WHERE w.who = ANY (p_names);
  INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
  SELECT 'doc-pr-' || w.who, pg_temp.id('fak_a'), 0, NULL, pg_temp.id(w.who),
         encode(sha256(convert_to('rev0-' || w.who, 'UTF8')), 'hex')
    FROM works w WHERE w.who = ANY (p_names)
  UNION ALL
  SELECT 'doc-pr-' || w.who, pg_temp.id('fak_a'), 1, 0, pg_temp.id(w.who), w.hash
    FROM works w WHERE w.who = ANY (p_names);
  INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
  SELECT 'doc-pr-' || w.who, pg_temp.id('fak_a'), 1, w.body FROM works w WHERE w.who = ANY (p_names);
  INSERT INTO evidence.submission_request (id, institution_id, assignment_id, assignment_version, project_id, document_id,
                                           principal_id, revision, content_hash, requested_at)
  SELECT w.req, pg_temp.id('fak_a'), pg_temp.id('z1'), 2, 'project-pr-' || w.who, 'doc-pr-' || w.who,
         pg_temp.id(w.who), 1, w.hash, now() - interval '1 hour'
    FROM works w WHERE w.who = ANY (p_names);
  INSERT INTO evidence.submission (submission_request_id, institution_id, principal_id, assignment_id, assignment_version,
                                   revision, artifact_hash, requested_at, due_at, recorded_at)
  SELECT q.id, q.institution_id, q.principal_id, q.assignment_id, q.assignment_version, q.revision, q.content_hash,
         q.requested_at, (SELECT z1_due FROM due), q.requested_at + interval '2 seconds'
    FROM evidence.submission_request q WHERE q.id IN (SELECT w.req FROM works w WHERE w.who = ANY (p_names));
  SET CONSTRAINTS ALL IMMEDIATE;
  RESET ROLE;
END
$$;

-- Catalogue: forced RLS, no direct privilege, no runtime role on the record.
SELECT is((SELECT string_agg(format('%s|%s|%s', c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole), ',' ORDER BY c.relname)
             FROM pg_class c WHERE c.oid = ANY (ARRAY['institution.peer_review_round'::regclass,
                  'institution.peer_review_allocation'::regclass, 'institution.peer_review'::regclass,
                  'institution.peer_review_withdrawal'::regclass])),
  't|t|ductus_identity,t|t|ductus_identity,t|t|ductus_identity,t|t|ductus_identity',
  'the tables belong to the identity role, with RLS forced');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  CROSS JOIN unnest(ARRAY['institution.peer_review_round', 'institution.peer_review_allocation',
                          'institution.peer_review', 'institution.peer_review_withdrawal']) AS t
  WHERE has_table_privilege(r, t, p)
), 'no runtime role reads or writes the review tables directly');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.peer_review_allocation $$),
  '42501: permission denied for table peer_review_allocation', 'the web role reads no review table');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.peer_review_submitted({z1}) $$),
  '42501: permission denied for function peer_review_submitted', 'the evidence helper of submissions is not callable by the web role');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.peer_review_blocks({z1}, gen_random_uuid()) $$),
  '42501: permission denied for function peer_review_blocks', 'the evidence helper of text is not callable by the web role');
SELECT is((SELECT array_agg(a ORDER BY o) FROM pg_proc p, unnest(p.proargnames) WITH ORDINALITY u (a, o)
            WHERE p.oid = 'app.peer_review_work(uuid)'::regprocedure),
  ARRAY['p_task_id', 'rubrics', 'ord', 'kind', 'body'],
  'the work of a task has only the rubrics and the blocks: no person, document, submission, assignment or course');
SELECT is((SELECT array_agg(a ORDER BY o) FROM pg_proc p, unnest(p.proargnames) WITH ORDINALITY u (a, o)
            WHERE p.oid = 'app.peer_reviews_received(uuid)'::regprocedure),
  ARRAY['p_assignment_id', 'review_id', 'by_rubric', 'general', 'submitted_at'],
  'the received reviews have only the review and its texts: no reviewer, task or round');
SELECT is((SELECT array_agg(a ORDER BY o) FROM pg_proc p, unnest(p.proargnames) WITH ORDINALITY u (a, o)
            WHERE p.oid = 'app.peer_review_tasks(uuid)'::regprocedure),
  ARRAY['p_assignment_id', 'round_state', 'task_id', 'task_state', 'due_at'],
  'the tasks have only the task id, its state and the due time');
SELECT is((institution.peer_review_min_submissions(1), institution.peer_review_min_submissions(2),
           institution.peer_review_min_submissions(3))::text, '(5,5,7)', 'the fewest submitted works is max(5, 2k + 1)');

-- Before any round: nothing, and only the teachers of K1 read the round.
SELECT is(pg_temp.round_line('vesna'), 'none|0|5|f', 'an assignment with no round reads as none, with no work submitted');
SELECT is(pg_temp.code(a.name, 'SELECT 1 FROM app.peer_review_round({z1})'), 'ZD404', a.name || ' does not read the round of Z1 as a teacher')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('lea'), ('tomo'), ('ivo')) AS a (name);
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.peer_review_round({z1})'), 'ZD401', 'without a session nothing is read');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.peer_review_round({z3})'), 'ZD404', 'Vesna does not read another institution''s assignment');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.peer_review_round({nobody})'), 'ZD404', 'an unknown assignment reads 404');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.peer_review_round(NULL)'), 'ZD404', 'a missing assignment reads 404');
SELECT is(pg_temp.tasks_line('ana'), 'none', 'a student sees no task and no round before one is allocated');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.peer_review_tasks({z1})'), 'ZD404', 'a teacher is no student of the assignment');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.peer_reviews_received({z1})'), 'ZD404', 'a teacher reads no received reviews');
SELECT is(pg_temp.code('boris', 'SELECT 1 FROM app.peer_review_tasks({z2})'), 'ZD404', 'a student of another course reads 404');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM app.peer_reviews_received({z1}) $$), '0', 'no received reviews before any round');
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD404: not found', 'nothing is allocated without a round');

-- Setting the round: the teachers of K1 only; closed input.
SELECT is(pg_temp.set_round(a.name, 1), 'ZD404: not found', a.name || ' does not set the round of Z1')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('ivo')) AS a (name);
SELECT is(pg_temp.code('anon', format('SELECT 1 FROM app.set_peer_review_round({z1}, now(), now() + interval ''1 day'', 1, %L::jsonb)', pg_temp.rubrics(1))),
  'ZD401', 'without a session nothing is set');
SELECT is(pg_temp.set_round('vesna', 1, NULL, '{z3}'), 'ZD404: not found', 'another institution''s assignment is not set');
SELECT is(pg_temp.set_round('vesna', 1, NULL, '{nobody}'), 'ZD404: not found', 'an unknown assignment is not set');
SELECT is(pg_temp.set_round('vesna', v.k, v.r), 'ZD422: invalid input', 'refused: ' || v.why)
FROM (VALUES (0, NULL, 'no review per student'), (4, NULL, '4 reviews per student'), (-1, NULL, 'negative reviews'),
             (1, '[]', 'no rubric'), (1, '{}', 'rubrics not an array'), (1, 'null', 'rubrics null'),
             (1, '[{"key":"a","label":"A"},{"key":"a","label":"B"}]', 'a key twice'),
             (1, '[{"key":"A","label":"A"}]', 'an uppercase key'),
             (1, '[{"key":"-a","label":"A"}]', 'a key that starts with a hyphen'),
             (1, '[{"key":"a b","label":"A"}]', 'a key with a space'),
             (1, '[{"key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","label":"A"}]', 'a key of 41 characters'),
             (1, '[{"key":"a","label":""}]', 'an empty label'),
             (1, '[{"key":"a","label":" A"}]', 'a label with a space at the edge'),
             (1, E'[{"key":"a","label":"A\\nB"}]', 'a label of two lines'),
             (1, '[{"key":"a","label":"A","points":3}]', 'a rubric with points'),
             (1, '[{"key":"a"}]', 'a rubric with no label'),
             (1, '["a"]', 'a rubric that is not an object'),
             (1, '[{"key":1,"label":"A"}]', 'a key that is a number'),
             (1, (SELECT jsonb_agg(jsonb_build_object('key', 'r' || g, 'label', 'L' || g))::text FROM generate_series(1, 7) g), 'seven rubrics'),
             (1, (SELECT jsonb_build_array(jsonb_build_object('key', 'a', 'label', repeat('x', 121)))::text), 'a label of 121 code points')) AS v (k, r, why);
SELECT is(pg_temp.msg('vesna', $$ SELECT 1 FROM app.set_peer_review_round({z1}, now(), now(), 1, '[{"key":"a","label":"A"}]') $$),
  'ZD422: invalid input', 'refused: the round opens when it is due');
SELECT is(pg_temp.msg('vesna', $$ SELECT 1 FROM app.set_peer_review_round({z1}, now() + interval '1 day', now(), 1, '[{"key":"a","label":"A"}]') $$),
  'ZD422: invalid input', 'refused: the round opens after it is due');
SELECT is(pg_temp.msg('vesna', $$ SELECT 1 FROM app.set_peer_review_round({z1}, NULL, now(), 1, '[{"key":"a","label":"A"}]') $$),
  'ZD422: invalid input', 'refused: no opening time');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_round), 0, 'a refused round leaves no version');
SELECT is(pg_temp.set_round('vesna', 3), 'ok', 'Vesna sets the round, three reviews per student');
SELECT is(pg_temp.set_round('vesna', 3, pg_temp.rubrics(3)), 'ok', 'setting it again replaces it while it is not allocated');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_round), 2, 'each setting is a version');
SELECT is(pg_temp.round_line('vesna'), 'not_allocated|0|7|3|f', 'the round is not allocated; seven works are the fewest for three reviews');
SELECT is(pg_temp.ask('vesna', $$ SELECT rubrics::text FROM app.peer_review_round({z1}) $$), pg_temp.rubrics(3)::jsonb::text, 'the latest version holds');

-- Allocation: too few submitted works writes nothing.
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD409: too_few_submissions', 'no submitted work: too few');
SELECT is(pg_temp.code('ana', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD404', 'a student does not allocate');
SELECT is(pg_temp.code('marko', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD404', 'a teacher of another course does not allocate');
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD401', 'without a session nothing is allocated');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.allocate_peer_review({z3})'), 'ZD404', 'another institution''s assignment is not allocated');

-- Four works submitted: still too few (even for one review per student the fewest is five).
SELECT pg_temp.submit(ARRAY['dora', 'boris', 'ivo', 'jana']);
SELECT is(pg_temp.round_line('vesna'), 'not_allocated|4|7|3|f', 'the teacher sees how many works are submitted and why the allocation does not go');
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD409: too_few_submissions', 'four works: too few');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_allocation), 0, 'a refused allocation writes nothing');
SELECT pg_temp.submit(ARRAY['karlo']);
SELECT is(pg_temp.round_line('vesna'), 'not_allocated|5|7|3|f', 'five works are submitted');
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD409: too_few_submissions',
  'five works are too few for three reviews per student (the fewest is seven)');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_allocation), 0, 'still nothing is written');
-- A round that is not allocated may be replaced: two reviews per student need five works.
SELECT is(pg_temp.set_round('vesna', 2), 'ok', 'Vesna sets two reviews per student');
SELECT is(pg_temp.round_line('vesna'), 'not_allocated|5|5|2|f', 'five works are the fewest for two reviews');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ok', 'five works are allocated');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_allocation), 10, 'five students review two works each');
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.allocate_peer_review({z1})'), 'ZD409: already_allocated', 'a round is allocated once');
SELECT is(pg_temp.set_round('vesna', 1), 'ZD409: already_allocated', 'an allocated round is not replaced');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_allocation), 10, 'a refused allocation adds nothing');

-- The allocation: nobody reviews their own work, nobody and nobody else review each other, everyone reviews and
-- is reviewed twice, only submitted students take part, and it is a pure function of the round id.
SELECT is((SELECT count(*)::integer FROM institution.peer_review_allocation WHERE reviewer_id = author_id), 0, 'nobody reviews their own work');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_allocation a
            JOIN institution.peer_review_allocation b ON a.reviewer_id = b.author_id AND a.author_id = b.reviewer_id), 0,
  'no two students review each other');
SELECT is((SELECT string_agg(n::text, ',' ORDER BY who) FROM (
             SELECT p.name AS who, count(*) AS n FROM institution.peer_review_allocation a JOIN person p ON p.id = a.reviewer_id
              GROUP BY p.name) x), '2,2,2,2,2', 'everyone reviews exactly two works');
SELECT is((SELECT string_agg(n::text, ',' ORDER BY who) FROM (
             SELECT p.name AS who, count(*) AS n FROM institution.peer_review_allocation a JOIN person p ON p.id = a.author_id
              GROUP BY p.name) x), '2,2,2,2,2', 'every work is reviewed exactly twice');
SELECT is((SELECT string_agg(DISTINCT p.name, ',' ORDER BY p.name) FROM institution.peer_review_allocation a JOIN person p ON p.id = a.reviewer_id),
  'boris,dora,ivo,jana,karlo', 'only students with a submitted work take part (Ana, Lena and Maja do not)');
SELECT is((SELECT count(DISTINCT (reviewer_id, author_id))::integer FROM institution.peer_review_allocation), 10, 'nobody reviews the same work twice');
SELECT results_eq($$ SELECT p.reviewer_id, p.author_id
    FROM institution.peer_review_pairs((SELECT id FROM institution.peer_review_round ORDER BY seq DESC LIMIT 1),
           ARRAY(SELECT principal_id FROM evidence.submission), 2) p ORDER BY 1, 2 $$,
  $$ SELECT reviewer_id, author_id FROM institution.peer_review_allocation ORDER BY 1, 2 $$,
  'the stored allocation is the pure function of the round id and the submitted works');
SELECT results_eq($$ SELECT p.reviewer_id, p.author_id FROM institution.peer_review_pairs('00000000-0000-4000-8000-0000000000f1',
      ARRAY(SELECT principal_id FROM evidence.submission ORDER BY principal_id), 2) p ORDER BY 1, 2 $$,
  $$ SELECT p.reviewer_id, p.author_id FROM institution.peer_review_pairs('00000000-0000-4000-8000-0000000000f1',
      ARRAY(SELECT principal_id FROM evidence.submission ORDER BY principal_id DESC), 2) p ORDER BY 1, 2 $$,
  'the same round and the same works give the same allocation, whatever the order they come in');
SELECT ok((SELECT count(DISTINCT alloc) > 1 FROM (
             SELECT (SELECT string_agg(p.reviewer_id::text || p.author_id::text, '' ORDER BY p.reviewer_id, p.author_id)
                       FROM institution.peer_review_pairs(gs.r, ARRAY(SELECT principal_id FROM evidence.submission), 2) p) AS alloc
               FROM (SELECT ('00000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS r FROM generate_series(10, 40) g) gs) x),
  'the round id is the seed: other round ids give other allocations');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM generate_series(1, 3) k, generate_series(7, 12) n,
         LATERAL (SELECT array_agg(gen_random_uuid()) AS s FROM generate_series(1, n)) st
   WHERE n >= 2 * k + 1 AND (
     EXISTS (SELECT 1 FROM institution.peer_review_pairs('00000000-0000-4000-8000-0000000000aa', st.s, k) p WHERE p.reviewer_id = p.author_id)
     OR EXISTS (SELECT 1 FROM institution.peer_review_pairs('00000000-0000-4000-8000-0000000000aa', st.s, k) p
                  JOIN institution.peer_review_pairs('00000000-0000-4000-8000-0000000000aa', st.s, k) q
                    ON p.reviewer_id = q.author_id AND p.author_id = q.reviewer_id)
     OR (SELECT count(*) FROM institution.peer_review_pairs('00000000-0000-4000-8000-0000000000aa', st.s, k)) <> n * k)),
  'for every k and n from 2k + 1: no self review, no mutual pair, exactly n * k tasks');

-- The round and the tasks.
SELECT is(pg_temp.round_line('vesna'), 'open|5|5|2|t', 'the round is open and allocated');
SELECT is(pg_temp.tasks_line('dora'), 'open pending / open pending', 'a student with a work sees two pending tasks');
SELECT is(pg_temp.tasks_line('ana'), 'none', 'Ana did not submit: no task');
SELECT is(pg_temp.tasks_line('lena'), 'none', 'Lena did not submit: no task');
SELECT is(pg_temp.code('tomo', 'SELECT 1 FROM app.peer_review_tasks({z1})'), 'ZD404', 'a student of another institution reads 404');
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.peer_review_tasks({z1})'), 'ZD401', 'without a session no task is read');
SELECT is(pg_temp.code('dora', 'SELECT 1 FROM app.peer_review_tasks({nobody})'), 'ZD404', 'an unknown assignment reads 404');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM app.peer_review_tasks({z1}) WHERE task_id IS NOT NULL $$), '2', 'two tasks carry an id');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM app.peer_review_tasks({z1}) t
    JOIN institution.peer_review_allocation a ON a.id = t.task_id $$), '42501: permission denied for table peer_review_allocation',
  'the tasks are only a view for the web role');

-- The work: the reviewer of a task reads only {kind, text}; nothing that leads to the author.
CREATE TEMP TABLE probe AS SELECT pg_temp.task('dora', 1) AS t1, pg_temp.task('dora', 2) AS t2;
GRANT SELECT ON probe TO PUBLIC;
SELECT is(pg_temp.work_blocks('dora', (SELECT t1 FROM probe)), pg_temp.expected(pg_temp.author_of((SELECT t1 FROM probe))),
  'Dora reads exactly the text blocks of the first work: no cover, source, caption, atom, citation or empty block');
SELECT is(pg_temp.work_blocks('dora', (SELECT t2 FROM probe)), pg_temp.expected(pg_temp.author_of((SELECT t2 FROM probe))),
  'and of the second work');
SELECT is(pg_temp.author_of((SELECT t1 FROM probe)) <> pg_temp.author_of((SELECT t2 FROM probe)), true, 'the two works are by two students');
SELECT ok(pg_temp.work_json('dora', (SELECT t1 FROM probe)) !~ 'MARK',
  'no marker of the cover, sources, attributes, links, captions, atoms or signature is in the whole result');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM institution.peer_review_allocation a
      CROSS JOIN LATERAL (SELECT pg_temp.work_json(p.name, a.id) AS j FROM person p WHERE p.id = a.reviewer_id) w
      CROSS JOIN LATERAL (SELECT p.id::text AS pid, p.name AS pname FROM person p WHERE p.id = a.author_id) au
     WHERE w.j LIKE '%' || au.pid || '%' OR w.j ~* au.pname OR w.j LIKE '%' || a.author_work_ref::text || '%'
        OR w.j LIKE '%' || a.assignment_id::text || '%' OR w.j LIKE '%' || a.institution_id::text || '%'
        OR w.j LIKE '%' || a.reviewer_id::text || '%' OR w.j LIKE '%project-%' OR w.j LIKE '%doc-%'
        OR w.j LIKE '%' || (SELECT id::text FROM institution.course LIMIT 1) || '%'
  ), 'in no work of the round is the author, the reviewer, the work, the document, the assignment or the course (searched over the whole json)');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM institution.peer_review_allocation a
      CROSS JOIN LATERAL jsonb_array_elements(pg_temp.work_json((SELECT p.name FROM person p WHERE p.id = a.reviewer_id), a.id)::jsonb) e
     WHERE e ->> 'kind' NOT IN ('paragraph', 'heading', 'quote', 'list_item')
        OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) <> ARRAY['body', 'kind', 'ord', 'rubrics']),
  'every row has only a closed kind, the text, the order and the rubrics');
SELECT is(pg_temp.ask('dora', format($$ SELECT rubrics::text FROM app.peer_review_work(%L) LIMIT 1 $$, (SELECT t1 FROM probe))),
  pg_temp.rubrics(2)::jsonb::text, 'the rubrics of the round come with the work');
SELECT is(pg_temp.code(a.name, format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT t1 FROM probe))), 'ZD404', a.name || ' does not read the work of the task of Dora')
FROM (VALUES ('ana'), ('boris'), ('ivo'), ('jana'), ('karlo'), ('lena'), ('vesna'), ('marko'), ('iva'), ('tomo')) AS a (name);
SELECT is(pg_temp.code(pg_temp.author_of((SELECT t1 FROM probe)), format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT t1 FROM probe))), 'ZD404',
  'the author does not read the task of their own work');
SELECT is(pg_temp.code('dora', 'SELECT 1 FROM app.peer_review_work(gen_random_uuid())'), 'ZD404', 'an unknown task reads 404');
SELECT is(pg_temp.code('dora', 'SELECT 1 FROM app.peer_review_work(NULL)'), 'ZD404', 'a missing task reads 404');
SELECT is(pg_temp.code('anon', format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT t1 FROM probe))), 'ZD401', 'without a session no work is read');
SELECT is(pg_temp.code('dora', format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT a.id FROM institution.peer_review_allocation a WHERE a.reviewer_id = pg_temp.id('ivo') LIMIT 1))),
  'ZD404', 'a task of another student reads 404');
SELECT is(pg_temp.code('dora', format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT a.author_work_ref FROM institution.peer_review_allocation a WHERE a.id = (SELECT t1 FROM probe)))),
  'ZD404', 'a submission id is no task id');

-- Writing the review: closed input, once, by the reviewer only.
SELECT is(pg_temp.review('dora', (SELECT t1 FROM probe), v.r, v.g), 'ZD422: invalid input', 'refused: ' || v.why)
FROM (VALUES ('[]', NULL, 'no rubric text'),
             ('[{"key":"r1","text":"a"}]', NULL, 'one of two rubrics'),
             ('[{"key":"r1","text":"a"},{"key":"r1","text":"b"}]', NULL, 'a rubric twice'),
             ('[{"key":"r1","text":"a"},{"key":"r3","text":"b"}]', NULL, 'an unknown rubric'),
             ('[{"key":"r1","text":"a"},{"key":"r2","text":""}]', NULL, 'an empty text'),
             ('[{"key":"r1","text":"a"},{"key":"r2","text":"b","extra":1}]', NULL, 'an extra field'),
             ('[{"key":"r1","text":"a"},{"key":"r2"}]', NULL, 'a rubric without text'),
             ('[{"key":"r1","text":"a"},{"key":"r2","text":5}]', NULL, 'a text that is a number'),
             ('{"r1":"a","r2":"b"}', NULL, 'an object instead of an array'),
             ('null', NULL, 'null'),
             ((SELECT jsonb_build_array(jsonb_build_object('key', 'r1', 'text', repeat('x', 4001)), jsonb_build_object('key', 'r2', 'text', 'b'))::text), NULL, 'a text of 4001 code points'),
             (pg_temp.good_review(), '', 'an empty general text'),
             (pg_temp.good_review(), repeat('x', 4001), 'a general text of 4001 code points')) AS v (r, g, why);
SELECT is((SELECT count(*)::integer FROM institution.peer_review), 0, 'a refused review writes nothing');
SELECT is(pg_temp.review('ana', (SELECT t1 FROM probe), pg_temp.good_review()), 'ZD404: not found', 'Ana does not write the review of the task of Dora');
SELECT is(pg_temp.review('vesna', (SELECT t1 FROM probe), pg_temp.good_review()), 'ZD404: not found', 'a teacher does not write a review');
SELECT is(pg_temp.review(pg_temp.author_of((SELECT t1 FROM probe)), (SELECT t1 FROM probe), pg_temp.good_review()), 'ZD404: not found',
  'the author does not review their own work');
SELECT is(pg_temp.review('dora', gen_random_uuid(), pg_temp.good_review()), 'ZD404: not found', 'an unknown task reads 404');
SELECT is(pg_temp.code('anon', format('SELECT 1 FROM app.add_peer_review(%L, %L::jsonb, NULL)', (SELECT t1 FROM probe), pg_temp.good_review())), 'ZD401', 'without a session nothing is written');
SELECT is(pg_temp.review('dora', (SELECT t1 FROM probe), pg_temp.good_review(), 'Opći dojam.'), 'ok', 'Dora writes the review of the first work');
SELECT is(pg_temp.review('dora', (SELECT t1 FROM probe), pg_temp.good_review()), 'ZD409: already_reviewed', 'a review is written once');
SELECT is(pg_temp.tasks_line('dora'), 'open pending / open submitted', 'the task is submitted, the other is pending');
SELECT is(pg_temp.review('dora', (SELECT t2 FROM probe), pg_temp.good_review()), 'ok', 'Dora writes the review of the second work (no general text)');
SELECT is(pg_temp.tasks_line('dora'), 'open submitted / open submitted', 'both tasks are submitted');
SELECT is((SELECT count(*)::integer FROM institution.peer_review), 2, 'two reviews are written');
SELECT is(pg_temp.review('dora', (SELECT t1 FROM probe), pg_temp.good_review()), 'ZD409: already_reviewed', 'still once');
SELECT is(pg_temp.work_blocks('dora', (SELECT t1 FROM probe)), pg_temp.expected(pg_temp.author_of((SELECT t1 FROM probe))),
  'the reviewer may still read the work after writing the review while the round runs');

-- The author reads the reviews of the own work, never the reviewer.
SELECT is(pg_temp.ask(pg_temp.author_of((SELECT t1 FROM probe)), $$ SELECT count(*) FROM app.peer_reviews_received({z1}) $$), '1',
  'the author of the first work reads one review');
SELECT is(pg_temp.ask(pg_temp.author_of((SELECT t1 FROM probe)), $$ SELECT string_agg(e ->> 'label' || '=' || (e ->> 'text'), ';' ORDER BY ord)
    FROM app.peer_reviews_received({z1}) r, jsonb_array_elements(r.by_rubric) WITH ORDINALITY x (e, ord) $$),
  'Rubrika 1=Tekst recenzije 1;Rubrika 2=Tekst recenzije 2', 'the texts come by rubric, in its order, with the label');
SELECT is(pg_temp.ask(pg_temp.author_of((SELECT t1 FROM probe)), $$ SELECT general FROM app.peer_reviews_received({z1}) $$), 'Opći dojam.', 'with the general text');
SELECT is(pg_temp.ask(pg_temp.author_of((SELECT t2 FROM probe)), $$ SELECT coalesce(general, 'none') FROM app.peer_reviews_received({z1}) $$), 'none',
  'no general text reads as null');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM institution.peer_review r JOIN institution.peer_review_allocation a ON a.id = r.task_id
      CROSS JOIN LATERAL (SELECT pg_temp.received_json(p.name) AS j FROM person p WHERE p.id = a.author_id) w
     WHERE w.j LIKE '%' || a.reviewer_id::text || '%' OR w.j LIKE '%' || a.id::text || '%' OR w.j LIKE '%' || a.round_id::text || '%'
        OR w.j ~* 'Babić' OR w.j ~* 'dora' OR w.j LIKE '%' || a.author_work_ref::text || '%'
        OR w.j LIKE '%' || a.assignment_id::text || '%'),
  'the received reviews carry no reviewer, task, round, name, work or assignment (searched over the whole json)');
SELECT is((SELECT array_agg(k ORDER BY k) FROM (SELECT DISTINCT jsonb_object_keys(e) AS k
             FROM jsonb_array_elements(pg_temp.received_json(pg_temp.author_of((SELECT t1 FROM probe)))::jsonb) e) x),
  ARRAY['by_rubric', 'general', 'review_id', 'submitted_at'], 'the received review has only these four fields');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM app.peer_reviews_received({z1}) $$), '0', 'Dora, who wrote two reviews, reads none of them');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM app.peer_reviews_received({z1}) $$), '0', a.name || ' reads no review of a work that is not theirs')
FROM (VALUES ('ana'), ('lena')) AS a (name);
SELECT is(pg_temp.code('tomo', 'SELECT 1 FROM app.peer_reviews_received({z1})'), 'ZD404', 'a student of another institution reads 404');
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.peer_reviews_received({z1})'), 'ZD401', 'without a session no review is read');
SELECT is(pg_temp.code('marko', 'SELECT 1 FROM app.peer_reviews_received({z1})'), 'ZD404', 'a teacher of another course reads 404');

-- The overview: the teachers of K1 see both ends.
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.peer_review_overview({z1}) $$), '10', 'the teacher sees all ten allocations');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(DISTINCT state, ',' ORDER BY state) FROM app.peer_review_overview({z1}) $$), 'pending,submitted',
  'pending and submitted allocations');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.peer_review_overview({z1}) WHERE state = 'pending' AND review_id IS NOT NULL $$), '0',
  'a pending allocation has no review id');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(DISTINCT reviewer_family_name, ',') FROM app.peer_review_overview({z1}) WHERE state = 'submitted' $$), 'Babić',
  'the teacher sees the reviewer of a written review');
SELECT is(pg_temp.ask('vesna', $$ SELECT author_family_name FROM app.peer_review_overview({z1}) WHERE reviewer_id = {dora} ORDER BY author_family_name LIMIT 1 $$) IS NOT NULL, true,
  'and the author');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(DISTINCT reviewer_family_name, ',' ORDER BY reviewer_family_name) FROM app.peer_review_overview({z1}) $$),
  'Anić,Babić,Kovač,Lukić,Marić', 'the reviewers are in the order of the family name');
SELECT is(pg_temp.code(a.name, 'SELECT 1 FROM app.peer_review_overview({z1})'), 'ZD404', a.name || ' does not read the overview')
FROM (VALUES ('ana'), ('dora'), ('lena'), ('marko'), ('iva'), ('nina'), ('tomo'), ('petra')) AS a (name);
SELECT is(pg_temp.code('anon', 'SELECT 1 FROM app.peer_review_overview({z1})'), 'ZD401', 'without a session no overview is read');
SELECT is(pg_temp.code('vesna', 'SELECT 1 FROM app.peer_review_overview({z3})'), 'ZD404', 'another institution''s assignment reads 404');

-- Withdrawal: by the teachers of K1, with a reason; the review stays, it leaves the author's reading.
CREATE TEMP TABLE rv AS SELECT r.id AS review_id, a.author_id FROM institution.peer_review r
  JOIN institution.peer_review_allocation a ON a.id = r.task_id WHERE a.id = (SELECT t1 FROM probe);
GRANT SELECT ON rv TO PUBLIC;
SELECT is(pg_temp.msg(a.name, format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, ''Razlog.'')', (SELECT review_id FROM rv))), 'ZD404: not found',
  a.name || ' does not withdraw a review')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('marko'), ('iva'), ('nina'), ('tomo'), ('petra')) AS a (name);
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z2}, %L, ''Razlog.'')', (SELECT review_id FROM rv))), 'ZD404: not found',
  'a review is not withdrawn through another assignment');
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.withdraw_peer_review({z1}, gen_random_uuid(), ''Razlog.'')'), 'ZD404: not found', 'an unknown review reads 404');
SELECT is(pg_temp.msg('vesna', 'SELECT 1 FROM app.withdraw_peer_review({z1}, NULL, ''Razlog.'')'), 'ZD404: not found', 'a missing review reads 404');
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, ''Razlog.'')', (SELECT id FROM institution.peer_review_allocation LIMIT 1))), 'ZD404: not found',
  'an allocation without a review (a task id) is no review');
SELECT is(pg_temp.code('anon', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, ''Razlog.'')', (SELECT review_id FROM rv))), 'ZD401', 'without a session nothing is withdrawn');
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, %L)', (SELECT review_id FROM rv), '')), 'ZD422: invalid input', 'refused: no reason');
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, %L)', (SELECT review_id FROM rv), repeat('x', 601))), 'ZD422: invalid input', 'refused: a reason of 601 code points');
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, NULL)', (SELECT review_id FROM rv))), 'ZD422: invalid input', 'refused: a missing reason');
SELECT is((SELECT count(*)::integer FROM institution.peer_review_withdrawal), 0, 'a refused withdrawal writes nothing');
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, ''Razlog.'')', (SELECT review_id FROM rv))), 'ok', 'Vesna withdraws a review with a reason');
SELECT is(pg_temp.msg('vesna', format('SELECT 1 FROM app.withdraw_peer_review({z1}, %L, ''Opet.'')', (SELECT review_id FROM rv))), 'ZD409: conflict', 'a withdrawal is not repeated');
SELECT is(pg_temp.ask(pg_temp.author_of((SELECT t1 FROM probe)), $$ SELECT count(*) FROM app.peer_reviews_received({z1}) $$), '0', 'the withdrawn review leaves the reading of the author');
SELECT is((SELECT count(*)::integer FROM institution.peer_review), 2, 'the withdrawn review stays');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.peer_review_overview({z1}) WHERE state = 'withdrawn' AND review_id IS NOT NULL $$), '1', 'the teacher still sees it, as withdrawn');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.peer_review_overview({z1}) WHERE state = 'submitted' $$), '1', 'the other review is still submitted');
SELECT is(pg_temp.tasks_line('dora'), 'open submitted / open submitted', 'the reviewer keeps their task as submitted');
SELECT is(pg_temp.review('dora', (SELECT t1 FROM probe), pg_temp.good_review()), 'ZD409: already_reviewed', 'a withdrawn review is not written again');

-- A work withdrawn by its author leaves the round: it is not read, not reviewed, not listed.
SELECT is((SELECT count(*)::integer FROM app.peer_review_blocks(pg_temp.id('z1'), gen_random_uuid())), 0, 'no text for an unknown submission');
SELECT is((SELECT count(*)::integer FROM app.peer_review_blocks(pg_temp.id('z2'), (SELECT author_work_ref FROM institution.peer_review_allocation LIMIT 1))), 0,
  'no text of a submission through another assignment');
SELECT is((SELECT count(*)::integer FROM app.peer_review_blocks(pg_temp.id('z1'), (SELECT author_work_ref FROM institution.peer_review_allocation LIMIT 1))) > 0, true,
  'the text of a live submission of the assignment is read by the owner of the helper');
-- A body that is not the submitted text (hash mismatch) is not read: the owner changes it behind the trigger's back.
SET LOCAL ROLE ductus_evidence;
ALTER TABLE evidence.document_checkpoint DISABLE TRIGGER evidence_checkpoint_immutable;
UPDATE evidence.document_checkpoint SET body = replace(body, 'Naslov ', 'Naslov! ') WHERE document_id = 'doc-pr-karlo';
ALTER TABLE evidence.document_checkpoint ENABLE TRIGGER evidence_checkpoint_immutable;
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM app.peer_review_blocks(pg_temp.id('z1'), (SELECT id FROM evidence.submission WHERE principal_id = pg_temp.id('karlo')))), 0,
  'text that does not match the hash of the submitted revision is not read');

-- Time: before the round opens and after it is due (the owner moves the times behind the append-only trigger).
CREATE FUNCTION pg_temp.move_round(p_opens text, p_due text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE institution.peer_review_round DISABLE TRIGGER peer_review_round_append_only;
  EXECUTE format('UPDATE institution.peer_review_round SET opens_at = %s, due_at = %s', p_opens, p_due);
  ALTER TABLE institution.peer_review_round ENABLE TRIGGER peer_review_round_append_only;
END
$$;
CREATE TEMP TABLE pending AS SELECT pg_temp.task('jana', 1) AS t;
GRANT SELECT ON pending TO PUBLIC;
SELECT pg_temp.move_round('now() + interval ''1 hour''', 'now() + interval ''1 day''');
SELECT is(pg_temp.round_line('vesna'), 'allocated|5|5|2|t', 'before the round opens it is allocated');
SELECT is(pg_temp.tasks_line('jana'), 'none', 'before it opens the student sees no task');
SELECT is(pg_temp.code('jana', format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT t FROM pending))), 'ZD404', 'before it opens the work reads 404');
SELECT is(pg_temp.review('jana', (SELECT t FROM pending), pg_temp.good_review()), 'ZD404: not found', 'before it opens a review reads 404');
SELECT pg_temp.move_round('now() - interval ''2 days''', 'now() - interval ''1 day''');
SELECT is(pg_temp.round_line('vesna'), 'closed|5|5|2|t', 'after it is due the round is closed');
SELECT is(pg_temp.tasks_line('jana'), 'closed pending / closed pending', 'the student sees the tasks as closed');
SELECT is(pg_temp.code('jana', format('SELECT 1 FROM app.peer_review_work(%L)', (SELECT t FROM pending))), 'ZD404', 'after it is due the work reads 404');
SELECT is(pg_temp.review('jana', (SELECT t FROM pending), pg_temp.good_review()), 'ZD409: closed', 'after it is due a review is refused as closed');
SELECT is(pg_temp.review('jana', (SELECT t FROM pending), '[]'), 'ZD422: invalid input', 'invalid input is refused before the time');
SELECT is((SELECT count(*)::integer FROM institution.peer_review), 2, 'nothing is written after the due time');
SELECT is(pg_temp.ask('boris', $$ SELECT count(*) FROM app.peer_reviews_received({z1}) $$) IS NOT NULL, true, 'received reviews are read after the round, too');
SELECT is(pg_temp.set_round('vesna', 1), 'ZD409: already_allocated', 'a closed, allocated round is not replaced');
SELECT pg_temp.move_round('now() - interval ''1 hour''', 'now() + interval ''1 day''');
SELECT is(pg_temp.review('jana', (SELECT t FROM pending), pg_temp.good_review()), 'ok', 'a reviewer writes while the round runs');

-- Every record is only ever added: no update, no delete, no truncate, for the owner too.
SELECT throws_ok($$ UPDATE institution.peer_review_allocation SET author_id = reviewer_id $$, 'ZD409', 'conflict', 'an allocation is not changed');
SELECT throws_ok($$ DELETE FROM institution.peer_review_allocation $$, 'ZD409', 'conflict', 'an allocation is not deleted');
SELECT throws_ok($$ TRUNCATE institution.peer_review_allocation CASCADE $$, 'ZD409', 'conflict', 'allocations are not truncated');
SELECT throws_ok($$ UPDATE institution.peer_review SET body_json = '{}' $$, 'ZD409', 'conflict', 'a review is not changed');
SELECT throws_ok($$ DELETE FROM institution.peer_review $$, 'ZD409', 'conflict', 'a review is not deleted');
SELECT throws_ok($$ TRUNCATE institution.peer_review CASCADE $$, 'ZD409', 'conflict', 'reviews are not truncated');
SELECT throws_ok($$ UPDATE institution.peer_review_withdrawal SET reason = 'x' $$, 'ZD409', 'conflict', 'a withdrawal is not changed');
SELECT throws_ok($$ DELETE FROM institution.peer_review_withdrawal $$, 'ZD409', 'conflict', 'a withdrawal is not deleted');
SELECT throws_ok($$ TRUNCATE institution.peer_review_withdrawal CASCADE $$, 'ZD409', 'conflict', 'withdrawals are not truncated');
SELECT throws_ok($$ UPDATE institution.peer_review_round SET reviews_per_student = 1 $$, 'ZD409', 'conflict', 'a round is not changed');
SELECT throws_ok($$ DELETE FROM institution.peer_review_round $$, 'ZD409', 'conflict', 'a round is not deleted');
SELECT throws_ok($$ TRUNCATE institution.peer_review_round CASCADE $$, 'ZD409', 'conflict', 'rounds are not truncated');

-- Not a grade: no table or RPC of the review holds a score, a sum or a rank.
SELECT is((SELECT count(*)::integer FROM information_schema.columns
            WHERE table_schema = 'institution' AND table_name LIKE 'peer\_review%'
              AND column_name ~* '(score|grade|points|rank|rating|mark)'), 0, 'no column of the review holds a score, grade, points, rank or rating');

SELECT * FROM finish();
ROLLBACK;
