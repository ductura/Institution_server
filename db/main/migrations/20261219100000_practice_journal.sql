-- migrate:up
-- SRV-V19-DNEVNIK-BAZA (Ductus#2055; val 19, docs/nalazi/val19-razlika.md §5
-- task 2): the journal of a professional practice with the mentor's signature.
-- A practice (placement) belongs to one open mentorship (the mentor is a
-- teacher, the student the mentee); the student writes dated entries, the mentor
-- signs entries up to a date. None of it enters a grade or an export of a grade,
-- and nothing here ranks, sanctions or measures anyone.
--
--   institution.practice_placement  one practice: an organisation (a name only,
--                                   no account of the organisation, D-09), a
--                                   period, the mentorship, its student
--   institution.practice_entry      one entry of the journal: a date inside the
--                                   period, hours (0.5 to 12 in steps of 0.5), a
--                                   text; a correction is a new entry that points
--                                   at an entry of the same practice
--   institution.practice_signoff    the mentor's signature through a date: how
--                                   many entries it covers and the SHA-256 of
--                                   them (entries_sha256, below), an optional
--                                   comment the student sees
--
-- Every table is append-only (no UPDATE, DELETE or TRUNCATE, for the owner too),
-- has forced RLS, and no privilege for ductus_app: only the RPCs below read and
-- write. Who (C-23, from the relation, never from a role alone):
--   open a practice   the mentor of the (open) mentorship
--   write entries     the student of the practice, and only while the practice
--                     is open: the mentorship has not ended and the date lies in
--                     the period (ZD409 otherwise)
--   sign              the mentor of the mentorship of the practice
--   read              the student of the practice and its mentor; nobody else,
--                     an administrator and another teacher included
-- The mentor's private notes (mentorship.notes) are another class and are never
-- read here. Another person's practice, an unknown one and a malformed id all
-- read ZD404 (the route's 404). Errors carry no input: ZD401 no session, ZD404
-- not there or no part in it, ZD409 wrong state, ZD422 invalid input.
--
-- A signature covers every entry of the practice with entry_date <= through_date
-- that exists when it is made. An entry added later for an older date is a
-- correction and needs a new signature: an entry is covered when an earlier
-- signature has a through_date at or after its date and was made after the entry
-- (practice_entry.seq <= practice_signoff.entry_seq_through). Signing with no
-- entry that no earlier signature covers is ZD409 (the route's nothing_to_sign).
-- A signature is never withdrawn; the newest one is the one shown, the older ones
-- stay in the history.
--
-- entries_sha256 is the SHA-256 (lower-case hex) of the UTF-8 bytes of the JCS
-- (RFC 8785) of the array of the covered entries, ordered by (entry_date,
-- seq), each one the object {"correctsEntryId": uuid|null, "date": "YYYY-MM-DD",
-- "entryId": uuid, "hours": number, "text": string} (keys in this order, which
-- is the JCS order; hours as 7.5 or 8, no trailing zero). institution.
-- practice_entries_digest computes it; the domain function of the routes
-- (SRV-V19-DNEVNIK-RUTE) must give the same bytes for the same entries.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.practice_placement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  mentorship_id uuid NOT NULL,
  student_id uuid NOT NULL,
  organisation_name text NOT NULL
    CHECK (institution.is_thesis_text(organisation_name, 120) AND organisation_name !~ '[\n\t]'),
  starts_on date NOT NULL CHECK (starts_on >= DATE '2000-01-01' AND starts_on < DATE '2100-01-01'),
  ends_on date NOT NULL CHECK (ends_on >= DATE '2000-01-01' AND ends_on < DATE '2100-01-01'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, institution_id),
  CHECK (ends_on >= starts_on),
  FOREIGN KEY (mentorship_id, institution_id) REFERENCES institution.mentorship (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX practice_placement_mentorship_idx ON institution.practice_placement (mentorship_id, institution_id);
CREATE INDEX practice_placement_student_idx ON institution.practice_placement (student_id, institution_id);
CREATE INDEX practice_placement_author_idx ON institution.practice_placement (created_by, institution_id);

CREATE TABLE institution.practice_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  entry_date date NOT NULL CHECK (entry_date >= DATE '2000-01-01' AND entry_date < DATE '2100-01-01'),
  hours numeric(3, 1) NOT NULL CHECK (hours BETWEEN 0.5 AND 12 AND (hours * 2) = trunc(hours * 2)),
  body text NOT NULL CHECK (institution.is_thesis_text(body, 4000)),
  corrects_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, placement_id, institution_id),
  FOREIGN KEY (placement_id, institution_id) REFERENCES institution.practice_placement (id, institution_id),
  -- A correction points at an entry of the same practice (and not at itself: the id is new).
  FOREIGN KEY (corrects_entry_id, placement_id, institution_id)
    REFERENCES institution.practice_entry (id, placement_id, institution_id)
);
CREATE INDEX practice_entry_placement_idx ON institution.practice_entry (placement_id, entry_date, seq);
CREATE INDEX practice_entry_placement_institution_idx ON institution.practice_entry (placement_id, institution_id);
CREATE INDEX practice_entry_corrects_idx ON institution.practice_entry (corrects_entry_id, placement_id, institution_id);

CREATE TABLE institution.practice_signoff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  through_date date NOT NULL CHECK (through_date >= DATE '2000-01-01' AND through_date < DATE '2100-01-01'),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 1 AND 400),
  entries_sha256 text NOT NULL CHECK (entries_sha256 ~ '^[0-9a-f]{64}$'),
  entry_seq_through bigint NOT NULL CHECK (entry_seq_through >= 1),
  comment text CHECK (comment IS NULL OR institution.is_thesis_text(comment, 1000)),
  mentor_id uuid NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (placement_id, institution_id) REFERENCES institution.practice_placement (id, institution_id),
  FOREIGN KEY (mentor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX practice_signoff_placement_idx ON institution.practice_signoff (placement_id, seq);
CREATE INDEX practice_signoff_placement_institution_idx ON institution.practice_signoff (placement_id, institution_id);
CREATE INDEX practice_signoff_mentor_idx ON institution.practice_signoff (mentor_id, institution_id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
CREATE FUNCTION institution.reject_practice_record_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['practice_placement', 'practice_entry', 'practice_signoff'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_practice_record_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_practice_record_change()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- The JCS digest of the entries of a practice with entry_date <= p_through that
-- are in the set p_through_seq cuts off (every entry up to that seq). Returns
-- the count, the digest and the highest seq among them.
CREATE FUNCTION institution.practice_entries_digest(p_placement_id uuid, p_through date)
RETURNS TABLE (entry_count integer, entries_sha256 text, max_seq bigint)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT count(*)::integer,
         encode(sha256(convert_to('[' || coalesce(string_agg(
           '{"correctsEntryId":' || coalesce(to_json(e.corrects_entry_id::text)::text, 'null')
           || ',"date":' || to_json(to_char(e.entry_date, 'YYYY-MM-DD'))::text
           || ',"entryId":' || to_json(e.id::text)::text
           || ',"hours":' || CASE WHEN e.hours = trunc(e.hours) THEN trunc(e.hours)::text ELSE e.hours::text END
           || ',"text":' || to_json(e.body)::text || '}', ',' ORDER BY e.entry_date, e.seq), '') || ']', 'UTF8')), 'hex'),
         max(e.seq)
    FROM institution.practice_entry e
   WHERE e.placement_id = p_placement_id AND e.entry_date <= p_through
$$;

-- The caller's part in one practice: 'student' (its student), 'mentor' (the
-- mentor of its mentorship). ZD401 without a session; ZD404 for anything else,
-- an unknown id included (C-23).
CREATE FUNCTION institution.practice_context(
  p_placement_id uuid,
  OUT o_institution_id uuid, OUT o_user_id uuid, OUT o_part text,
  OUT o_starts_on date, OUT o_ends_on date, OUT o_mentorship_open boolean
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_placement record;
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  IF p_placement_id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT p.student_id, p.starts_on, p.ends_on, m.mentor_id, m.ended_at IS NULL AS open
    INTO v_placement
    FROM institution.practice_placement p
    JOIN institution.mentorship m ON m.id = p.mentorship_id AND m.institution_id = p.institution_id
   WHERE p.id = p_placement_id AND p.institution_id = o_institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  -- The mentor part needs the mentorship and a confirmed, unrevoked teacher role
  -- (as institution.actor_mentorship_role): a revoked teacher keeps no access.
  o_part := CASE WHEN v_placement.student_id = o_user_id THEN 'student'
                 WHEN v_placement.mentor_id = o_user_id AND institution.actor_has_role('teacher') THEN 'mentor' END;
  IF o_part IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  o_starts_on := v_placement.starts_on;
  o_ends_on := v_placement.ends_on;
  o_mentorship_open := v_placement.open;
END
$$;

-- The mentor of an open mentorship opens a practice for its student.
CREATE FUNCTION app.open_practice_placement(p_mentorship_id uuid, p_organisation_name text, p_starts_on date,
                                            p_ends_on date)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_student uuid;
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  -- The mentorship of the caller, open: any other (unknown, someone else's,
  -- ended) is the same refusal, and it comes before the input is looked at.
  SELECT m.student_id INTO v_student FROM institution.mentorship m
   WHERE m.id = p_mentorship_id AND m.institution_id = v_actor.institution_id
     AND m.mentor_id = v_actor.user_id AND m.ended_at IS NULL
     AND institution.lock_teacher_role(v_actor.user_id) IS NOT NULL;
  IF v_student IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_organisation_name IS NULL OR NOT institution.is_thesis_text(p_organisation_name, 120)
     OR p_organisation_name ~ '[\n\t]'
     OR p_starts_on IS NULL OR p_ends_on IS NULL OR p_ends_on < p_starts_on
     OR p_starts_on < DATE '2000-01-01' OR p_ends_on >= DATE '2100-01-01' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO institution.practice_placement
    (institution_id, mentorship_id, student_id, organisation_name, starts_on, ends_on, created_by)
  VALUES (v_actor.institution_id, p_mentorship_id, v_student, p_organisation_name, p_starts_on, p_ends_on,
          v_actor.user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The student of a practice adds an entry (a correction when p_corrects_entry_id
-- is given).
CREATE FUNCTION app.add_practice_entry(p_placement_id uuid, p_entry_date date, p_hours numeric, p_body text,
                                       p_corrects_entry_id uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.practice_context(p_placement_id);
  IF v_ctx.o_part <> 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_entry_date IS NULL OR p_hours IS NULL OR p_body IS NULL
     OR p_hours NOT BETWEEN 0.5 AND 12 OR (p_hours * 2) <> trunc(p_hours * 2)
     OR NOT institution.is_thesis_text(p_body, 4000)
     OR p_entry_date < DATE '2000-01-01' OR p_entry_date >= DATE '2100-01-01' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- One writer of a practice at a time: the count and the signature below.
  PERFORM pg_advisory_xact_lock(hashtextextended('practice_placement:' || p_placement_id, 0));
  IF NOT v_ctx.o_mentorship_open OR p_entry_date NOT BETWEEN v_ctx.o_starts_on AND v_ctx.o_ends_on THEN
    RAISE EXCEPTION 'placement closed' USING ERRCODE = 'ZD409';
  END IF;
  IF p_entry_date > current_date THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_corrects_entry_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM institution.practice_entry e
        WHERE e.id = p_corrects_entry_id AND e.placement_id = p_placement_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF (SELECT count(*) FROM institution.practice_entry e WHERE e.placement_id = p_placement_id) >= 400 THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.practice_entry (institution_id, placement_id, entry_date, hours, body, corrects_entry_id)
  VALUES (v_ctx.o_institution_id, p_placement_id, p_entry_date, p_hours, p_body, p_corrects_entry_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The mentor signs the entries up to p_through_date.
CREATE FUNCTION app.sign_practice_entries(p_placement_id uuid, p_through_date date, p_comment text)
RETURNS TABLE (signoff_id uuid, entry_count integer, entries_sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_digest record;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.practice_context(p_placement_id);
  IF v_ctx.o_part <> 'mentor' OR institution.lock_teacher_role(v_ctx.o_user_id) IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_through_date IS NULL OR p_through_date < v_ctx.o_starts_on OR p_through_date > v_ctx.o_ends_on
     OR p_through_date > current_date
     OR (p_comment IS NOT NULL AND NOT institution.is_thesis_text(p_comment, 1000)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('practice_placement:' || p_placement_id, 0));
  -- Something no earlier signature covers: an entry up to the date, newer than
  -- the newest signature that reaches its date.
  IF NOT EXISTS (
       SELECT 1 FROM institution.practice_entry e
        WHERE e.placement_id = p_placement_id AND e.entry_date <= p_through_date
          AND NOT EXISTS (SELECT 1 FROM institution.practice_signoff s
                           WHERE s.placement_id = p_placement_id AND s.through_date >= e.entry_date
                             AND s.entry_seq_through >= e.seq)) THEN
    RAISE EXCEPTION 'nothing to sign' USING ERRCODE = 'ZD409';
  END IF;
  SELECT * INTO v_digest FROM institution.practice_entries_digest(p_placement_id, p_through_date);
  INSERT INTO institution.practice_signoff
    (institution_id, placement_id, through_date, entry_count, entries_sha256, entry_seq_through, comment, mentor_id)
  VALUES (v_ctx.o_institution_id, p_placement_id, p_through_date, v_digest.entry_count, v_digest.entries_sha256,
          v_digest.max_seq, p_comment, v_ctx.o_user_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_digest.entry_count, v_digest.entries_sha256;
END
$$;

-- The practices of the caller: as a student the own, as a mentor those of the
-- mentorships they lead; nobody else's, an administrator's included. The newest
-- signature gives signed_through.
CREATE FUNCTION app.practice_placements()
RETURNS TABLE (
  placement_id uuid, mentorship_id uuid, student_id uuid, student_given_name text, student_family_name text,
  organisation_name text, starts_on date, ends_on date, entry_count integer, signed_through date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  RETURN QUERY
    SELECT p.id, p.mentorship_id, p.student_id, n.given_name, n.family_name, p.organisation_name, p.starts_on,
           p.ends_on,
           (SELECT count(*)::integer FROM institution.practice_entry e WHERE e.placement_id = p.id),
           (SELECT s.through_date FROM institution.practice_signoff s WHERE s.placement_id = p.id
             ORDER BY s.seq DESC LIMIT 1)
      FROM institution.practice_placement p
      JOIN institution.mentorship m ON m.id = p.mentorship_id AND m.institution_id = p.institution_id
      LEFT JOIN identity.person_name n ON n.user_id = p.student_id AND n.institution_id = p.institution_id
     WHERE p.institution_id = v_actor.institution_id
       AND (p.student_id = v_actor.user_id
            OR (m.mentor_id = v_actor.user_id AND institution.actor_has_role('teacher')))
     ORDER BY p.starts_on DESC, p.created_at DESC, p.id;
END
$$;

-- The entries of one practice, for its student and its mentor.
CREATE FUNCTION app.practice_entries(p_placement_id uuid)
RETURNS TABLE (entry_id uuid, entry_date date, hours numeric, body text, corrects_entry_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.practice_context(p_placement_id);
  RETURN QUERY
    SELECT e.id, e.entry_date, e.hours, e.body, e.corrects_entry_id, e.created_at
      FROM institution.practice_entry e
     WHERE e.placement_id = p_placement_id
     ORDER BY e.entry_date, e.seq;
END
$$;

-- The signatures of one practice (newest first), for its student and its mentor.
CREATE FUNCTION app.practice_signoffs(p_placement_id uuid)
RETURNS TABLE (
  signoff_id uuid, through_date date, entry_count integer, entries_sha256 text, comment text, signed_at timestamptz,
  mentor_id uuid, mentor_given_name text, mentor_family_name text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM institution.practice_context(p_placement_id);
  RETURN QUERY
    SELECT s.id, s.through_date, s.entry_count, s.entries_sha256, s.comment, s.signed_at, s.mentor_id,
           n.given_name, n.family_name
      FROM institution.practice_signoff s
      LEFT JOIN identity.person_name n ON n.user_id = s.mentor_id AND n.institution_id = s.institution_id
     WHERE s.placement_id = p_placement_id
     ORDER BY s.seq DESC;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_practice_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.practice_entries_digest(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.practice_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.open_practice_placement(uuid, text, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.add_practice_entry(uuid, date, numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.sign_practice_entries(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.practice_placements() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.practice_entries(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.practice_signoffs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.open_practice_placement(uuid, text, date, date) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.add_practice_entry(uuid, date, numeric, text, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.sign_practice_entries(uuid, date, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.practice_placements() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.practice_entries(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.practice_signoffs(uuid) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.practice_signoffs(uuid);
DROP FUNCTION app.practice_entries(uuid);
DROP FUNCTION app.practice_placements();
DROP FUNCTION app.sign_practice_entries(uuid, date, text);
DROP FUNCTION app.add_practice_entry(uuid, date, numeric, text, uuid);
DROP FUNCTION app.open_practice_placement(uuid, text, date, date);
DROP FUNCTION institution.practice_context(uuid);
DROP FUNCTION institution.practice_entries_digest(uuid, date);
DROP TABLE institution.practice_signoff;
DROP TABLE institution.practice_entry;
DROP TABLE institution.practice_placement;
DROP FUNCTION institution.reject_practice_record_change();
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
