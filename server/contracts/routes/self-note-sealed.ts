import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkPlace } from "./mentorship-follow.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-NF6-SIFRA (Ductus#2055; owner decision of 24 Nov 2026 on c.7119843989,
// "1. B2 2. Da 3B"; docs/contracts/self-note-sealed-v1.md): the note to self
// sealed on the student's device. The server keeps and answers bytes it
// cannot read: a ciphertext of fixed length under a random note key, and that
// key wrapped twice, by a phrase and by a recovery code the application
// generates. The text and the place of the note are inside the ciphertext;
// the reading place ("Dokle sam stao") is not sealed and keeps its own routes
// (work.reading-place.*). These routes come next to work.self-note.* (variant
// (b)); the routes in the clear no longer keep any text.
//
// Identity and institution are never in a request: the RPCs of
// 20261217150000 take them from the session (server/database/self-note-sealed).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Uuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
/** The instant as Date.toISOString writes it, in UTC. */
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});

/** Byte lengths of the sealed parts (self-note-sealed-v1.md §2, §4). */
export const SEALED_LENGTHS = {
  iv: 12,
  /** 1280 bytes of JCS({text, place}) padded with zeros, and 16 bytes of the GCM tag. */
  noteCiphertext: 1296,
  salt: 16,
  /** The 32-byte note key and 16 bytes of the GCM tag. */
  wrappedKey: 48,
} as const;
export const KDF_ITERATIONS = { min: 600_000, max: 10_000_000 } as const;

/**
 * Exactly `bytes` bytes in canonical base64url without padding: the last
 * character carries no stray bits, so one byte string has one spelling.
 */
function base64url(bytes: number) {
  const full = Math.floor(bytes / 3) * 4;
  const tail =
    bytes % 3 === 0
      ? ""
      : bytes % 3 === 1
        ? "[A-Za-z0-9_-][AQgw]"
        : "[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]";
  return Type.String({ pattern: `^[A-Za-z0-9_-]{${full}}${tail}${END}` });
}

/** A note sealed on the device: AES-256-GCM under the note key keyId. */
export const SealedNote = closed({
  v: Type.Literal(1),
  keyId: Uuid,
  iv: base64url(SEALED_LENGTHS.iv),
  ct: base64url(SEALED_LENGTHS.noteCiphertext),
});

/** What the owner keeps on a work: the sealed note and the reading place, either absent. */
export const SealedSelfNoteState = closed({
  note: Type.Union([closed({ sealed: SealedNote, updatedAt: Instant }), Type.Null()]),
  readingPlace: Type.Union([closed({ place: WorkPlace, updatedAt: Instant }), Type.Null()]),
});
export const SealedSelfNoteInput = closed({ sealed: SealedNote });

/** The note key wrapped (AES-256-GCM) by a key derived from one secret with its own salt. */
const WrappedKey = closed({
  salt: base64url(SEALED_LENGTHS.salt),
  iv: base64url(SEALED_LENGTHS.iv),
  ct: base64url(SEALED_LENGTHS.wrappedKey),
});
const keyParts = {
  v: Type.Literal(1),
  keyId: Uuid,
  kdf: closed({
    alg: Type.Literal("PBKDF2-SHA-256"),
    iterations: Type.Integer({ minimum: KDF_ITERATIONS.min, maximum: KDF_ITERATIONS.max }),
  }),
  /** Wrapped by the key derived from the phrase the application generated. */
  phrase: WrappedKey,
  /** Wrapped by the key derived from the recovery code the application generated. */
  recovery: WrappedKey,
};
/** One level of nesting, as a request body allows (scripts/generate-contracts.ts). */
export const SelfNoteKeyInput = closed({
  ...keyParts,
  /** null: set the key, only when there is none; the current version: rewrap the same key. */
  ifVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export const SelfNoteKeyState = closed({
  key: Type.Union([
    closed({ ...keyParts, version: Type.Integer({ minimum: 1 }), updatedAt: Instant }),
    Type.Null(),
  ]),
});

const params = closed({ documentId: WorkId });
const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(404, "not_found"),
  error(409, "conflict"),
  error(503, "unavailable"),
];
const deleteErrors = [...MUTATION_GUARD, ...readErrors];
const OWNER_ONLY =
  "Only the student who owns the work; to anyone else, the mentor and the teachers of the work included, and for an unknown or malformed work it is 404.";
const NEVER_CLEAR =
  "The server never sees the text, the place of the note, the phrase, the recovery code or the note key.";

export const workSealedSelfNoteGet = defineRoute({
  id: "work.sealed-self-note.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/sealed-self-note",
  inventory: "app/api/works/[documentId]/sealed-self-note/route.ts",
  access: "student_owner",
  summary: `The student's sealed note to self (MK-9) as it was written, byte for byte, and the reading place, null where none is kept. ${NEVER_CLEAR} ${OWNER_ONLY}`,
  request: { params },
  responses: [{ status: 200, description: "what the owner keeps", body: SealedSelfNoteState }],
  errors: readErrors,
});

export const workSealedSelfNotePut = defineRoute({
  id: "work.sealed-self-note.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/sealed-self-note",
  inventory: "app/api/works/[documentId]/sealed-self-note/route.ts",
  access: "student_owner",
  summary: `Writes the sealed note, replacing the earlier one: {sealed: {v: 1, keyId, iv, ct}}, iv 12 and ct 1296 bytes in base64url. keyId must be the note key the owner keeps now (profile.self-note-key.get), else 409 and nothing is written. The server checks only the shape and the lengths; the rules of the text (1 to 280 characters) are the device's. ${NEVER_CLEAR} ${OWNER_ONLY}`,
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: SealedSelfNoteInput,
  },
  responses: [{ status: 200, description: "what the owner keeps", body: SealedSelfNoteState }],
  errors: writeErrors,
});

