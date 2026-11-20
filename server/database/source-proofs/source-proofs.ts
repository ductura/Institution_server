// The port of the proofs of a source (SRV-1102; migration 20261121100000):
// the excerpts a student attaches to a source of the own work, a JPEG of a
// page with an optional note. Every read and write goes through an RPC, never
// the table, and the student and institution come only from the session.
//
// The input is checked here as the RPC checks it (page, note, a JPEG of at
// most 1 MiB), so a whole PDF or any other file is refused before the
// database. Refusals are outcomes, never thrown: ZD401 unauthorized, ZD403
// not_found (one answer for every refusal, C-23), ZD422 invalid_input.
// Anything else is thrown.
import type { WithActor } from "../index.ts";

export type SourceProof = {
  readonly id: string;
  readonly page: string;
  readonly note: string | null;
};

export type SourceProofInput = {
  readonly assignmentId: string;
  readonly sourceId: string;
  readonly page: string;
  readonly note: string | null;
  readonly image: Uint8Array;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type SourceProofList = { readonly status: "read"; readonly proofs: SourceProof[] } | Refusal;
export type SourceProofAdd =
  | { readonly status: "added"; readonly proof: SourceProof }
  | Refusal
  | { readonly status: "invalid_input" };
export type SourceProofImage = { readonly status: "read"; readonly image: Buffer } | Refusal;

/** The largest excerpt the table keeps (institution.source_proof.image). */
export const SOURCE_PROOF_MAX_BYTES = 1_048_576;
export const SOURCE_PROOF_PAGE_MAX = 30;
export const SOURCE_PROOF_NOTE_MAX = 2000;

const FIELDS = "id, page, note";
const LIST_SQL = `SELECT ${FIELDS} FROM institution.source_proofs($1::uuid, $2::uuid, NULL)`;
const ADD_SQL = `SELECT ${FIELDS}
  FROM institution.add_source_proof($1::uuid, $2::uuid, $3::text, $4::text, $5::bytea)`;
const IMAGE_SQL =
  "SELECT image, sha256 FROM institution.read_source_proof_image($1::uuid, $2::uuid, $3::uuid, NULL)";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SPACE_AT_END = /^\s|\s$/u;

/** A control character (C0, DEL or C1), as [[:cntrl:]] in the database. */
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);

/** A page or a note as institution.source_proof_text_valid accepts it. */
export function isSourceProofText(value: unknown, max: number, lines: boolean): value is string {
  if (typeof value !== "string") return false;
  // Code points, as char_length counts them; a note may hold line breaks, a page may not.
  const chars = [...value];
  if (chars.length < 1 || chars.length > max || SPACE_AT_END.test(value)) return false;
  return !chars.some((char) => isControl(char) && !(lines && char === "\n"));
}

/**
 * A JPEG excerpt: starts with the JPEG marker (FF D8 FF), ends with the end of
 * image marker (FF D9) and fits the table. A PDF, a PNG or anything else is not one.
 */
export function isSourceProofJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return (
    n >= 4 &&
    n <= SOURCE_PROOF_MAX_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[n - 2] === 0xff &&
    bytes[n - 1] === 0xd9
  );
}

type ProofRow = { id: unknown; page: unknown; note: unknown };

function proofOf(row: ProofRow): SourceProof {
  if (
    !isId(row.id) ||
    !isSourceProofText(row.page, SOURCE_PROOF_PAGE_MAX, false) ||
    (row.note !== null && !isSourceProofText(row.note, SOURCE_PROOF_NOTE_MAX, true))
  ) {
    throw new Error("invalid source proof row");
  }
  return { id: row.id, page: row.page, note: row.note };
}

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(code: unknown): Refusal | undefined {
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

function rethrowUnlessRefusal(error: unknown): Refusal {
  const refusal = refusalOf(codeOf(error));
  if (refusal === undefined) throw error;
  return refusal;
}

export function createSourceProofs(withActor: WithActor) {
  return {
    /** The proofs of one source of the caller's own work, oldest first. */
    async list(token: string, assignmentId: string, sourceId: string): Promise<SourceProofList> {
      if (!isId(assignmentId) || !isId(sourceId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<ProofRow>(LIST_SQL, [assignmentId, sourceId]);
          return { status: "read", proofs: rows.map(proofOf) };
        });
      } catch (error) {
        return rethrowUnlessRefusal(error);
      }
    },
    /** The student of the work attaches a proof to a source of the own work. */
    async add(token: string, input: SourceProofInput): Promise<SourceProofAdd> {
      const { assignmentId, sourceId, page, note, image } = input;
      if (!isId(assignmentId) || !isId(sourceId)) return { status: "not_found" };
      if (
        !isSourceProofText(page, SOURCE_PROOF_PAGE_MAX, false) ||
        (note !== null && !isSourceProofText(note, SOURCE_PROOF_NOTE_MAX, true)) ||
        !isSourceProofJpeg(image)
      ) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<ProofRow>(ADD_SQL, [
            assignmentId,
            sourceId,
            page,
            note,
            Buffer.from(image.buffer, image.byteOffset, image.byteLength),
          ]);
          const row = rows[0];
          // Confirmed inside the transaction, so a result that is not the
          // saved proof rolls the write back.
          if (rows.length !== 1 || row === undefined || row.page !== page || row.note !== note)
            throw new Error("unconfirmed source proof");
          return { status: "added", proof: proofOf(row) };
        });
      } catch (error) {
        if (codeOf(error) === "ZD422") return { status: "invalid_input" };
        return rethrowUnlessRefusal(error);
      }
    },
    /** The JPEG bytes of one proof of a source of the caller's own work. */
    async image(
      token: string,
      assignmentId: string,
      sourceId: string,
      proofId: string,
    ): Promise<SourceProofImage> {
      if (!isId(assignmentId) || !isId(sourceId) || !isId(proofId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<{ image: unknown; sha256: unknown }>(IMAGE_SQL, [
            assignmentId,
            sourceId,
            proofId,
          ]);
          const image = rows[0]?.image;
          if (rows.length !== 1 || !Buffer.isBuffer(image) || !isSourceProofJpeg(image))
            throw new Error("invalid source proof image");
          return { status: "read", image };
        });
      } catch (error) {
        return rethrowUnlessRefusal(error);
      }
    },
  };
}

export type SourceProofs = ReturnType<typeof createSourceProofs>;
