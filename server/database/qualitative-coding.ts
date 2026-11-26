// SRV-V18-KODIRANJE-BAZA (Ductus#2055; val 18): the adapter of qualitative
// coding. Every call is one withActor transaction with the app.* RPCs of
// migration 20261219390000 (qualitative_coding): the client never writes a table.
// The material, the codebook and the marked passages are the caller's own and
// nobody else's: who may do what is decided by the RPCs from the owner relation,
// never from a role alone, so another person's, an unknown and a malformed id all
// come back as ZD404. Nothing here calls an assistant or suggests a code. The
// routes come with SRV-V18-KODIRANJE-GRADIVO, -SIFRARNIK and -OZNAKE.
import {
  buildQualitativeExport,
  isAnchorOfText,
  isCodeDescription,
  isCodeName,
  isMaterialBody,
  isMaterialKind,
  isMaterialTitle,
  isMemo,
  normalizeBody,
  type Anchor,
  type CodebookEntry,
  type MaterialKind,
} from "../domain/index.ts";
import type { WithActor } from "./index.ts";

export type QualMaterialListItem = {
  id: string;
  title: string;
  kind: MaterialKind;
  createdOn: string;
  charCount: number;
  segmentCount: number;
  locked: boolean;
};
export type QualMaterial = {
  id: string;
  title: string;
  kind: MaterialKind;
  text: string;
  createdOn: string;
  segmentCount: number;
  locked: boolean;
};
export type QualCode = CodebookEntry & { segmentCount: number };
export type QualSegment = {
  id: string;
  codeId: string;
  paragraph: number;
  start: number;
  end: number;
  quote: string;
  memo: string | null;
  createdOn: string;
};

const CREATE_MATERIAL = "SELECT app.create_qual_material($1::text, $2::text, $3::text) AS id";
const LIST_MATERIALS = `SELECT id, title, kind, to_char(created_on, 'YYYY-MM-DD') AS "createdOn",
    char_count AS "charCount", segment_count AS "segmentCount", locked
  FROM app.qual_materials()`;
const READ_MATERIAL = `SELECT id, title, kind, body AS text, to_char(created_on, 'YYYY-MM-DD') AS "createdOn",
    segment_count AS "segmentCount", locked
  FROM app.qual_material($1::uuid)`;
const DELETE_MATERIAL = "SELECT app.delete_qual_material($1::uuid)";
const CREATE_CODE = "SELECT app.create_qual_code($1::text, $2::text) AS id";
const LIST_CODES = `SELECT id, name, description, ord AS "order", segment_count AS "segmentCount"
  FROM app.qual_codes() ORDER BY ord`;
const UPDATE_CODE = "SELECT app.update_qual_code($1::uuid, $2::text, $3::text)";
const MOVE_CODE = "SELECT app.move_qual_code($1::uuid, $2::integer)";
const DELETE_CODE = "SELECT app.delete_qual_code($1::uuid, $2::boolean) AS removed";
const CREATE_SEGMENT = `SELECT app.create_qual_segment($1::uuid, $2::uuid, $3::integer, $4::integer, $5::integer,
    $6::text, $7::text) AS id`;
const LIST_SEGMENTS = `SELECT id, code_id AS "codeId", paragraph, start_offset AS start, end_offset AS "end",
    quote, memo, to_char(created_on, 'YYYY-MM-DD') AS "createdOn"
  FROM app.qual_segments($1::uuid)`;
const DELETE_SEGMENT = "SELECT app.delete_qual_segment($1::uuid)";
const EXPORT_ALL = `SELECT 'code' AS kind,
    jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'order', c.ord,
                       'segmentCount', c.segment_count) AS item
  FROM app.qual_codes() c
  UNION ALL
  SELECT 'segment', jsonb_build_object('materialId', s.material_id, 'materialRank', s.material_rank,
    'codeId', s.code_id, 'paragraph', s.paragraph, 'start', s.start_offset, 'end', s.end_offset,
    'quote', s.quote, 'memo', s.memo)
  FROM app.qual_export_segments($1::uuid) s`;
type ExportSegment = {
  materialId: string;
  materialRank: number;
  codeId: string;
  paragraph: number;
  start: number;
  end: number;
  quote: string;
  memo: string | null;
};
type ExportItem = QualCode | ExportSegment;

