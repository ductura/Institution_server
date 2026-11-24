// SRV-NF6-SIFRA (Ductus#2055; owner decision B2 of 24 Nov 2026,
// docs/contracts/self-note-sealed-v1.md): the database port of the sealed
// note to self and the wrapped note key (20261217150000). Each call is one
// withActor transaction over one RPC of schema collaboration; the RPCs decide
// who may: the student owner of the work for a note, the caller alone for the
// caller's own key (C-23). The bytes go in and come out as they are; nothing
// here can read them. The answer is a closed status, never a database message
// or SQLSTATE: ZD401 is unauthenticated, ZD403 not_found, ZD409 conflict,
// ZD422 invalid, anything else unavailable. A row of an unexpected shape is
// unavailable too.
import type { ActorTransaction, WithActor } from "../index.ts";

export type WorkPlace = { readonly nodeId: string; readonly offset: number };
/** The parts of a sealed note, in canonical base64url as the contract writes them. */
export type SealedNote = {
  readonly v: 1;
  readonly keyId: string;
  readonly iv: string;
  readonly ct: string;
};
export type SealedSelfNoteState = {
  readonly note: { readonly sealed: SealedNote; readonly updatedAt: string } | null;
  readonly readingPlace: { readonly place: WorkPlace; readonly updatedAt: string } | null;
};
export type WrappedKey = { readonly salt: string; readonly iv: string; readonly ct: string };
/** What the device sends to set or rewrap the note key. */
export type SelfNoteKeyWrite = {
  readonly v: 1;
  readonly keyId: string;
  readonly kdf: { readonly alg: "PBKDF2-SHA-256"; readonly iterations: number };
  readonly phrase: WrappedKey;
  readonly recovery: WrappedKey;
};
export type SelfNoteKey = SelfNoteKeyWrite & {
  readonly version: number;
  readonly updatedAt: string;
};

export type SealedRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "conflict" | "unavailable";
};
export type SealedAnswer<T> = ({ readonly status: "ok" } & T) | SealedRefusal;

export type SelfNoteSealed = {
  readNote(
    token: string,
    documentId: string,
  ): Promise<SealedAnswer<{ state: SealedSelfNoteState }>>;
  writeNote(
    token: string,
    documentId: string,
    sealed: SealedNote,
  ): Promise<SealedAnswer<{ state: SealedSelfNoteState }>>;
  clearNote(
    token: string,
    documentId: string,
  ): Promise<SealedAnswer<{ state: SealedSelfNoteState }>>;
  readKey(token: string): Promise<SealedAnswer<{ key: SelfNoteKey | null }>>;
  /** ifVersion null sets a key where none is kept; a version rewraps the same key. */
  writeKey(
    token: string,
    key: SelfNoteKeyWrite,
    ifVersion: number | null,
  ): Promise<SealedAnswer<{ key: SelfNoteKey }>>;
  deleteKey(token: string): Promise<SealedAnswer<{ key: null }>>;
};

/** Byte lengths, as the migration's checks and the contract's SEALED_LENGTHS. */
const IV = 12;
const NOTE_CT = 1296;
const SALT = 16;
const WRAPPED = 48;

const NOTE_COLUMNS =
  'note_key_id AS "keyId", note_iv AS "iv", note_ct AS "ct", note_updated_at AS "noteUpdatedAt", reading_place AS "readingPlace", reading_updated_at AS "readingUpdatedAt"';
const KEY_COLUMNS =
  'key_id AS "keyId", version, kdf_iterations AS "iterations", phrase_salt AS "phraseSalt", phrase_iv AS "phraseIv", phrase_ct AS "phraseCt", recovery_salt AS "recoverySalt", recovery_iv AS "recoveryIv", recovery_ct AS "recoveryCt", updated_at AS "updatedAt"';
const SQL = {
  readNote: `SELECT ${NOTE_COLUMNS} FROM collaboration.get_work_self_note($1)`,
  writeNote: `SELECT ${NOTE_COLUMNS} FROM collaboration.set_work_sealed_self_note($1, $2::uuid, $3::bytea, $4::bytea)`,
  clearNote: `SELECT ${NOTE_COLUMNS} FROM collaboration.clear_work_self_note($1, 'note')`,
  readKey: `SELECT ${KEY_COLUMNS} FROM collaboration.get_self_note_key()`,
  writeKey: `SELECT ${KEY_COLUMNS} FROM collaboration.put_self_note_key($1::uuid, $2::integer, $3::integer, $4::bytea, $5::bytea, $6::bytea, $7::bytea, $8::bytea, $9::bytea)`,
  deleteKey: 'SELECT collaboration.delete_self_note_key() AS "deleted"',
} as const;

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): SealedRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD409") return { status: "conflict" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

