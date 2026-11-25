-- migrate:up
-- SRV-V18-KODIRANJE-BAZA (Ductus#2055; val 18, WEB docs/nalazi/val18-razlika.md
-- §5 task 5): qualitative coding of the student's own material. A student keeps
-- texts (an interview or a note, typed or pasted: no sound, no automatic
-- transcript), a codebook of their own and the passages of a text they marked
-- with a code. Nobody else reads any of it: the teacher and the mentor included
-- (V18-9); sharing is an open question (OP-V18-5), so there is none. No assistant
-- is called and nothing here suggests a code (V18-3).
--
--   institution.qual_material  the text: title, kind interview|note, body up to
--                              100 000 characters. Never changed: a change is a
--                              new material (V18-7); "locked" is derived, true
--                              once a passage of it is marked
--   institution.qual_code      the codebook: name (up to 80), description (up to
--                              500), the place in the codebook (ord). The order
--                              is the owner's, never by how often a code is used
--                              (V18-8)
--   institution.qual_segment   a marked passage: material, code, paragraph (the
--                              0-based line of the body), start and end (0-based
--                              characters of that line, end exclusive), the quote
--                              (1 to 500) and an optional memo (up to 1000)
--
-- Every table has forced RLS and no privilege for ductus_app: only the RPCs
-- below read and write. Who (C-23, from the relation, never from a role alone):
-- the owner, the person the row belongs to, and nobody else. Another person's,
-- an unknown or a malformed id: the same refusal. Errors carry no input: ZD401 no
-- session, ZD404 not there or not yours, ZD409 wrong state (the message says
-- which: conflict, limit, confirm_required), ZD422 invalid input.
--
-- The body is stored with line breaks as \n (a \r\n or a lone \r is turned into
-- \n), control characters other than a line break and a tab are refused. A
-- paragraph is a line of the body, an empty one included; an anchor is valid only
-- when the quote is exactly the characters start..end of that line (the same rule
-- as server/domain/qualitative-coding).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- Text of 1 to p_max characters with something visible in it and no control
-- characters; a single line is also trimmed; p_multiline allows \n and \t.
CREATE FUNCTION institution.qual_text_valid(p_value text, p_max integer, p_multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(p_value IS NOT NULL AND char_length(p_value) BETWEEN 1 AND p_max
     AND btrim(p_value, E' \t\n') <> ''
     AND (p_multiline OR p_value = btrim(p_value))
     AND p_value !~ CASE WHEN p_multiline THEN '[\x01-\x08\x0b-\x1f\x7f]' ELSE '[[:cntrl:]]' END, false)
$$;

-- The body of a material as stored: up to 100 000 characters, \n for a break.
CREATE FUNCTION institution.qual_body_valid(p_body text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT institution.qual_text_valid(p_body, 100000, true)
$$;

-- A line break as \n, whatever the paste had.
CREATE FUNCTION institution.qual_normalize_body(p_body text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT replace(replace(p_body, E'\r\n', E'\n'), E'\r', E'\n')
$$;

-- Is the quote exactly the characters start..end of that line of the body?
CREATE FUNCTION institution.qual_anchor_valid(p_body text, p_paragraph integer, p_start integer,
                                              p_end integer, p_quote text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(p_body IS NOT NULL AND p_quote IS NOT NULL
     AND p_paragraph >= 0 AND p_start >= 0 AND p_end > p_start AND p_end - p_start <= 500
     AND char_length(p_quote) = p_end - p_start
     AND btrim(p_quote, E' \t') <> ''
     AND p_quote = substr((string_to_array(p_body, E'\n'))[p_paragraph + 1], p_start + 1, p_end - p_start), false)
$$;

CREATE TABLE institution.qual_material (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  title text NOT NULL CHECK (institution.qual_text_valid(title, 200, false)),
  kind text NOT NULL CHECK (kind IN ('interview', 'note')),
  body text NOT NULL CHECK (institution.qual_body_valid(body) AND body !~ E'\r'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX qual_material_owner_idx ON institution.qual_material (owner_id, institution_id);

CREATE TABLE institution.qual_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (institution.qual_text_valid(name, 80, false)),
  description text NOT NULL DEFAULT '' CHECK (description = '' OR institution.qual_text_valid(description, 500, false)),
  ord integer NOT NULL CHECK (ord BETWEEN 1 AND 200),
  -- Moving a code renumbers the codebook in one statement, so the check waits.
  CONSTRAINT qual_code_owner_ord_key UNIQUE (owner_id, ord) DEFERRABLE INITIALLY IMMEDIATE,
  UNIQUE (id, owner_id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE UNIQUE INDEX qual_code_owner_name_key ON institution.qual_code (owner_id, lower(name));

CREATE TABLE institution.qual_segment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  material_id uuid NOT NULL,
  code_id uuid NOT NULL,
  paragraph integer NOT NULL CHECK (paragraph >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL,
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 500),
  memo text CHECK (memo IS NULL OR institution.qual_text_valid(memo, 1000, true)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (end_offset > start_offset AND end_offset - start_offset = char_length(quote)),
  UNIQUE (material_id, code_id, paragraph, start_offset, end_offset),
  FOREIGN KEY (material_id, owner_id, institution_id)
    REFERENCES institution.qual_material (id, owner_id, institution_id),
  FOREIGN KEY (code_id, owner_id, institution_id)
    REFERENCES institution.qual_code (id, owner_id, institution_id)
);
CREATE INDEX qual_segment_material_idx ON institution.qual_segment (material_id, owner_id, institution_id);
CREATE INDEX qual_segment_code_idx ON institution.qual_segment (code_id, owner_id, institution_id);

-- A material never changes (a change is a new material); a passage never
-- changes (it is removed and marked again); of a code only the name, the
-- description and the place change.
CREATE FUNCTION institution.reject_qual_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;

CREATE FUNCTION institution.guard_qual_code() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF (NEW.id, NEW.institution_id, NEW.owner_id) IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.owner_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['qual_material', 'qual_code', 'qual_segment'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_qual_change()',
                   t || '_no_truncate', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['qual_material', 'qual_segment'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_qual_change()',
                   t || '_fixed', t);
  END LOOP;
END
$$;
CREATE TRIGGER qual_code_guard BEFORE UPDATE ON institution.qual_code
  FOR EACH ROW EXECUTE FUNCTION institution.guard_qual_code();

-- The caller's own material, or ZD401 without a session and ZD404 for anything
-- else (another's, unknown, null). Returns the caller's ids.
CREATE FUNCTION institution.qual_material_context(p_id uuid, OUT o_user_id uuid, OUT o_institution_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  IF p_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.qual_material m
        WHERE m.id = p_id AND m.owner_id = o_user_id AND m.institution_id = o_institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- The same for a code.
CREATE FUNCTION institution.qual_code_context(p_id uuid, OUT o_user_id uuid, OUT o_institution_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  IF p_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.qual_code c
        WHERE c.id = p_id AND c.owner_id = o_user_id AND c.institution_id = o_institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- Renumbers the codebook of a person 1..n in its present order (after a delete).
CREATE FUNCTION institution.qual_renumber_codes(p_owner uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
BEGIN
  SET CONSTRAINTS institution.qual_code_owner_ord_key DEFERRED;
  UPDATE institution.qual_code c SET ord = r.n
    FROM (SELECT x.id, row_number() OVER (ORDER BY x.ord, x.id)::integer AS n
            FROM institution.qual_code x WHERE x.owner_id = p_owner) r
   WHERE c.id = r.id AND c.ord <> r.n;
  SET CONSTRAINTS institution.qual_code_owner_ord_key IMMEDIATE;
END
$$;

-- Keeps a text for the caller; returns its id. ZD422 for a title, a kind or a
-- text that is not allowed; ZD409 limit at 200 materials.
CREATE FUNCTION app.create_qual_material(p_title text, p_kind text, p_body text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_body text := institution.qual_normalize_body(p_body);
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF NOT institution.qual_text_valid(p_title, 200, false) OR p_kind IS NULL OR p_kind NOT IN ('interview', 'note')
     OR NOT institution.qual_body_valid(v_body) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qual_material:' || v_actor.user_id, 0));
  IF (SELECT count(*) FROM institution.qual_material m WHERE m.owner_id = v_actor.user_id) >= 200 THEN
    RAISE EXCEPTION 'limit' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.qual_material (institution_id, owner_id, title, kind, body)
  VALUES (v_actor.institution_id, v_actor.user_id, p_title, p_kind, v_body) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The caller's materials, newest first, without the text.
CREATE FUNCTION app.qual_materials()
RETURNS TABLE (id uuid, title text, kind text, created_on date, char_count integer, segment_count integer, locked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  RETURN QUERY
  SELECT m.id, m.title, m.kind, m.created_at::date, char_length(m.body),
         (SELECT count(*)::integer FROM institution.qual_segment s WHERE s.material_id = m.id),
         EXISTS (SELECT 1 FROM institution.qual_segment s WHERE s.material_id = m.id)
    FROM institution.qual_material m
   WHERE m.owner_id = v_actor.user_id AND m.institution_id = v_actor.institution_id
   ORDER BY m.created_at DESC, m.id;
END
$$;

-- One material of the caller with its text.
CREATE FUNCTION app.qual_material(p_id uuid)
RETURNS TABLE (id uuid, title text, kind text, body text, created_on date, segment_count integer, locked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_material_context(p_id);
  RETURN QUERY
  SELECT m.id, m.title, m.kind, m.body, m.created_at::date,
         (SELECT count(*)::integer FROM institution.qual_segment s WHERE s.material_id = m.id),
         EXISTS (SELECT 1 FROM institution.qual_segment s WHERE s.material_id = m.id)
    FROM institution.qual_material m WHERE m.id = p_id;
END
$$;

-- Deletes a material of the caller with its passages.
CREATE FUNCTION app.delete_qual_material(p_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_material_context(p_id);
  PERFORM 1 FROM institution.qual_material m WHERE m.id = p_id FOR UPDATE;
  DELETE FROM institution.qual_segment WHERE material_id = p_id;
  DELETE FROM institution.qual_material WHERE id = p_id;
END
$$;

-- Adds a code to the end of the caller's codebook; returns its id. ZD409
-- conflict for a name the codebook already has (case aside), limit at 200.
CREATE FUNCTION app.create_qual_code(p_name text, p_description text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_description text := coalesce(p_description, '');
  v_id uuid;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF NOT institution.qual_text_valid(p_name, 80, false)
     OR NOT (v_description = '' OR institution.qual_text_valid(v_description, 500, false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qual_code:' || v_actor.user_id, 0));
  IF (SELECT count(*) FROM institution.qual_code c WHERE c.owner_id = v_actor.user_id) >= 200 THEN
    RAISE EXCEPTION 'limit' USING ERRCODE = 'ZD409';
  END IF;
  BEGIN
    INSERT INTO institution.qual_code (institution_id, owner_id, name, description, ord)
    VALUES (v_actor.institution_id, v_actor.user_id, p_name, v_description,
            (SELECT coalesce(max(c.ord), 0) + 1 FROM institution.qual_code c WHERE c.owner_id = v_actor.user_id))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END;
  RETURN v_id;
END
$$;

-- The caller's codebook in its own order (ord), never by use; the number of
-- marked passages is a description, not an order.
CREATE FUNCTION app.qual_codes()
RETURNS TABLE (id uuid, name text, description text, ord integer, segment_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  RETURN QUERY
  SELECT c.id, c.name, c.description, c.ord,
         (SELECT count(*)::integer FROM institution.qual_segment s WHERE s.code_id = c.id)
    FROM institution.qual_code c
   WHERE c.owner_id = v_actor.user_id AND c.institution_id = v_actor.institution_id
   ORDER BY c.ord;
END
$$;

-- Renames a code and changes its description.
CREATE FUNCTION app.update_qual_code(p_id uuid, p_name text, p_description text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_description text := coalesce(p_description, '');
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_code_context(p_id);
  IF NOT institution.qual_text_valid(p_name, 80, false)
     OR NOT (v_description = '' OR institution.qual_text_valid(v_description, 500, false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  BEGIN
    UPDATE institution.qual_code SET name = p_name, description = v_description WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END;
END
$$;

-- Moves a code to a place (1 = first) of the caller's codebook; the others keep
-- their order. ZD422 for a place outside 1..number of codes.
CREATE FUNCTION app.move_qual_code(p_id uuid, p_position integer)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_code_context(p_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qual_code:' || v_ctx.o_user_id, 0));
  IF p_position IS NULL OR p_position < 1
     OR p_position > (SELECT count(*) FROM institution.qual_code c WHERE c.owner_id = v_ctx.o_user_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SET CONSTRAINTS institution.qual_code_owner_ord_key DEFERRED;
  UPDATE institution.qual_code c SET ord = x.new_ord
    FROM (SELECT r.id,
                 CASE WHEN r.id = p_id THEN p_position
                      ELSE r.n + CASE WHEN r.n >= p_position THEN 1 ELSE 0 END END AS new_ord
            FROM (SELECT y.id, row_number() OVER (PARTITION BY (y.id = p_id) ORDER BY y.ord, y.id)::integer AS n
                    FROM institution.qual_code y WHERE y.owner_id = v_ctx.o_user_id) r) x
   WHERE c.id = x.id AND c.ord <> x.new_ord;
  SET CONSTRAINTS institution.qual_code_owner_ord_key IMMEDIATE;
END
$$;

-- Deletes a code of the caller. A code with marked passages is deleted, with its
-- passages, only when p_confirm is true (ZD409 confirm_required otherwise);
-- returns the number of passages removed. The codebook is renumbered.
CREATE FUNCTION app.delete_qual_code(p_id uuid, p_confirm boolean)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_removed integer;
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_code_context(p_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qual_code:' || v_ctx.o_user_id, 0));
  PERFORM 1 FROM institution.qual_code c WHERE c.id = p_id FOR UPDATE;
  SELECT count(*)::integer INTO v_removed FROM institution.qual_segment s WHERE s.code_id = p_id;
  IF v_removed > 0 AND p_confirm IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'confirm_required' USING ERRCODE = 'ZD409';
  END IF;
  DELETE FROM institution.qual_segment WHERE code_id = p_id;
  DELETE FROM institution.qual_code WHERE id = p_id;
  PERFORM institution.qual_renumber_codes(v_ctx.o_user_id);
  RETURN v_removed;
END
$$;

-- Marks a passage of a material of the caller with a code of the caller. The
-- quote must be exactly the characters start..end of that line of the text
-- (ZD422 otherwise). ZD409 conflict for the same mark again, limit at 5000
-- passages of a material.
CREATE FUNCTION app.create_qual_segment(p_material_id uuid, p_code_id uuid, p_paragraph integer,
                                        p_start integer, p_end integer, p_quote text, p_memo text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_body text;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_material_context(p_material_id);
  PERFORM institution.qual_code_context(p_code_id);
  -- Both rows are held, so a delete at the same time cannot be overtaken.
  SELECT m.body INTO v_body FROM institution.qual_material m WHERE m.id = p_material_id FOR SHARE;
  PERFORM 1 FROM institution.qual_code c WHERE c.id = p_code_id FOR SHARE;
  IF v_body IS NULL OR NOT EXISTS (SELECT 1 FROM institution.qual_code c WHERE c.id = p_code_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF NOT institution.qual_anchor_valid(v_body, p_paragraph, p_start, p_end, p_quote)
     OR NOT (p_memo IS NULL OR institution.qual_text_valid(p_memo, 1000, true)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qual_segment:' || p_material_id, 0));
  IF (SELECT count(*) FROM institution.qual_segment s WHERE s.material_id = p_material_id) >= 5000 THEN
    RAISE EXCEPTION 'limit' USING ERRCODE = 'ZD409';
  END IF;
  BEGIN
    INSERT INTO institution.qual_segment
      (institution_id, owner_id, material_id, code_id, paragraph, start_offset, end_offset, quote, memo)
    VALUES (v_ctx.o_institution_id, v_ctx.o_user_id, p_material_id, p_code_id, p_paragraph, p_start, p_end,
            p_quote, p_memo)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END;
  RETURN v_id;
END
$$;

-- The marked passages of a material of the caller, in the order of the text
-- (paragraph, start, end), then of the codebook.
CREATE FUNCTION app.qual_segments(p_material_id uuid)
RETURNS TABLE (id uuid, code_id uuid, paragraph integer, start_offset integer, end_offset integer,
               quote text, memo text, created_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.qual_material_context(p_material_id);
  RETURN QUERY
  SELECT s.id, s.code_id, s.paragraph, s.start_offset, s.end_offset, s.quote, s.memo, s.created_at::date
    FROM institution.qual_segment s
    JOIN institution.qual_code c ON c.id = s.code_id
   WHERE s.material_id = p_material_id
   ORDER BY s.paragraph, s.start_offset, s.end_offset, c.ord, s.id;
END
$$;

-- Removes one marked passage of the caller.
CREATE FUNCTION app.delete_qual_segment(p_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_deleted integer;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  DELETE FROM institution.qual_segment s
   WHERE s.id = p_id AND s.owner_id = v_actor.user_id AND s.institution_id = v_actor.institution_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- The passages for the export, of one material (p_material_id) or of all the
-- caller's: in the order of the codebook, then of the materials (the order they
-- were kept in), then of the text. Never by how often. The material rank is the
-- place of the material in that order.
CREATE FUNCTION app.qual_export_segments(p_material_id uuid)
RETURNS TABLE (material_id uuid, material_rank integer, code_id uuid, paragraph integer,
               start_offset integer, end_offset integer, quote text, memo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM institution.require_actor();
  IF p_material_id IS NOT NULL THEN
    PERFORM institution.qual_material_context(p_material_id);
  END IF;
  RETURN QUERY
  SELECT s.material_id, r.rank, s.code_id, s.paragraph, s.start_offset, s.end_offset, s.quote, s.memo
    FROM institution.qual_segment s
    JOIN institution.qual_code c ON c.id = s.code_id
    JOIN (SELECT m.id, (row_number() OVER (ORDER BY m.created_at, m.id))::integer AS rank
            FROM institution.qual_material m
           WHERE m.owner_id = v_actor.user_id AND m.institution_id = v_actor.institution_id) r
      ON r.id = s.material_id
   WHERE s.owner_id = v_actor.user_id AND s.institution_id = v_actor.institution_id
     AND (p_material_id IS NULL OR s.material_id = p_material_id)
   ORDER BY c.ord, r.rank, s.paragraph, s.start_offset, s.end_offset, s.id;
END
$$;

REVOKE ALL ON FUNCTION institution.qual_text_valid(text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.qual_body_valid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.qual_normalize_body(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.qual_anchor_valid(text, integer, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.reject_qual_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.guard_qual_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.qual_material_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.qual_code_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.qual_renumber_codes(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_qual_material(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.qual_materials() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.qual_material(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_qual_material(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_qual_code(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.qual_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_qual_code(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.move_qual_code(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_qual_code(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_qual_segment(uuid, uuid, integer, integer, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.qual_segments(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_qual_segment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.qual_export_segments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_qual_material(text, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.qual_materials() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.qual_material(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.delete_qual_material(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.create_qual_code(text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.qual_codes() TO ductus_app;
GRANT EXECUTE ON FUNCTION app.update_qual_code(uuid, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.move_qual_code(uuid, integer) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.delete_qual_code(uuid, boolean) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.create_qual_segment(uuid, uuid, integer, integer, integer, text, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.qual_segments(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.delete_qual_segment(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.qual_export_segments(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.qual_export_segments(uuid);
DROP FUNCTION app.delete_qual_segment(uuid);
DROP FUNCTION app.qual_segments(uuid);
DROP FUNCTION app.create_qual_segment(uuid, uuid, integer, integer, integer, text, text);
DROP FUNCTION app.delete_qual_code(uuid, boolean);
DROP FUNCTION app.move_qual_code(uuid, integer);
DROP FUNCTION app.update_qual_code(uuid, text, text);
DROP FUNCTION app.qual_codes();
DROP FUNCTION app.create_qual_code(text, text);
DROP FUNCTION app.delete_qual_material(uuid);
DROP FUNCTION app.qual_material(uuid);
DROP FUNCTION app.qual_materials();
DROP FUNCTION app.create_qual_material(text, text, text);
DROP TABLE institution.qual_segment;
DROP TABLE institution.qual_code;
DROP TABLE institution.qual_material;
DROP FUNCTION institution.qual_renumber_codes(uuid);
DROP FUNCTION institution.qual_code_context(uuid);
DROP FUNCTION institution.qual_material_context(uuid);
DROP FUNCTION institution.guard_qual_code();
DROP FUNCTION institution.reject_qual_change();
DROP FUNCTION institution.qual_anchor_valid(text, integer, integer, integer, text);
DROP FUNCTION institution.qual_normalize_body(text);
DROP FUNCTION institution.qual_body_valid(text);
DROP FUNCTION institution.qual_text_valid(text, integer, boolean);
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