export const workSealedSelfNoteDelete = defineRoute({
  id: "work.sealed-self-note.delete",
  method: "DELETE",
  path: "/api/v1/works/{documentId}/sealed-self-note",
  inventory: "app/api/works/[documentId]/sealed-self-note/route.ts",
  access: "student_owner",
  summary: `Deletes the sealed note; the reading place stays. Deleting what is not there changes nothing. Answers what the owner keeps. ${OWNER_ONLY}`,
  request: { params, maxBodyBytes: 0 },
  responses: [{ status: 200, description: "what the owner keeps", body: SealedSelfNoteState }],
  errors: deleteErrors,
});

export const profileSelfNoteKeyGet = defineRoute({
  id: "profile.self-note-key.get",
  method: "GET",
  path: "/api/v1/me/self-note-key",
  inventory: "app/api/me/self-note-key/route.ts",
  access: "signed_in",
  summary: `The caller's own note key, wrapped by the phrase and by the recovery code (B2), with its version; null until it is set. Nobody reads another person's key. ${NEVER_CLEAR}`,
  request: {},
  responses: [{ status: 200, description: "the caller's wrapped key", body: SelfNoteKeyState }],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const profileSelfNoteKeyPut = defineRoute({
  id: "profile.self-note-key.put",
  method: "PUT",
  path: "/api/v1/me/self-note-key",
  inventory: "app/api/me/self-note-key/route.ts",
  access: "signed_in",
  summary: `Sets the caller's note key ({v: 1, keyId, kdf, phrase, recovery, ifVersion: null}, only when none is kept) or rewraps the same key under a new phrase or recovery code (ifVersion the current version, the same keyId); the version then rises by one. Any other case (a key already there, none there, another keyId, another version) is 409 and changes nothing, so two devices never overwrite each other. kdf PBKDF2-SHA-256 with 600000 to 10000000 iterations; each wrap has its own 16-byte salt, a 12-byte iv and 48 bytes of wrapped key, in base64url. ${NEVER_CLEAR}`,
  request: {
    contentType: "application/json",
    maxBodyBytes: 2 * 1024,
    body: SelfNoteKeyInput,
  },
  responses: [{ status: 200, description: "the caller's wrapped key", body: SelfNoteKeyState }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const profileSelfNoteKeyDelete = defineRoute({
  id: "profile.self-note-key.delete",
  method: "DELETE",
  path: "/api/v1/me/self-note-key",
  inventory: "app/api/me/self-note-key/route.ts",
  access: "signed_in",
  summary:
    "Starting over after the phrase and the recovery code are both lost: deletes the caller's note key and, in the same transaction, every sealed note of the caller on every work; the reading places stay. Nobody, the institution included, can restore them. Deleting no key changes nothing. Answers {key: null}.",
  request: { maxBodyBytes: 0 },
  responses: [{ status: 200, description: "no key is kept", body: SelfNoteKeyState }],
  errors: [...MUTATION_GUARD, error(401, "unauthorized"), error(503, "unavailable")],
});

/** A version in a query string: 1 to 999999999 in decimal, no sign, no leading zero. */
const VersionText = Type.String({ pattern: `^[1-9][0-9]{0,8}${END}` });

/** The key id and the version the checked delete names (profileSelfNoteKeyCheckedDelete). */
export const SelfNoteKeyCheckedParams = closed({ keyId: Uuid });
export const SelfNoteKeyCheckedQuery = closed({ ifVersion: Type.Optional(VersionText) });

// SRV-NF6-SIFRA-2 (review of SRV #676, S2): starting over under the key the
// device holds. profile.self-note-key.delete names nothing, and its contract
// cannot take a parameter or a 409 without breaking clients of 1.110.0
// (contracts:breaking), so the check is this route of its own.
export const profileSelfNoteKeyCheckedDelete = defineRoute({
  id: "profile.self-note-key-checked.delete",
  method: "DELETE",
  path: "/api/v1/me/self-note-key/{keyId}",
  inventory: "app/api/me/self-note-key/[keyId]/route.ts",
  access: "signed_in",
  summary:
    "Starting over as profile.self-note-key.delete, but only under the key the device names: deletes the caller's note key and, in the same transaction, every sealed note of the caller, only when keyId is the key the caller keeps now and, when the query names ifVersion, only at that version. No key, another keyId or another version is 409 and changes nothing, so a device that read the key before another device rewrapped it or started over deletes nothing it has not seen. A keyId that is not a lowercase UUID, an ifVersion that is not a decimal 1 to 999999999 or any other query parameter is 422. Answers {key: null}.",
  request: {
    params: SelfNoteKeyCheckedParams,
    query: SelfNoteKeyCheckedQuery,
    maxBodyBytes: 0,
  },
  responses: [{ status: 200, description: "no key is kept", body: SelfNoteKeyState }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const sealedSelfNoteRoutes = [
  workSealedSelfNoteGet,
  workSealedSelfNotePut,
  workSealedSelfNoteDelete,
] as const;
export const selfNoteKeyRoutes = [
  profileSelfNoteKeyGet,
  profileSelfNoteKeyPut,
  profileSelfNoteKeyDelete,
  profileSelfNoteKeyCheckedDelete,
] as const;
export const selfNoteSealedRoutes = [...sealedSelfNoteRoutes, ...selfNoteKeyRoutes] as const;