/** The refusal the RPCs give for an input they would not accept, so a route answers 422 before a round trip. */
function invalidInput(): never {
  throw Object.assign(new Error("invalid input"), { code: "ZD422" });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A malformed id is the same refusal as an unknown one (C-23), not a cast error from the database. */
function idOf(value: string): string {
  if (typeof value === "string" && UUID.test(value)) return value;
  throw Object.assign(new Error("not found"), { code: "ZD404" });
}

const isPosition = (value: unknown): value is number => Number.isInteger(value);

export function createQualitativeCodingStore(withActor: WithActor) {
  const one = async <Row extends Record<string, unknown>>(
    token: string,
    sql: string,
    values: readonly unknown[],
    what: string,
  ): Promise<Row> =>
    withActor(token, async (tx) => {
      const { rows } = await tx.query<Row>(sql, values);
      if (rows.length !== 1 || !rows[0]) throw new Error(`expected one ${what}`);
      return rows[0];
    });

  return {
    /** Keeps a text; the line breaks of a paste are turned into \n. Returns the id. */
    createMaterial: async (token: string, title: string, kind: string, text: string) => {
      const body = normalizeBody(text);
      if (!isMaterialTitle(title) || !isMaterialKind(kind) || !isMaterialBody(body)) {
        return invalidInput();
      }
      return (await one<{ id: string }>(token, CREATE_MATERIAL, [title, kind, body], "material id"))
        .id;
    },
    listMaterials: (token: string) =>
      withActor(
        token,
        async (tx) => (await tx.query<QualMaterialListItem>(LIST_MATERIALS, [])).rows,
      ),
    /** ZD404 for a material that is not yours, unknown or malformed. */
    readMaterial: (token: string, id: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<QualMaterial>(READ_MATERIAL, [idOf(id)]);
        if (rows.length !== 1 || !rows[0]) throw new Error("expected one material");
        return rows[0];
      }),
    /** Deletes a material with its passages. */
    deleteMaterial: (token: string, id: string) =>
      withActor(token, async (tx) => {
        await tx.query(DELETE_MATERIAL, [idOf(id)]);
      }),
    /** Adds a code to the end of the codebook (ZD409 for a name it already has, the case aside). */
    createCode: async (token: string, name: string, description = "") => {
      if (!isCodeName(name) || !isCodeDescription(description)) return invalidInput();
      return (await one<{ id: string }>(token, CREATE_CODE, [name, description], "code id")).id;
    },
    /** The codebook in its own order, never by use. */
    listCodes: (token: string) =>
      withActor(token, async (tx) => (await tx.query<QualCode>(LIST_CODES, [])).rows),
    updateCode: async (token: string, id: string, name: string, description = "") => {
      if (!isCodeName(name) || !isCodeDescription(description)) return invalidInput();
      return withActor(token, async (tx) => {
        await tx.query(UPDATE_CODE, [idOf(id), name, description]);
      });
    },
    /** Moves a code to a place (1 = first); the others keep their order. */
    moveCode: async (token: string, id: string, position: number) => {
      if (!isPosition(position) || position < 1) return invalidInput();
      return withActor(token, async (tx) => {
        await tx.query(MOVE_CODE, [idOf(id), position]);
      });
    },
    /**
     * Deletes a code. With marked passages it is refused (ZD409 confirm_required)
     * unless `confirm` is true, and then they go with it. Returns how many went.
     */
    deleteCode: async (token: string, id: string, confirm: boolean) =>
      (await one<{ removed: number }>(token, DELETE_CODE, [idOf(id), confirm === true], "count"))
        .removed,
    /** Marks a passage; the quote must be exactly the text it points at (ZD422 otherwise). */
    createSegment: async (
      token: string,
      materialId: string,
      codeId: string,
      anchor: Anchor,
      memo: string | null = null,
    ) => {
      const { paragraph, start, end, quote } = anchor;
      // The text itself is the database's to check; here only what the quote and
      // the offsets say of themselves (the quote is as long as start..end, not blank).
      if (
        !isAnchorOfText(quote, { paragraph: 0, start: 0, end: end - start, quote }) ||
        !Number.isInteger(paragraph) ||
        paragraph < 0 ||
        !Number.isInteger(start) ||
        start < 0 ||
        (memo !== null && !isMemo(memo))
      ) {
        return invalidInput();
      }
      return (
        await one<{ id: string }>(
          token,
          CREATE_SEGMENT,
          [idOf(materialId), idOf(codeId), paragraph, start, end, quote, memo],
          "segment id",
        )
      ).id;
    },
    /** The passages of a material, in the order of the text. */
    listSegments: (token: string, materialId: string) =>
      withActor(
        token,
        async (tx) => (await tx.query<QualSegment>(LIST_SEGMENTS, [idOf(materialId)])).rows,
      ),
    deleteSegment: (token: string, id: string) =>
      withActor(token, async (tx) => {
        await tx.query(DELETE_SEGMENT, [idOf(id)]);
      }),
    /**
     * qualitative-export-v1 of one material or of all, read in one transaction
     * (the codebook and the passages) so they agree.
     */
    exportOf: (token: string, materialId?: string) =>
      withActor(token, async (tx) => {
        // One statement, so one snapshot: a code made, renamed or deleted in
        // another tab cannot leave a passage without its code (the transaction is
        // READ COMMITTED, so two statements would not agree).
        const { rows } = await tx.query<{ kind: "code" | "segment"; item: ExportItem }>(
          EXPORT_ALL,
          [materialId === undefined ? null : idOf(materialId)],
        );
        const codebook = rows.flatMap((row) => (row.kind === "code" ? [row.item as QualCode] : []));
        const segments = rows.flatMap((row) =>
          row.kind === "segment" ? [row.item as ExportSegment] : [],
        );
        return buildQualitativeExport(codebook, segments);
      }),
  };
}
