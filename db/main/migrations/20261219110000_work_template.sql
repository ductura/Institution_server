-- migrate:up
-- SRV-V17-TEMPLATE-ADMIN (val 17, N-V17 predložak rada): the work template of an institution.
--
-- A faculty keeps one template per work type (short_paper ... doctoral_thesis), versioned like
-- its milestone template (SRV-1521) and its rules: a version is only ever added. A version is
--
--   title_page      the fields of the title page, in order, a distinct subset of
--                   title, author, mentor, course, date (at most 5)
--   sections        the skeleton of sections, at most 30, each exactly {title, hint}:
--                   title 1..120 characters, hint 0..400 characters (empty = no hint)
--   citation_style  fpzg (the only style of the institution rules)
--
-- The administrator of the institution reads and adds versions; the version number is per
-- institution and work type, expected version 0 when there was none, ZD409 when another one
-- was added in between. Nothing else reads the template in this step: giving it to an
-- assignment and to the student is SRV-V17-TEMPLATE-ASSIGN.
--
-- Errors carry no input: ZD401 no session, ZD403 not an administrator, ZD409 conflict,
-- ZD422 invalid input (including an unknown work type).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.work_template_version (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  work_type text NOT NULL CHECK (work_type IN ('short_paper', 'essay', 'seminar_paper', 'bachelor_thesis',
    'master_thesis', 'specialist_thesis', 'doctoral_thesis')),
  version integer NOT NULL CHECK (version >= 1),
  title_page jsonb NOT NULL CHECK (jsonb_typeof(title_page) = 'array' AND jsonb_array_length(title_page) <= 5),
  sections jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 30),
  citation_style text NOT NULL CHECK (citation_style IN ('fpzg')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (institution_id, work_type, version),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE institution.work_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.work_template_version FORCE ROW LEVEL SECURITY;
CREATE POLICY work_template_version_owner ON institution.work_template_version
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON institution.work_template_version FROM PUBLIC, ductus_app;

-- Append only, for every role: a stored version never changes and never goes.
CREATE FUNCTION institution.reject_work_template_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'work template version is immutable' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER work_template_version_immutable BEFORE UPDATE OR DELETE ON institution.work_template_version
  FOR EACH ROW EXECUTE FUNCTION institution.reject_work_template_change();
CREATE TRIGGER work_template_version_no_truncate BEFORE TRUNCATE ON institution.work_template_version
  FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_work_template_change();

-- A text of a template: NFC, no control characters, between p_min and p_max characters.
CREATE FUNCTION institution.is_work_template_text(p_text text, p_min integer, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_text IS NOT NULL AND pg_catalog.char_length(p_text) BETWEEN p_min AND p_max
    AND p_text IS NFC NORMALIZED AND p_text !~ '[[:cntrl:]]'
    AND (p_min = 0 OR p_text ~ '[^[:space:]]')
$$;

-- The title page: an array of at most 5 distinct strings out of title, author, mentor,
-- course, date.
CREATE FUNCTION institution.is_work_template_title_page(p_list jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF p_list IS NULL OR pg_catalog.jsonb_typeof(p_list) <> 'array' OR pg_catalog.jsonb_array_length(p_list) > 5 THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_list) e LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'string'
       OR (v_item #>> '{}') NOT IN ('title', 'author', 'mentor', 'course', 'date') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT e) = pg_catalog.jsonb_array_length(p_list) FROM pg_catalog.jsonb_array_elements(p_list) e);
END
$$;

-- The skeleton: at most 30 objects, each exactly {title, hint}.
CREATE FUNCTION institution.is_work_template_sections(p_list jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
  v_key text;
BEGIN
  IF p_list IS NULL OR pg_catalog.jsonb_typeof(p_list) <> 'array' OR pg_catalog.jsonb_array_length(p_list) > 30
     OR pg_catalog.octet_length(p_list::text) > 65536 THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_list) e LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      RETURN false;
    END IF;
    FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_item) k LOOP
      IF v_key NOT IN ('title', 'hint') THEN
        RETURN false;
      END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(v_item -> 'title') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'hint') IS DISTINCT FROM 'string'
       OR NOT institution.is_work_template_text(v_item ->> 'title', 1, 120)
       OR NOT institution.is_work_template_text(v_item ->> 'hint', 0, 400) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

-- The versions of the template of one work type of the caller's institution, in ascending
-- order, for an administrator of it.
CREATE FUNCTION app.read_work_template(p_work_type text)
RETURNS TABLE (
  version integer, title_page jsonb, sections jsonb, citation_style text, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_work_type IS NULL OR p_work_type NOT IN ('short_paper', 'essay', 'seminar_paper', 'bachelor_thesis',
       'master_thesis', 'specialist_thesis', 'doctoral_thesis') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN QUERY
    SELECT t.version, t.title_page, t.sections, t.citation_style, t.created_at
      FROM institution.work_template_version t
     WHERE t.institution_id = v_institution AND t.work_type = p_work_type
     ORDER BY t.version;
END
$$;

-- The administrator adds the next version of one work type. The institution row is locked,
-- so versions are numbered without gaps.
CREATE FUNCTION app.publish_work_template(
  p_work_type text, p_expected_version integer, p_title_page jsonb, p_sections jsonb, p_citation_style text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_latest integer;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_work_type IS NULL OR p_work_type NOT IN ('short_paper', 'essay', 'seminar_paper', 'bachelor_thesis',
       'master_thesis', 'specialist_thesis', 'doctoral_thesis')
     OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_citation_style IS DISTINCT FROM 'fpzg'
     OR NOT institution.is_work_template_title_page(p_title_page)
     OR NOT institution.is_work_template_sections(p_sections) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM 1 FROM identity.institution i WHERE i.id = v_institution FOR UPDATE;
  SELECT coalesce(max(t.version), 0) INTO v_latest
    FROM institution.work_template_version t
   WHERE t.institution_id = v_institution AND t.work_type = p_work_type;
  IF v_latest <> p_expected_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_template_version
    (institution_id, work_type, version, title_page, sections, citation_style, created_by)
  VALUES (v_institution, p_work_type, v_latest + 1, p_title_page, p_sections, p_citation_style, v_user);
  RETURN v_latest + 1;
END
$$;

REVOKE ALL ON FUNCTION institution.reject_work_template_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_work_template_text(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_work_template_title_page(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.is_work_template_sections(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_work_template(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_work_template(text, integer, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_work_template(text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.publish_work_template(text, integer, jsonb, jsonb, text) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.publish_work_template(text, integer, jsonb, jsonb, text);
DROP FUNCTION app.read_work_template(text);
DROP FUNCTION institution.is_work_template_sections(jsonb);
DROP FUNCTION institution.is_work_template_title_page(jsonb);
DROP FUNCTION institution.is_work_template_text(text, integer, integer);
DROP TABLE institution.work_template_version;
DROP FUNCTION institution.reject_work_template_change();
SET LOCAL ROLE ductus_migrator;
