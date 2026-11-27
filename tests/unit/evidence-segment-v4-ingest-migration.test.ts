import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// SRV-1809: the v4 ingest migration adds a 10-argument overload of the
// acceptance whose body is the live 9-argument body but for the hunks below.
// The copy is checked here instead of by eye.
const DIRECTORY = new URL("../../db/main/migrations/", import.meta.url);
const V3_NAME = "20261028000000_evidence_segment_v3.sql";
const V4_NAME = "20261220490000_evidence_segment_v4_ingest.sql";

function migration(name: string): string {
  return readFileSync(new URL(name, DIRECTORY), "utf8");
}
function upOf(text: string): string {
  const down = text.indexOf("-- migrate:down");
  return down < 0 ? text : text.slice(0, down);
}
function downOf(text: string): string {
  const down = text.indexOf("-- migrate:down");
  expect(down).toBeGreaterThanOrEqual(0);
  return text.slice(down);
}

const ACCEPTANCE = "FUNCTION app.commit_evidence_segment(";

/** The one definition of `name` in `text`, from CREATE to the closing `$$;`. */
function definitionOf(text: string, name: string): string {
  const starts = [`CREATE ${name}`, `CREATE OR REPLACE ${name}`].flatMap((header) => {
    const found: number[] = [];
    for (let at = text.indexOf(header); at >= 0; at = text.indexOf(header, at + 1)) found.push(at);
    return found;
  });
  expect(starts).toHaveLength(1);
  const end = text.indexOf("\n$$;", starts[0]);
  expect(end).toBeGreaterThan(starts[0]!);
  return text.slice(starts[0], end + "\n$$;".length);
}

/** Replaces `from` by `to`, which must occur exactly once. */
function swap(text: string, from: string, to: string): string {
  expect(text.split(from).length - 1).toBe(1);
  return text.replace(from, () => to);
}

const LINKS_BLOCK = `
  -- v4 (SRV-1809): the AI transfer links the segment's events name. v4 needs
  -- the array, empty when there are none; v2 and v3 carry none. At most
  -- 5000, assistant.ai_transfer_max(), the transfers one document can have.
  IF p_descriptor->>'evidenceSchema' = 'ductus-evidence-segment-v4' THEN
    IF p_ai_transfer_links IS NULL THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
  ELSIF p_ai_transfer_links IS NOT NULL AND p_ai_transfer_links <> '[]'::jsonb THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  IF p_ai_transfer_links IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_ai_transfer_links) <> 'array' THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    IF pg_catalog.jsonb_array_length(p_ai_transfer_links) > 5000
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_ai_transfer_links) AS l(link)
          WHERE CASE WHEN pg_catalog.jsonb_typeof(l.link) <> 'object' THEN true
                ELSE (SELECT count(*) FROM pg_catalog.jsonb_object_keys(l.link)) <> 2
                  OR pg_catalog.jsonb_typeof(l.link->'aiTransferId') IS DISTINCT FROM 'string'
                  OR pg_catalog.jsonb_typeof(l.link->'aiTransferSha256') IS DISTINCT FROM 'string'
                  OR l.link->>'aiTransferId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                  OR l.link->>'aiTransferSha256' !~ '^[0-9a-f]{64}$' END
       ) THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    -- Normalized and ordered, so a retry compares them by value; NULL if none.
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'aiTransferId', l.link->>'aiTransferId', 'aiTransferSha256', l.link->>'aiTransferSha256')
           ORDER BY l.link->>'aiTransferId')
      INTO v_links FROM pg_catalog.jsonb_array_elements(p_ai_transfer_links) AS l(link);
    IF (SELECT count(DISTINCT l.link->>'aiTransferId') FROM pg_catalog.jsonb_array_elements(p_ai_transfer_links) AS l(link))
       <> pg_catalog.jsonb_array_length(p_ai_transfer_links) THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT * INTO v_descriptor
`;

const VALIDATOR_CALL = `    -- A v4 descriptor has v3's shape; only the schema name differs.
    FROM evidence.validate_segment_descriptor_v2(
           CASE WHEN p_descriptor->>'evidenceSchema' = 'ductus-evidence-segment-v4'
                THEN pg_catalog.jsonb_set(p_descriptor, '{evidenceSchema}', '"ductus-evidence-segment-v3"')
                ELSE p_descriptor END,
           p_payload_sha256);`;

