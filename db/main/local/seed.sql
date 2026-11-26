-- Local and CI stack only: invented institutions for the demo login (B-6).
-- `pnpm db:seed` runs it after `pnpm db:migrate`; `pnpm lokalno` runs it
-- without the psql guard below, over loopback TCP (scripts/lokalno). The fake
-- OIDC provider (packages/test-fakes/oidc, http://localhost:8090) releases hrEduPersonHomeOrg demo.ductus.test or
-- b.demo.ductus.test, so each of its accounts lands in exactly one of "Demo
-- fakultet" and "Demo fakultet B" (DAN-483). The third institution takes no
-- logins (aai_home_org NULL): an unknown home organisation is refused, never
-- mapped to a default. Production institutions are provisioned, never seeded.
\set ON_ERROR_STOP on
SELECT pg_catalog.inet_server_addr() IS NULL AS local_socket \gset
\if :local_socket
\else
  DO $$ BEGIN RAISE EXCEPTION 'db/local/seed.sql is for the local compose stack only'; END $$;
\endif

INSERT INTO identity.institution (slug, aai_home_org) VALUES
  ('demo-fakultet', 'demo.ductus.test'),
  ('demo-fakultet-b', 'b.demo.ductus.test'),
  ('demo-bez-prijave', NULL)
ON CONFLICT (slug) DO UPDATE SET aai_home_org = EXCLUDED.aai_home_org;

-- Both login institutions take the fake provider's issuer, in the spelling
-- the login route stores (DAN-159); the home organisation, not the issuer,
-- tells them apart. The institution without logins takes no issuer either.
INSERT INTO identity.institution_issuer (institution_id, oidc_issuer)
SELECT id, 'http://localhost:8090'
  FROM identity.institution WHERE slug IN ('demo-fakultet', 'demo-fakultet-b')
ON CONFLICT DO NOTHING;

-- Only the invented login institutions can enroll in the local demo. The
-- table defaults are the owner's five attempts / fifteen minutes; a rerun
-- must leave any configured display name and limits untouched.
INSERT INTO institution.institution_settings (institution_id, display_name)
SELECT id, CASE slug WHEN 'demo-fakultet' THEN 'Demo fakultet (test)' ELSE 'Demo fakultet B (test)' END
  FROM identity.institution WHERE slug IN ('demo-fakultet', 'demo-fakultet-b')
ON CONFLICT (institution_id) DO NOTHING;

-- The invented bachelor thesis request can become a mentored work.
INSERT INTO institution.faculty_work_rule (
  institution_id, work_type, ai_policy, ai_purposes, evidence_profile, import_allowed
)
SELECT id, 'bachelor_thesis', 'prohibited', ARRAY[]::text[], 'basic', false
FROM identity.institution WHERE slug = 'demo-fakultet'
ON CONFLICT (institution_id, work_type) DO NOTHING;

-- Every invented institution with logins gets its one evidence domain, so
-- open_student_work can start a work (the same row and region that
-- evidence-signing-key.sql makes when none exists).
INSERT INTO evidence.domain (institution_id, region)
SELECT i.id, 'local' FROM identity.institution i
 WHERE i.slug = 'demo-fakultet'
   AND NOT EXISTS (SELECT 1 FROM evidence.domain d WHERE d.institution_id = i.id);

-- SRV-01 (Ductus#2028, c.7008147932): the invented people, courses and work of
-- the local demo in demo-fakultet, so every screen of waves 1, 2 and 4 can be
-- clicked. Every row comes from the function the application calls, under the
-- session of an invented account, as withActor does (db/main/local/demo-k3.sql);
-- the identity is never a parameter. The direct writes are only those an
-- operator makes: the first administrator (appoint_institution_admin, as
-- provisioning does) and the two enrolment codes with fixed text, which the
-- product only ever generates at random (only code_hash is stored).
--
-- Accounts (packages/test-fakes/oidc/accounts.ts and
-- db/main/local/lazni-oidc-racuni.json):
--   demo-admin      administrator of demo-fakultet (file account, djelatnik)
--   demo-teacher    confirmed teacher, holder of both courses
--   demo-teacher-2  confirmed teacher, teaches group B (course team, collaborator)
--   demo-student    enrolled in the seminar, group A, notice confirmed, work open
--   demo-student-2  not enrolled (empty "Moji zadaci")
--   demo-bez-uloge  file account (djelatnik) with no confirmed role; not made here
-- Codes: UPIS2026DEMO (seminar, valid), STARI2025KOD (seminar, expired and
-- replaced), PRAZNI2026DEMO (the course without an assignment, valid).
--
-- A rerun adds no row: every step is idempotent or skipped when done. Each run
-- leaves five closed sessions, as five sign-ins and sign-outs would. One DO
-- block is one transaction: a failed step leaves nothing behind.
DO $demo$
DECLARE
  c_issuer constant text := 'http://localhost:8090';
  c_home_org constant text := 'demo.ductus.test';
  -- Order: admin, teacher, teacher 2, student, student 2. The admin is a file
  -- account of the simulator, so its subject is the simulator's account id.
  c_subjects constant text[] := ARRAY['sim:nastavnik:demo-admin@demo.ductus.test', 'demo-teacher',
                                      'demo-teacher-2', 'demo-student', 'demo-student-2'];
  c_users constant text[] := ARRAY['demo-admin', 'demo-teacher', 'demo-teacher-2', 'demo-student',
                                   'demo-student-2'];
  c_given constant text[] := ARRAY['Vesna', 'Petar', 'Maja', 'Lucija', 'Marko'];
  c_family constant text[] := ARRAY['Upravić', 'Kranjčec', 'Džombić', 'Đaković', 'Ljubić'];
  c_eligible constant boolean[] := ARRAY[true, true, true, false, false];
  c_request constant uuid := 'c5ed0000-0000-4000-8000-000000000001';
  c_course constant text := 'Izmišljeni seminar iz ekologije grada';
  c_empty_course constant text := 'Izmišljeni praktikum iz urbane sociologije';
  c_late_course constant text := 'Izmišljeni seminar iz urbane hidrologije';
  c_late_request constant uuid := 'c5ed0000-0000-4000-8000-000000000017';
  c_year constant text := '2026/2027';
  c_title constant text := 'Seminarski rad: kućno kompostiranje';
  c_instructions constant text :=
    'Opiši kako kućno kompostiranje u gradskom kućanstvu smanjuje količinu otpada. '
    || 'Osloni se na najmanje tri izvora i citiraj ih prema uputama fakulteta.' || E'\n\n'
    || 'Kolegij, zadatak i tekst su izmišljeni i služe samo za lokalni demo.';
  v_institution uuid;
  v_tokens text[] := ARRAY[]::text[];
  v_ids uuid[] := ARRAY[]::uuid[];
  v_course uuid;
  v_empty uuid;
  v_late uuid;
  v_group_a uuid;
  v_group_b uuid;
  v_assignment uuid;
  v_version integer;
  v_outcome text;
  v_document text;
  i integer;
BEGIN
  SELECT id INTO STRICT v_institution FROM identity.institution
   WHERE slug = 'demo-fakultet' AND aai_home_org = c_home_org;

  -- 1. Sign-in, as the login callback does after the OIDC check.
  SET LOCAL ROLE ductus_auth;
  FOR i IN 1 .. cardinality(c_subjects) LOOP
    v_tokens := v_tokens || rtrim(translate(encode(
      sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'base64'), '+/', '-_'), '=');
    PERFORM identity.open_session(c_issuer, c_subjects[i], c_users[i] || '@' || c_home_org, c_home_org,
                                  sha256(convert_to(v_tokens[i], 'UTF8')), c_given[i], c_family[i],
                                  c_eligible[i]);
  END LOOP;
  RESET ROLE;
  FOR i IN 1 .. cardinality(c_subjects) LOOP
    v_ids := v_ids || (SELECT u.id FROM identity.user_account u
                        WHERE u.oidc_issuer = c_issuer AND u.oidc_subject = c_subjects[i]
                          AND u.institution_id = v_institution);
  END LOOP;
  IF array_position(v_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'demo accounts are not in demo-fakultet';
  END IF;

  -- 2. The first administrator, as provisioning appoints one (no actor).
  PERFORM institution.appoint_institution_admin(v_ids[1], 'lokalni-seed');

  -- 3. The administrator confirms both teachers (the product flow).
  SET LOCAL ROLE ductus_app;
  PERFORM set_config('app.session_token', v_tokens[1], true);
  FOR i IN 2..3 LOOP
    IF NOT EXISTS (SELECT 1 FROM institution.teacher_roles() t WHERE t.user_id = v_ids[i]
                    AND t.confirmed_at IS NOT NULL AND t.revoked_at IS NULL) THEN
      PERFORM institution.confirm_teacher_role(v_ids[i]);
    END IF;
  END LOOP;

  -- 4. The holder's courses, groups, codes and assignment.
  PERFORM set_config('app.session_token', v_tokens[2], true);
  v_course := institution.create_course(c_course, c_year, 'partially_allowed');
  v_empty := institution.create_course(c_empty_course, c_year, 'encouraged');
  v_late := institution.create_course(c_late_course, c_year, 'partially_allowed');
  PERFORM institution.set_course_holder(v_course, v_ids[2]);
  PERFORM institution.set_course_holder(v_empty, v_ids[2]);
  PERFORM institution.set_course_holder(v_late, v_ids[2]);
  v_group_a := institution.create_seminar_group(v_course, 'Grupa A');
  v_group_b := institution.create_seminar_group(v_course, 'Grupa B');
  PERFORM institution.assign_group_teacher(v_group_b, v_ids[3]);
  v_assignment := institution.create_assignment(
    v_course, c_request, c_title, c_instructions, 'seminar_paper',
    '2026-10-01 08:00:00+02', '2027-01-31 23:59:00+01', 'partially_allowed',
    ARRAY['proofreading', 'literature_search'], 'basic', false, 1500, 2500, 1);
  PERFORM institution.create_assignment(
    v_late, c_late_request, 'Kratki osvrt: gradski vrtovi',
    'Opiši ulogu gradskih vrtova u upravljanju oborinskom vodom.', 'short_paper',
    '2026-09-01 08:00:00+02', '2026-09-30 23:59:00+02', 'partially_allowed',
    ARRAY['proofreading'], 'basic', false, NULL, NULL, 1);
  RESET ROLE;

  -- The fixed codes: an operator row with the hash the product stores.
  INSERT INTO institution.course_enrollment_code (course_id, code_hash, valid_until, active, created_by, created_at)
  VALUES
    (v_course, sha256(convert_to('STARI2025KOD', 'UTF8')), '2025-10-31 23:59:00+01', false, v_ids[2],
     '2025-10-01 09:00:00+02'),
    (v_course, sha256(convert_to('UPIS2026DEMO', 'UTF8')), '2027-09-30 23:59:00+02', true, v_ids[2], now()),
    (v_empty, sha256(convert_to('PRAZNI2026DEMO', 'UTF8')), '2027-09-30 23:59:00+02', true, v_ids[2], now()),
    (v_late, sha256(convert_to('HIDRO2026DEMO', 'UTF8')), '2027-09-30 23:59:00+02', true, v_ids[2], now())
  ON CONFLICT (code_hash) DO NOTHING;

  -- 5. demo-student enrols with the code, joins group A, confirms the notice
  -- and opens the work (PRODUCT 5 rule 6: the notice before the work).
  SET LOCAL ROLE ductus_app;
  PERFORM set_config('app.session_token', v_tokens[4], true);
  IF institution.actor_course_role(v_course) IS NULL THEN
    SELECT e.outcome INTO v_outcome FROM institution.enroll_with_code('UPIS2026DEMO') e;
    IF v_outcome IS DISTINCT FROM 'enrolled' THEN
      RAISE EXCEPTION 'demo-student was not enrolled (%)', v_outcome;
    END IF;
  END IF;
  PERFORM set_config('app.session_token', v_tokens[2], true);
  PERFORM institution.assign_group_student(v_group_a, v_ids[4]);
  PERFORM set_config('app.session_token', v_tokens[4], true);
  IF NOT institution.has_acknowledged_current(v_assignment) THEN
    SELECT a.current_version INTO STRICT v_version FROM institution.assignment a WHERE a.id = v_assignment;
    PERFORM institution.acknowledge_notice(v_assignment, v_version, 1);
  END IF;
  SELECT w.document_id INTO v_document FROM app.open_student_work(v_assignment, true) w
   WHERE w.outcome = 'opened';
  IF v_document IS NULL THEN
    RAISE EXCEPTION 'the work of demo-student did not open';
  END IF;
  RESET ROLE;

  -- 6. One access log row: demo-teacher opened the work of demo-student.
  IF NOT EXISTS (SELECT 1 FROM audit.access_log l WHERE l.document_id = v_document AND l.reader_id = v_ids[2]) THEN
    -- The evidence role, as the server's fast path route calls it.
    SET LOCAL ROLE ductus_evidence;
    PERFORM set_config('app.session_token', v_tokens[2], true);
    PERFORM app.record_fast_path_opening(v_document);
    RESET ROLE;
  END IF;

  -- 7. Sign-out of all five sessions.
  SET LOCAL ROLE ductus_app;
  FOR i IN 1 .. cardinality(v_tokens) LOOP
    PERFORM set_config('app.session_token', v_tokens[i], true);
    IF NOT identity.close_current_session() THEN
      RAISE EXCEPTION 'demo session % did not close', i;
    END IF;
  END LOOP;
  PERFORM set_config('app.session_token', '', true);
  RESET ROLE;
END
$demo$;

-- SRV-V18-UPITNIK-BAZA (val 18): an invented questionnaire in the seminar of
-- demo-fakultet, made, opened and filled by hand by demo-teacher through the
-- functions the application calls (as the block above). Twelve invented sheets
-- carry no person; nothing here is a real answer. A rerun adds nothing: the
-- block is skipped when the questionnaire exists. One DO block is one
-- transaction; the session it opens is closed at its end.
DO $questionnaire$
DECLARE
  c_issuer constant text := 'http://localhost:8090';
  c_home_org constant text := 'demo.ductus.test';
  c_course constant text := 'Izmišljeni seminar iz ekologije grada';
  c_title constant text := 'Izmišljeno istraživanje: navike kompostiranja';
  c_questions constant jsonb := $q$[
    {"kind": "single", "text": "Kompostirate li otpad iz kućanstva?", "options": [{"code": "da", "label": "Da"}, {"code": "ne", "label": "Ne"}, {"code": "ponekad", "label": "Ponekad"}]},
    {"kind": "multiple", "text": "Što stavljate u kompost?", "options": [{"code": "voce", "label": "Ostatke voća"}, {"code": "povrce", "label": "Ostatke povrća"}, {"code": "lisce", "label": "Lišće"}, {"code": "kava", "label": "Talog kave"}]},
    {"kind": "scale", "text": "Koliko vam je kompostiranje naporno? (1 nimalo, 5 jako)", "scale": {"min": 1, "max": 5}},
    {"kind": "number", "text": "Koliko kilograma otpada mjesečno kompostirate?"},
    {"kind": "single", "text": "Imate li vrt?", "options": [{"code": "da", "label": "Da"}, {"code": "ne", "label": "Ne"}]},
    {"kind": "scale", "text": "Koliko vam je važno smanjiti otpad? (1 nimalo, 5 jako)", "scale": {"min": 1, "max": 5}},
    {"kind": "number", "text": "Koliko osoba živi u vašem kućanstvu?"},
    {"kind": "text", "text": "Što bi vam olakšalo kompostiranje?"}
  ]$q$;
  v_institution uuid;
  v_token text;
  v_teacher uuid;
  v_course uuid;
  v_id uuid;
  v_ids uuid[];
  v_n integer;
  v_answers jsonb;
BEGIN
  SELECT id INTO STRICT v_institution FROM identity.institution
   WHERE slug = 'demo-fakultet' AND aai_home_org = c_home_org;
  SELECT c.id INTO v_course FROM institution.course c
   WHERE c.institution_id = v_institution AND c.name = c_course LIMIT 1;
  IF v_course IS NULL OR EXISTS (SELECT 1 FROM institution.questionnaire q WHERE q.title = c_title) THEN
    RETURN;
  END IF;

  v_token := rtrim(translate(encode(
    sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'base64'), '+/', '-_'), '=');
  SET LOCAL ROLE ductus_auth;
  PERFORM identity.open_session(c_issuer, 'demo-teacher', 'demo-teacher@' || c_home_org, c_home_org,
                                sha256(convert_to(v_token, 'UTF8')), 'Petar', 'Kranjčec', true);
  RESET ROLE;

  SET LOCAL ROLE ductus_app;
  PERFORM set_config('app.session_token', v_token, true);
  v_id := app.create_questionnaire(v_course, c_title, c_questions);
  PERFORM app.set_questionnaire_state(v_id, 'open');
  SELECT array_agg(q.question_id ORDER BY q.ord) INTO v_ids FROM app.teacher_questionnaire(v_id) q;
  FOR v_n IN 1 .. 12 LOOP
    v_answers := jsonb_build_array(
      jsonb_build_object('questionId', v_ids[1], 'value', (ARRAY['da', 'ne', 'ponekad'])[1 + v_n % 3]),
      jsonb_build_object('questionId', v_ids[2], 'value',
        CASE v_n % 3 WHEN 0 THEN '["voce", "povrce"]'::jsonb WHEN 1 THEN '["lisce"]'::jsonb ELSE '["voce", "kava"]'::jsonb END),
      jsonb_build_object('questionId', v_ids[3], 'value', 1 + v_n % 5),
      jsonb_build_object('questionId', v_ids[4], 'value', 2 + (v_n % 4) * 1.5),
      jsonb_build_object('questionId', v_ids[5], 'value', CASE WHEN v_n % 2 = 0 THEN 'da' ELSE 'ne' END),
      jsonb_build_object('questionId', v_ids[6], 'value', 1 + (v_n * 2) % 5),
      jsonb_build_object('questionId', v_ids[7], 'value', 1 + v_n % 4));
    -- Every third sheet leaves the free text empty, as people do.
    IF v_n % 3 <> 0 THEN
      v_answers := v_answers || jsonb_build_array(jsonb_build_object(
        'questionId', v_ids[8], 'value', 'Izmišljena primjedba broj ' || v_n));
    END IF;
    PERFORM app.manual_questionnaire_response(v_id, v_answers);
  END LOOP;
  PERFORM set_config('app.session_token', v_token, true);
  PERFORM identity.close_current_session();
  PERFORM set_config('app.session_token', '', true);
  RESET ROLE;
END
$questionnaire$;

-- SRV-V18-KODIRANJE-BAZA (val 18): invented material for qualitative coding of
-- demo-student, kept through the functions the application calls (as the blocks
-- above): two texts (`Intervju A` and `Bilješka A`), a codebook of six codes and
-- a few marked passages. The offsets are found in the text by position(), so a
-- wrong one is refused by the function itself. Nothing here is a real interview
-- or a real person. A rerun adds nothing: the block is skipped when the first
-- material exists. One DO block is one transaction; the session it opens is
-- closed at its end.
DO $coding$
DECLARE
  c_issuer constant text := 'http://localhost:8090';
  c_home_org constant text := 'demo.ductus.test';
  c_interview constant text :=
    E'Pitanje: Kako biste opisali svoje iskustvo s kompostiranjem?\n'
    || E'Odgovor: Isprva je bilo naporno, ali sada mi je to navika. Susjedi su se smijali, a sada pitaju za savjet.\n'
    || E'Pitanje: Što vam je najteže?\n'
    || E'Odgovor: Najteže je održati redovitost zimi, kad je hladno i ništa se ne raspada.';
  c_note constant text :=
    E'Bilješka s terena: dvorište iza zgrade, tri kontejnera za kompost.\n'
    || E'Čini se da se stanari međusobno podsjećaju na red.';
  c_codes constant text[][] := ARRAY[
    ['Navika', 'Radnja koja je postala svakodnevna'],
    ['Napor', 'Trud i poteškoće'],
    ['Susjedstvo', 'Odnosi sa susjedima'],
    ['Zima', 'Utjecaj hladnoće'],
    ['Znanje', 'Savjet i iskustvo'],
    ['Prostor', 'Mjesto i oprema']];
  -- material (1 interview, 2 note), code (1..6), paragraph, quote, memo
  c_marks constant jsonb := $m$[
    [1, 2, 1, "naporno", null],
    [1, 1, 1, "navika", "Promjena u odnosu na početak."],
    [1, 3, 1, "Susjedi su se smijali", null],
    [1, 5, 1, "pitaju za savjet", null],
    [1, 4, 3, "zimi", "Zima se spominje kao glavna prepreka."],
    [1, 2, 3, "Najteže je održati redovitost", null],
    [2, 6, 0, "tri kontejnera za kompost", null],
    [2, 3, 1, "stanari međusobno podsjećaju", null]]$m$;
  v_institution uuid;
  v_token text;
  v_materials uuid[];
  v_codes uuid[] := ARRAY[]::uuid[];
  v_n integer;
  v_mark jsonb;
  v_body text;
  v_line text;
BEGIN
  SELECT id INTO STRICT v_institution FROM identity.institution
   WHERE slug = 'demo-fakultet' AND aai_home_org = c_home_org;
  IF EXISTS (SELECT 1 FROM institution.qual_material m
              JOIN identity.user_account u ON u.id = m.owner_id AND u.institution_id = m.institution_id
             WHERE m.institution_id = v_institution AND u.oidc_subject = 'demo-student' AND m.title = 'Intervju A') THEN
    RETURN;
  END IF;

  v_token := rtrim(translate(encode(
    sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'base64'), '+/', '-_'), '=');
  SET LOCAL ROLE ductus_auth;
  PERFORM identity.open_session(c_issuer, 'demo-student', 'demo-student@' || c_home_org, c_home_org,
                                sha256(convert_to(v_token, 'UTF8')), 'Lucija', 'Đaković', false);
  RESET ROLE;

  SET LOCAL ROLE ductus_app;
  PERFORM set_config('app.session_token', v_token, true);
  v_materials := ARRAY[app.create_qual_material('Intervju A', 'interview', c_interview),
                       app.create_qual_material('Bilješka A', 'note', c_note)];
  FOR v_n IN 1 .. array_length(c_codes, 1) LOOP
    v_codes := v_codes || app.create_qual_code(c_codes[v_n][1], c_codes[v_n][2]);
  END LOOP;
  FOR v_mark IN SELECT * FROM jsonb_array_elements(c_marks) LOOP
    v_body := CASE (v_mark ->> 0)::integer WHEN 1 THEN c_interview ELSE c_note END;
    v_line := (string_to_array(v_body, E'\n'))[(v_mark ->> 2)::integer + 1];
    v_n := strpos(v_line, v_mark ->> 3) - 1;
    PERFORM app.create_qual_segment(
      v_materials[(v_mark ->> 0)::integer], v_codes[(v_mark ->> 1)::integer],
      (v_mark ->> 2)::integer, v_n, v_n + char_length(v_mark ->> 3), v_mark ->> 3,
      CASE WHEN jsonb_typeof(v_mark -> 4) = 'string' THEN v_mark ->> 4 END);
  END LOOP;
  PERFORM set_config('app.session_token', v_token, true);
  PERFORM identity.close_current_session();
  PERFORM set_config('app.session_token', '', true);
  RESET ROLE;
END
$coding$;
