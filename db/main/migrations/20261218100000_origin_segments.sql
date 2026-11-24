-- migrate:up
-- SRV-KARTA-RASPON (Ductus#2055; P-1, NF-5 PG-2, the map of origin): where in a
-- revision of a work each kind of origin stands, so that the map can mark it
-- per paragraph. app.work_origin_composition (20261213100300) gives only the
-- share per kind and evidence.origin_change holds no position, so the ranges
-- are a class of their own:
--
--   evidence.origin_segment   the ranges of one saved revision of a work, one
--                             snapshot per revision, recorded once by the
--                             student who owns the work: a block of the
--                             revision (its node id), a range of code points
--                             of the block's text (start inclusive, end
--                             exclusive, as textBlocksOf counts them), the kind
--                             from the same closed list as the composition, and
--                             optionally the segmentRef the client sent to
--                             work.assistant-match.post for that text (so a
--                             finding resolves to its ranges) and the id of the
--                             origin change the range came from (so a paste the
--                             student explained later reads as pasted_known, as
--                             in the composition). No text, no key, no time of
--                             typing, no measure. Ranges of one block do not
--                             overlap. Append-only.
--
-- A range says where text came from, never who typed it; nothing here concludes
-- anything about authorship. Only through the RPCs: the table belongs to the
-- evidence role with forced RLS and no privilege for any other role. Who writes
-- and who reads comes from the relation to the work through
-- app.origin_work_access (the owner writes; the owner and the readers of the
-- work read the same answer): C-23. ZD403 for every refusal, also an unknown
-- document; ZD401 no session; ZD422 invalid input (also a revision the owner
-- has not saved); ZD409 a revision whose ranges are already recorded.
--
--   app.work_origin_segments_record  the owner records the ranges of a revision
--   app.work_origin_segments         the ranges of the latest recorded revision
--                                    at or below the one asked (or the latest)
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.origin_segment (
  document_id text NOT NULL,
  institution_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  ord integer NOT NULL CHECK (ord BETWEEN 1 AND 10000),
  block_id text NOT NULL
    CHECK (block_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  start_at integer NOT NULL CHECK (start_at BETWEEN 0 AND 9999999),
  end_at integer NOT NULL CHECK (end_at BETWEEN 1 AND 10000000),
  kind text NOT NULL CHECK (kind IN
    ('typed', 'assistant_inserted', 'assistant_match', 'imported_file', 'pasted_known', 'pasted_unknown')),
  change_id uuid,
  segment_ref text CHECK (char_length(segment_ref) BETWEEN 1 AND 128 AND segment_ref !~ '[[:cntrl:]]'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- A paste is known only through the explanation of its change.
  CHECK (kind <> 'pasted_known' OR change_id IS NOT NULL),
  PRIMARY KEY (document_id, institution_id, revision, ord),
  FOREIGN KEY (document_id, institution_id, revision)
    REFERENCES evidence.document_revision (document_id, institution_id, revision)
);

CREATE FUNCTION evidence.origin_segment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'origin segment is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER origin_segment_guard BEFORE UPDATE OR DELETE ON evidence.origin_segment
  FOR EACH ROW EXECUTE FUNCTION evidence.origin_segment_guard();
CREATE TRIGGER origin_segment_no_truncate BEFORE TRUNCATE ON evidence.origin_segment
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.origin_segment_guard();
ALTER TABLE evidence.origin_segment ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.origin_segment FORCE ROW LEVEL SECURITY;
CREATE POLICY origin_segment_owner ON evidence.origin_segment TO ductus_evidence USING (true) WITH CHECK (true);

-- Evidence-owned workers, called only by the identity-owned RPCs below.
CREATE FUNCTION app.origin_segments_add(p_document_id text, p_revision bigint, p_assignment_id uuid,
                                        p_student_id uuid, p_segments jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_element jsonb;
  v_ord bigint;
  v_block text;
  v_start numeric;
  v_end numeric;
  v_kind text;
  v_ref text;
  v_change uuid;
  v_change_kind text;
BEGIN
  SELECT a.institution_id INTO v_institution FROM app.current_actor() a;
  IF v_institution IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_revision IS NULL OR p_segments IS NULL OR jsonb_typeof(p_segments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_segments) NOT BETWEEN 1 AND 10000
     OR NOT EXISTS (SELECT 1 FROM evidence.document_revision r
                     WHERE r.document_id = p_document_id AND r.institution_id = v_institution
                       AND r.revision = p_revision AND r.principal_id = p_student_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF EXISTS (SELECT 1 FROM evidence.origin_segment s
              WHERE s.document_id = p_document_id AND s.institution_id = v_institution AND s.revision = p_revision) THEN
    RAISE EXCEPTION 'already recorded' USING ERRCODE = 'ZD409';
  END IF;
  FOR v_element, v_ord IN SELECT e, o FROM jsonb_array_elements(p_segments) WITH ORDINALITY AS t (e, o) LOOP
    IF jsonb_typeof(v_element) IS DISTINCT FROM 'object'
       OR NOT v_element ?& ARRAY['blockId', 'start', 'end', 'kind']
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_element) k
                   WHERE k NOT IN ('blockId', 'start', 'end', 'kind', 'segmentRef', 'changeId'))
       OR jsonb_typeof(v_element -> 'blockId') <> 'string' OR jsonb_typeof(v_element -> 'start') <> 'number'
       OR jsonb_typeof(v_element -> 'end') <> 'number' OR jsonb_typeof(v_element -> 'kind') <> 'string'
       OR jsonb_typeof(coalesce(v_element -> 'segmentRef', '""')) <> 'string'
       OR jsonb_typeof(coalesce(v_element -> 'changeId', '""')) <> 'string' THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    v_block := v_element ->> 'blockId';
    v_start := (v_element ->> 'start')::numeric;
    v_end := (v_element ->> 'end')::numeric;
    v_kind := v_element ->> 'kind';
    v_ref := v_element ->> 'segmentRef';
    IF v_block !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR v_start <> trunc(v_start) OR v_end <> trunc(v_end)
       OR v_start NOT BETWEEN 0 AND 9999999 OR v_end NOT BETWEEN 1 AND 10000000 OR v_end <= v_start
       OR v_kind NOT IN ('typed', 'assistant_inserted', 'assistant_match', 'imported_file', 'pasted_known', 'pasted_unknown')
       OR (v_ref IS NOT NULL AND (char_length(v_ref) NOT BETWEEN 1 AND 128 OR v_ref ~ '[[:cntrl:]]'))
       OR (v_element ? 'changeId'
           AND (v_element ->> 'changeId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
    END IF;
    v_change := (v_element ->> 'changeId')::uuid;
    IF v_change IS NULL THEN
      -- As app.work_origin_record: a paste is known only through its explanation.
      IF v_kind = 'pasted_known' THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
    ELSE
      -- The change must be one of this work, of the same kind as the range says.
      SELECT c.kind INTO v_change_kind FROM evidence.origin_change c
       WHERE c.id = v_change AND c.institution_id = v_institution
         AND c.assignment_id = p_assignment_id AND c.student_id = p_student_id;
      IF v_change_kind IS DISTINCT FROM v_kind THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
    END IF;
    INSERT INTO evidence.origin_segment
      (document_id, institution_id, revision, ord, block_id, start_at, end_at, kind, change_id, segment_ref)
    VALUES (p_document_id, v_institution, p_revision, v_ord::integer, lower(v_block), v_start::integer,
            v_end::integer, v_kind, v_change, v_ref);
  END LOOP;
  -- Ranges of one block do not overlap.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT s.start_at, lag(s.end_at) OVER (PARTITION BY s.block_id ORDER BY s.start_at, s.ord) AS previous_end
        FROM evidence.origin_segment s
       WHERE s.document_id = p_document_id AND s.institution_id = v_institution AND s.revision = p_revision) x
     WHERE x.previous_end > x.start_at) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  RETURN jsonb_array_length(p_segments);
END
$$;

-- The ranges of the latest recorded revision at or below p_revision (any, when
-- null), in the order they were recorded; the kind of a range linked to a
-- change is the change's kind now (an explained paste reads pasted_known).
CREATE FUNCTION app.origin_segments_of(p_document_id text, p_revision bigint, p_assignment_id uuid,
                                       p_student_id uuid)
RETURNS TABLE (revision bigint, block_id text, start_at integer, end_at integer, kind text, segment_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH a AS (SELECT c.institution_id FROM app.current_actor() c WHERE c.institution_id IS NOT NULL),
  r AS (
    SELECT max(s.revision) AS revision
      FROM a JOIN evidence.origin_segment s ON s.institution_id = a.institution_id AND s.document_id = p_document_id
     WHERE p_revision IS NULL OR s.revision <= p_revision)
  SELECT s.revision, s.block_id, s.start_at, s.end_at, coalesce(c.kind, s.kind), s.segment_ref
    FROM a CROSS JOIN r
    JOIN evidence.origin_segment s
      ON s.institution_id = a.institution_id AND s.document_id = p_document_id AND s.revision = r.revision
    LEFT JOIN evidence.origin_change c
      ON c.id = s.change_id AND c.institution_id = s.institution_id
     AND c.assignment_id = p_assignment_id AND c.student_id = p_student_id
   ORDER BY s.ord
$$;

REVOKE ALL ON FUNCTION evidence.origin_segment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.origin_segments_add(text, bigint, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.origin_segments_of(text, bigint, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.origin_segments_add(text, bigint, uuid, uuid, jsonb) TO ductus_identity;
GRANT EXECUTE ON FUNCTION app.origin_segments_of(text, bigint, uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.work_origin_segments_record(p_document_id text, p_revision bigint, p_segments jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, true);
  RETURN app.origin_segments_add(p_document_id, p_revision, v_access.assignment_id, v_access.student_id, p_segments);
END
$$;

CREATE FUNCTION app.work_origin_segments(p_document_id text, p_revision bigint)
RETURNS TABLE (revision bigint, block_id text, start_at integer, end_at integer, kind text, segment_ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_access record;
BEGIN
  PERFORM institution.require_actor();
  IF p_revision IS NOT NULL AND p_revision NOT BETWEEN 0 AND 9007199254740991 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY SELECT * FROM app.origin_segments_of(p_document_id, p_revision, v_access.assignment_id,
                                                    v_access.student_id);
END
$$;

REVOKE ALL ON FUNCTION app.work_origin_segments_record(text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_origin_segments(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_origin_segments_record(text, bigint, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.work_origin_segments(text, bigint) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.work_origin_segments(text, bigint);
DROP FUNCTION app.work_origin_segments_record(text, bigint, jsonb);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.origin_segments_of(text, bigint, uuid, uuid);
DROP FUNCTION app.origin_segments_add(text, bigint, uuid, uuid, jsonb);
DROP TABLE evidence.origin_segment;
DROP FUNCTION evidence.origin_segment_guard();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
