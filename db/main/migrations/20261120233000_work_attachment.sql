-- migrate:up
-- SRV-10B (Ductus#2051, c.7042818643; plan "Val 10", schema v4 §5): the
-- attachments of a student's work, the images of the document. The bytes of
-- an image are never in the document: the document's image block names an
-- attachment by attachmentId and attachmentSha256 (docs/contracts/
-- document-schema-v4.md §5), and this table is the record of that
-- attachment: whose work it belongs to, its file type, its size, the SHA-256
-- of its exact bytes and where the storage adapter keeps them. The bytes
-- themselves are stored by the server before the row is written; the row
-- only names them (storage_ref).
--
-- An attachment is append-only: a saved revision of the document may name it,
-- and display, export and reconstruction read the same bytes later, so a row
-- is never changed or removed (cropping does not change the attachment,
-- schema v4 §5). The same bytes added twice to the same work are one
-- attachment: the second add answers the first row, so a retry is safe.
--
-- Only through the RPCs: no role but the owner holds a privilege on the
-- table, and its only policy is the owner's. Whether an attachment belongs
-- to the caller's work comes from the caller's relation to the work
-- (institution.work_source_access, 20261120180000: the student of the work,
-- or a reader of it), never from a document (C-23).
--
--   institution.work_attachment            the attachments; forced RLS,
--                                          append-only by trigger
--   institution.add_work_attachment        the student records an attachment
--                                          of the own work
--   institution.work_attachments           the attachments of one work, for
--                                          its student or a reader
--   institution.read_work_attachment       one attachment by id, for the
--                                          student of its work or a reader
--
-- The institution and the student come from the session, never from a
-- parameter. Errors carry no input: ZD401 no session, ZD403 no relation (one
-- answer for every refusal, also for an assignment, student or attachment
-- that does not exist), ZD422 invalid input or a work already at its bound
-- (200 attachments or 100 MiB together).
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- The file types the export embeds (PNG and JPEG); no SVG, which may carry
  -- script.
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The natural size of the image (prototype nw, nh), data of the attachment
  -- and not of the document (schema v4 §5); unknown is null for both.
  pixel_width integer CHECK (pixel_width BETWEEN 1 AND 20000),
  pixel_height integer CHECK (pixel_height BETWEEN 1 AND 20000),
  -- What the storage adapter answered for the stored bytes: printable ASCII
  -- without spaces, at most 1024.
  storage_ref text NOT NULL CHECK (char_length(storage_ref) <= 1024 AND storage_ref ~ '^[!-~]+$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((pixel_width IS NULL) = (pixel_height IS NULL)),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  UNIQUE (assignment_id, student_id, sha256),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX work_attachment_student_idx ON institution.work_attachment (student_id);

ALTER TABLE institution.work_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY work_attachment_owner ON institution.work_attachment TO ductus_identity USING (true) WITH CHECK (true);

CREATE FUNCTION institution.refuse_work_attachment_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'work attachment is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER work_attachment_immutable BEFORE UPDATE OR DELETE ON institution.work_attachment
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_work_attachment_change();
CREATE TRIGGER work_attachment_no_truncate BEFORE TRUNCATE ON institution.work_attachment
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_work_attachment_change();

-- The student of the work records an attachment whose bytes the server has
-- stored. The same bytes (same SHA-256) in the same work answer the row that
-- is already there, with created false; its storage_ref is kept.
CREATE FUNCTION institution.add_work_attachment(p_assignment_id uuid, p_media_type text, p_byte_size integer,
                                                p_sha256 text, p_storage_ref text,
                                                p_pixel_width integer DEFAULT NULL,
                                                p_pixel_height integer DEFAULT NULL)
RETURNS TABLE (id uuid, media_type text, byte_size integer, sha256 text, pixel_width integer,
               pixel_height integer, storage_ref text, created_at timestamptz, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF NOT coalesce(p_media_type IN ('image/png', 'image/jpeg'), false)
     OR NOT coalesce(p_byte_size BETWEEN 1 AND 5242880, false)
     OR NOT coalesce(p_sha256 ~ '^[0-9a-f]{64}$', false)
     OR NOT coalesce(char_length(p_storage_ref) <= 1024 AND p_storage_ref ~ '^[!-~]+$', false)
     OR (p_pixel_width IS NULL) <> (p_pixel_height IS NULL)
     OR NOT coalesce(p_pixel_width BETWEEN 1 AND 20000 AND p_pixel_height BETWEEN 1 AND 20000, p_pixel_width IS NULL) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_source_access(p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- One writer per work at a time, so the bounds below hold.
  PERFORM pg_advisory_xact_lock(hashtextextended('work_attachment:' || p_assignment_id || ':' || v_user, 0));
  RETURN QUERY
    SELECT w.id, w.media_type, w.byte_size, w.sha256, w.pixel_width, w.pixel_height, w.storage_ref,
           w.created_at, false
      FROM institution.work_attachment w
     WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user AND w.sha256 = p_sha256;
  IF FOUND THEN
    RETURN;
  END IF;
  IF (SELECT count(*) >= 200 OR coalesce(sum(w.byte_size), 0) + p_byte_size > 104857600
        FROM institution.work_attachment w
       WHERE w.assignment_id = p_assignment_id AND w.student_id = v_user) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO institution.work_attachment AS w
      (institution_id, assignment_id, student_id, media_type, byte_size, sha256, pixel_width, pixel_height,
       storage_ref)
    VALUES (v_institution, p_assignment_id, v_user, p_media_type, p_byte_size, p_sha256, p_pixel_width,
            p_pixel_height, p_storage_ref)
    RETURNING w.id, w.media_type, w.byte_size, w.sha256, w.pixel_width, w.pixel_height, w.storage_ref,
              w.created_at, true;
END
$$;

-- The attachments of one work, oldest first, then by id. With p_student_id
-- null or the caller: the caller's own. Else a reader of that student's work.
-- One STABLE read; writes nothing.
CREATE FUNCTION institution.work_attachments(p_assignment_id uuid, p_student_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, media_type text, byte_size integer, sha256 text, pixel_width integer,
               pixel_height integer, storage_ref text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_student uuid;
  v_needed text;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  v_student := coalesce(p_student_id, v_user);
  v_needed := CASE WHEN v_student = v_user THEN 'student' ELSE 'reader' END;
  IF institution.work_source_access(p_assignment_id, v_student) IS DISTINCT FROM v_needed THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT w.id, w.media_type, w.byte_size, w.sha256, w.pixel_width, w.pixel_height, w.storage_ref, w.created_at
      FROM institution.work_attachment w
     WHERE w.institution_id = v_institution AND w.assignment_id = p_assignment_id AND w.student_id = v_student
     ORDER BY w.created_at, w.id;
END
$$;

-- One attachment by id, for the path that reads its bytes (display, export,
-- reconstruction): the student of its work or a reader of it. The id alone
-- names no work, so the relation is checked for the work the row belongs to;
-- an attachment of another institution, another's work or none is ZD403.
CREATE FUNCTION institution.read_work_attachment(p_attachment_id uuid)
RETURNS TABLE (id uuid, assignment_id uuid, student_id uuid, media_type text, byte_size integer, sha256 text,
               pixel_width integer, pixel_height integer, storage_ref text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_row institution.work_attachment;
  v_needed text;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  SELECT * INTO v_row FROM institution.work_attachment w
   WHERE w.id = p_attachment_id AND w.institution_id = v_institution;
  v_needed := CASE WHEN v_row.student_id = v_user THEN 'student' ELSE 'reader' END;
  IF v_row.id IS NULL
     OR institution.work_source_access(v_row.assignment_id, v_row.student_id) IS DISTINCT FROM v_needed THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.assignment_id, v_row.student_id, v_row.media_type, v_row.byte_size,
                      v_row.sha256, v_row.pixel_width, v_row.pixel_height, v_row.storage_ref, v_row.created_at;
END
$$;

REVOKE ALL ON FUNCTION institution.refuse_work_attachment_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.add_work_attachment(uuid, text, integer, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.work_attachments(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.read_work_attachment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.add_work_attachment(uuid, text, integer, text, text, integer, integer) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.work_attachments(uuid, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.read_work_attachment(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.read_work_attachment(uuid);
DROP FUNCTION institution.work_attachments(uuid, uuid);
DROP FUNCTION institution.add_work_attachment(uuid, text, integer, text, text, integer, integer);
DROP TABLE institution.work_attachment;
DROP FUNCTION institution.refuse_work_attachment_change();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