/**
 * The bytes of canonical base64url of exactly `length` bytes, or null: a
 * padded, non-canonical or wrong-length text is refused, never repaired.
 */
export function bytesOf(text: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length === length && bytes.toString("base64url") === text ? bytes : null;
}

function encoded(value: unknown, length: number): string {
  if (!Buffer.isBuffer(value) || value.length !== length) throw new Malformed();
  return value.toString("base64url");
}

function instant(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Malformed();
  return value.toISOString();
}

function uuid(value: unknown): string {
  if (typeof value !== "string") throw new Malformed();
  return value;
}

function place(value: unknown): WorkPlace {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Malformed();
  const { nodeId, offset } = value as Record<string, unknown>;
  if (typeof nodeId !== "string" || !Number.isInteger(offset) || Object.keys(value).length !== 2) {
    throw new Malformed();
  }
  return { nodeId, offset: offset as number };
}

/** No row is nothing kept; one row is what the owner keeps. */
function toState(rows: readonly Record<string, unknown>[]): SealedSelfNoteState {
  if (rows.length === 0) return { note: null, readingPlace: null };
  if (rows.length !== 1) throw new Malformed();
  const row = rows[0]!;
  return {
    note:
      row["ct"] === null
        ? null
        : {
            sealed: {
              v: 1,
              keyId: uuid(row["keyId"]),
              iv: encoded(row["iv"], IV),
              ct: encoded(row["ct"], NOTE_CT),
            },
            updatedAt: instant(row["noteUpdatedAt"]),
          },
    readingPlace:
      row["readingPlace"] === null
        ? null
        : { place: place(row["readingPlace"]), updatedAt: instant(row["readingUpdatedAt"]) },
  };
}

function toKey(row: Record<string, unknown>): SelfNoteKey {
  const version = row["version"];
  const iterations = row["iterations"];
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(iterations)) throw new Malformed();
  const wrap = (part: "phrase" | "recovery"): WrappedKey => ({
    salt: encoded(row[`${part}Salt`], SALT),
    iv: encoded(row[`${part}Iv`], IV),
    ct: encoded(row[`${part}Ct`], WRAPPED),
  });
  return {
    v: 1,
    keyId: uuid(row["keyId"]),
    kdf: { alg: "PBKDF2-SHA-256", iterations: iterations as number },
    phrase: wrap("phrase"),
    recovery: wrap("recovery"),
    version: version as number,
    updatedAt: instant(row["updatedAt"]),
  };
}

export function createSelfNoteSealed(withActor: WithActor): SelfNoteSealed {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | SealedRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;
  const state = (token: string, sql: string, params: unknown[]) =>
    run(token, async (tx) => ({
      status: "ok" as const,
      state: toState(await rowsOf(tx, sql, params)),
    }));

  return {
    readNote: (token, documentId) => state(token, SQL.readNote, [documentId]),
    writeNote: async (token, documentId, sealed) => {
      const iv = bytesOf(sealed.iv, IV);
      const ct = bytesOf(sealed.ct, NOTE_CT);
      if (iv === null || ct === null) return { status: "invalid" };
      return state(token, SQL.writeNote, [documentId, sealed.keyId, iv, ct]);
    },
    clearNote: (token, documentId) => state(token, SQL.clearNote, [documentId]),
    readKey: (token) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.readKey, []);
        if (rows.length > 1) throw new Malformed();
        return { status: "ok" as const, key: rows.length === 0 ? null : toKey(rows[0]!) };
      }),
    writeKey: async (token, key, ifVersion) => {
      const parts = [
        bytesOf(key.phrase.salt, SALT),
        bytesOf(key.phrase.iv, IV),
        bytesOf(key.phrase.ct, WRAPPED),
        bytesOf(key.recovery.salt, SALT),
        bytesOf(key.recovery.iv, IV),
        bytesOf(key.recovery.ct, WRAPPED),
      ];
      if (parts.some((part) => part === null)) return { status: "invalid" };
      return run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.writeKey, [
          key.keyId,
          ifVersion,
          key.kdf.iterations,
          ...parts,
        ]);
        if (rows.length !== 1) throw new Malformed();
        return { status: "ok" as const, key: toKey(rows[0]!) };
      });
    },
    deleteKey: (token) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.deleteKey, []);
        if (rows.length !== 1 || typeof rows[0]!["deleted"] !== "boolean") throw new Malformed();
        return { status: "ok" as const, key: null };
      }),
  };
}
