-- migrate:up
-- SRV-V17-BANK-EDIT (val 17, Ductus#2055; docs/nalazi/val17-razlika.md §2, §3
-- in the web repository): the teacher edits an entry of the comment bank and
-- gives it a short label. The bank is the teacher's saved comment templates of
-- SRV-8B (collaboration.comment_template, 20261121120000), private to their
-- author (D-130); nothing here makes an entry readable by anyone else.
--
--   collaboration.comment_template.label        null = no label; 1 to 40 characters
--   collaboration.create_comment_template(text, text, text)
--                                               as the two-argument form, with a label
--   collaboration.list_comment_templates()      now also returns the label
--   collaboration.update_comment_template       the author replaces text, kind and label
--
-- The two-argument create_comment_template stays as it was (no label), so no
-- earlier caller changes. An update replaces the entry as a whole: a missing
-- label in the request is a null one. The author is the session's; another
-- teacher's entry and one that is not there are both ZD403 (C-23), asked
-- before the input is, so a refusal never depends on the text sent. ZD401 no
-- session, ZD422 invalid input. Errors carry no input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

ALTER TABLE collaboration.comment_template ADD COLUMN label text
  CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 40 AND label !~ '[[:cntrl:]]' AND btrim(label) <> ''));

-- A teacher whose role is confirmed and not revoked saves an entry with a label.
CREATE FUNCTION collaboration.create_comment_template(p_body text, p_kind text, p_label text)
RETURNS TABLE (template_id uuid, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT EXISTS (
    SELECT 1 FROM institution.institution_role r
     WHERE r.institution_id = actor.institution_id AND r.user_id = actor.user_id AND r.role = 'teacher'
       AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR NOT coalesce(p_kind IN ('must', 'sugg', 'q', 'praise'), false)
     OR NOT coalesce(p_label IS NULL OR (char_length(p_label) BETWEEN 1 AND 40
                                         AND p_label !~ '[[:cntrl:]]' AND btrim(p_label) <> ''), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('comment_template:' || actor.user_id, 0));
  IF (SELECT count(*) >= 200 FROM collaboration.comment_template t
       WHERE t.author_id = actor.user_id AND t.institution_id = actor.institution_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.comment_template AS t (institution_id, author_id, kind, body, label)
    VALUES (actor.institution_id, actor.user_id, p_kind, p_body, p_label)
    RETURNING t.id, t.created_at;
END
$$;

-- The caller's own entries, oldest first, then by id; now with the label.
DROP FUNCTION collaboration.list_comment_templates();
CREATE FUNCTION collaboration.list_comment_templates()
RETURNS TABLE (template_id uuid, kind text, body text, created_at timestamptz, label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  RETURN QUERY
    SELECT t.id, t.kind, t.body, t.created_at, t.label
      FROM collaboration.comment_template t
     WHERE t.author_id = actor.user_id AND t.institution_id = actor.institution_id
     ORDER BY t.created_at, t.id;
END
$$;

-- The author replaces text, kind and label of an entry; the creation time stays.
CREATE FUNCTION collaboration.update_comment_template(p_template_id uuid, p_body text, p_kind text, p_label text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  PERFORM 1 FROM collaboration.comment_template t
   WHERE t.id = p_template_id AND t.author_id = actor.user_id AND t.institution_id = actor.institution_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF NOT coalesce(collaboration.is_comment_body(p_body), false)
     OR NOT coalesce(p_kind IN ('must', 'sugg', 'q', 'praise'), false)
     OR NOT coalesce(p_label IS NULL OR (char_length(p_label) BETWEEN 1 AND 40
                                         AND p_label !~ '[[:cntrl:]]' AND btrim(p_label) <> ''), false) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  UPDATE collaboration.comment_template t SET kind = p_kind, body = p_body, label = p_label
   WHERE t.id = p_template_id AND t.author_id = actor.user_id AND t.institution_id = actor.institution_id;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.create_comment_template(text, text, text),
  collaboration.list_comment_templates(),
  collaboration.update_comment_template(uuid, text, text, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.create_comment_template(text, text, text),
  collaboration.list_comment_templates(),
  collaboration.update_comment_template(uuid, text, text, text)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.update_comment_template(uuid, text, text, text);
DROP FUNCTION collaboration.list_comment_templates();
CREATE FUNCTION collaboration.list_comment_templates()
RETURNS TABLE (template_id uuid, kind text, body text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  RETURN QUERY
    SELECT t.id, t.kind, t.body, t.created_at
      FROM collaboration.comment_template t
     WHERE t.author_id = actor.user_id AND t.institution_id = actor.institution_id
     ORDER BY t.created_at, t.id;
END
$$;
REVOKE ALL ON FUNCTION collaboration.list_comment_templates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.list_comment_templates() TO ductus_app;
DROP FUNCTION collaboration.create_comment_template(text, text, text);
ALTER TABLE collaboration.comment_template DROP COLUMN label;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