const RETRY_LINKS = `      outcome := 'idempotency_conflict';
    ELSIF (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'aiTransferId', t.ai_transfer_id::text, 'aiTransferSha256', t.ai_transfer_sha256)
                  ORDER BY t.ai_transfer_id::text)
             FROM evidence.segment_ai_transfer t
            WHERE t.segment_id = v_existing.segment_id AND t.evidence_package_id = v_existing.evidence_package_id
              AND t.institution_id = v_existing.institution_id) IS DISTINCT FROM v_links THEN
      outcome := 'idempotency_conflict';
    ELSIF v_existing.payload_sha256`;

const SEGMENT_EXISTS = `       AND s.id = p_descriptor->>'segmentId'
  ) THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
`;
const LINK_CHECK = `${SEGMENT_EXISTS}  -- Each link names this student's record for this document with its hash,
  -- and a record not yet bound to a segment; one answer otherwise (C7).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(v_links, '[]'::jsonb)) AS l(link)
     WHERE assistant.ai_transfer_link_sha256((l.link->>'aiTransferId')::uuid, v_package.institution_id,
             v_actor.user_id, v_document.id) IS DISTINCT FROM l.link->>'aiTransferSha256'
        OR EXISTS (SELECT 1 FROM evidence.segment_ai_transfer t
                    WHERE t.ai_transfer_id = (l.link->>'aiTransferId')::uuid)
  ) THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
`;

const SEGMENT_INSERT_END = `    v_event_count, p_descriptor, p_payload_sha256, v_payload_bytes, p_storage_ref, v_now
  );
`;
const LINK_INSERT = `${SEGMENT_INSERT_END}  INSERT INTO evidence.segment_ai_transfer (
    segment_id, evidence_package_id, institution_id, principal_id, ai_transfer_id, ai_transfer_sha256
  )
  SELECT p_descriptor->>'segmentId', v_package.id, v_package.institution_id, v_actor.user_id,
         (l.link->>'aiTransferId')::uuid, l.link->>'aiTransferSha256'
    FROM pg_catalog.jsonb_array_elements(COALESCE(v_links, '[]'::jsonb)) AS l(link);
`;

describe("evidence segment v4 ingest migration", () => {
  it("copies the live 9-argument acceptance, the one v3 left", () => {
    const between = readdirSync(DIRECTORY)
      .filter((name) => name.endsWith(".sql") && name > V3_NAME && name < V4_NAME)
      .sort();
    for (const file of between) {
      expect(upOf(migration(file)), file).not.toContain(ACCEPTANCE);
    }
  });

  it("differs from the live acceptance only in the listed hunks", () => {
    let expected = definitionOf(upOf(migration(V3_NAME)), ACCEPTANCE);
    expected = swap(expected, `CREATE OR REPLACE ${ACCEPTANCE}`, `CREATE ${ACCEPTANCE}`);
    expected = swap(
      expected,
      "  p_snapshot text\n) RETURNS TABLE (",
      "  p_snapshot text,\n  p_ai_transfer_links jsonb\n) RETURNS TABLE (",
    );
    expected = swap(
      expected,
      "  v_payload_bytes integer;\nBEGIN",
      "  v_payload_bytes integer;\n  v_links jsonb;\nBEGIN",
    );
    expected = swap(expected, "\n  SELECT * INTO v_descriptor\n", `\n${LINKS_BLOCK.slice(1)}`);
    expected = swap(
      expected,
      "    FROM evidence.validate_segment_descriptor_v2(p_descriptor, p_payload_sha256);",
      VALIDATOR_CALL,
    );
    expected = swap(
      expected,
      "      outcome := 'idempotency_conflict';\n    ELSIF v_existing.payload_sha256",
      RETRY_LINKS,
    );
    expected = swap(expected, SEGMENT_EXISTS, LINK_CHECK);
    expected = swap(expected, SEGMENT_INSERT_END, LINK_INSERT);
    expect(definitionOf(upOf(migration(V4_NAME)), ACCEPTANCE)).toBe(expected);
  });

  it("leaves the 9-argument acceptance and the validator alone", () => {
    const v4 = migration(V4_NAME);
    expect(v4).not.toContain("CREATE OR REPLACE");
    expect(v4).not.toContain("validate_segment_descriptor_v2(p_descriptor");
    expect(v4).not.toMatch(/\bALTER FUNCTION\b|OWNER TO|SECURITY INVOKER/);
    expect(upOf(v4).match(/^CREATE FUNCTION /gm)).toHaveLength(2);
    expect(downOf(v4)).toContain(
      "DROP FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb);",
    );
    expect(downOf(v4)).not.toMatch(/^CREATE /m);
  });
});
