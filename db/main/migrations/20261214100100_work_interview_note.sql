-- migrate:up
-- PIL-K-RAZGOVOR-SRV (Ductus#2052; the owner's decision of 22. 11. 2026 that
-- the note attachment of the interview enters the pilot): the student who owns
-- the work attaches a note to the interview preparation, a plain text or a PDF
-- file, after the invitation and until the interview is held. The file is kept
-- on the server with its SHA-256; attaching it goes to the trail.
--
-- Access comes from the same place as the rest of the interview
-- (institution.work_interview_context, the relation to the work, C-23): a
-- student before the invitation, another student, a teacher of the work and a
-- stranger are refused alike (ZD403). A held interview takes no new note
-- (ZD409). An invalid file name, type or content, a file over the limit and a
-- work at its bound of notes are ZD422. The same bytes attached twice to the
-- same interview answer the note already kept, with no second trail row.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The bounds of a note, one constant each, read by the server and the tests.
CREATE FUNCTION institution.work_interview_note_max_bytes() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 1048576 $$;
CREATE FUNCTION institution.work_interview_note_max_count() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 20 $$;

CREATE TABLE institution.work_interview_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  interview_id uuid NOT NULL,
  author_id uuid NOT NULL,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200 AND file_name !~ '[[:cntrl:]/\\]'),
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'application/pdf')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (interview_id, content_sha256),
  FOREIGN KEY (interview_id, institution_id) REFERENCES institution.work_interview (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_interview_note_interview_idx ON institution.work_interview_note (interview_id, created_at, id);

ALTER TABLE institution.work_interview_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_interview_note FORCE ROW LEVEL SECURITY;
CREATE POLICY work_interview_note_owner ON institution.work_interview_note TO ductus_identity USING (true) WITH CHECK (true);

-- The trail learns one more kind: a note attached.
ALTER TABLE audit.work_interview_event DROP CONSTRAINT work_interview_event_kind_check;
ALTER TABLE audit.work_interview_event ADD CONSTRAINT work_interview_event_kind_check
  CHECK (kind IN ('invited', 'scheduled', 'held', 'note_attached'));

-- Whether the bytes are what the media type says: a PDF begins with its
-- header, a text is UTF-8 with no control character but tab and line breaks.
CREATE FUNCTION institution.is_work_interview_note(p_media_type text, p_content bytea)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  IF p_content IS NULL OR octet_length(p_content) NOT BETWEEN 1 AND institution.work_interview_note_max_bytes() THEN
    RETURN false;
  END IF;
  IF p_media_type = 'application/pdf' THEN
    RETURN substring(p_content FROM 1 FOR 5) = '\x255044462d'::bytea;
  ELSIF p_media_type = 'text/plain' THEN
    RETURN convert_from(p_content, 'UTF8') !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]';
  END IF;
  RETURN false;
EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN
  RETURN false;
END
$$;

CREATE FUNCTION institution.add_work_interview_note(
  p_document_id text, p_file_name text, p_media_type text, p_content bytea)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c record;
  v_sha256 text;
  v_note institution.work_interview_note;
BEGIN
  SELECT * INTO c FROM institution.work_interview_context(p_document_id);
  IF c.role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_file_name IS NULL OR char_length(p_file_name) NOT BETWEEN 1 AND 200 OR p_file_name ~ '[[:cntrl:]/\\]'
     OR p_file_name <> btrim(p_file_name)
     OR NOT coalesce(institution.is_work_interview_note(p_media_type, p_content), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM institution.work_interview i WHERE i.id = c.interview_id FOR UPDATE;
  IF (SELECT i.held_on IS NOT NULL FROM institution.work_interview i WHERE i.id = c.interview_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD409';
  END IF;
  v_sha256 := encode(sha256(p_content), 'hex');
  SELECT * INTO v_note FROM institution.work_interview_note n
   WHERE n.interview_id = c.interview_id AND n.content_sha256 = v_sha256;
  IF v_note.id IS NULL THEN
    IF (SELECT count(*) FROM institution.work_interview_note n WHERE n.interview_id = c.interview_id)
       >= institution.work_interview_note_max_count() THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    INSERT INTO institution.work_interview_note
      (institution_id, interview_id, author_id, file_name, media_type, content, content_sha256)
    VALUES (c.institution_id, c.interview_id, c.actor_id, p_file_name, p_media_type, p_content, v_sha256)
    RETURNING * INTO v_note;
    INSERT INTO audit.work_interview_event (institution_id, interview_id, kind, actor_id, occurred_at)
    VALUES (c.institution_id, c.interview_id, 'note_attached', c.actor_id, statement_timestamp());
  END IF;
  RETURN jsonb_build_object('id', v_note.id, 'fileName', v_note.file_name, 'mediaType', v_note.media_type,
    'byteSize', octet_length(v_note.content), 'sha256', v_note.content_sha256, 'createdAt', v_note.created_at);
END
$$;

REVOKE ALL ON FUNCTION institution.work_interview_note_max_bytes() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_interview_note_max_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_work_interview_note(text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.add_work_interview_note(text, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.add_work_interview_note(text, text, text, bytea) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.add_work_interview_note(text, text, text, bytea);
DROP FUNCTION institution.is_work_interview_note(text, bytea);
-- The trail is append-only: rows of the new kind stay, so the old check comes back unvalidated.
ALTER TABLE audit.work_interview_event DROP CONSTRAINT work_interview_event_kind_check;
ALTER TABLE audit.work_interview_event ADD CONSTRAINT work_interview_event_kind_check
  CHECK (kind IN ('invited', 'scheduled', 'held')) NOT VALID;
DROP TABLE institution.work_interview_note;
DROP FUNCTION institution.work_interview_note_max_count();
DROP FUNCTION institution.work_interview_note_max_bytes();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
