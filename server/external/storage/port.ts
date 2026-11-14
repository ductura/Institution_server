// The storage port: what the server asks of evidence payload storage. Ported
// from Ductus src/application/ports at d52a92c3 (S-0.19, DAN-732), only the
// storage part: the payload store and locator of evidence-trust.ts, the
// readers and `bindPayloadReader` of evidence-reconstruction.ts and the
// presence check of pending-receipt-object.ts. `interface` became `type`
// (docs/CODE_STYLE.md, rule 4); the contracts are unchanged.

export type EvidencePayloadPutResult =
  | { status: "stored"; storageRef: string }
  | { status: "existing"; storageRef: string }
  | { status: "conflict" }
  | { status: "invalid" }
  | { status: "unavailable"; reason: string };

export type EvidencePayloadStore = {
  /**
   * Stores exact canonical bytes immutably under
   * `evidenceObjectKey` (institution, package, hash). Repeating the same key
   * with identical bytes is idempotent; different bytes at that key conflict.
   * `existing` is answered only inside the storage domain of that
   * institution. A store that checks the key or the bytes itself answers
   * `invalid` for an id, hash or payload the gateway should already have
   * refused.
   */
  putImmutable(input: {
    institutionId: string;
    evidencePackageId: string;
    segmentHash: string;
    canonicalPayload: string;
  }): Promise<EvidencePayloadPutResult>;
};

export type EvidenceStorageRefResult =
  { status: "ok"; storageRef: string } | { status: "unavailable"; reason: string };

export type EvidencePayloadLocator = {
  /**
   * The `storageRef` that `putImmutable` gives for this key, computed without
   * any request to the store: a retry under a known idempotency key names the
   * object it already stored and writes nothing (BACKEND 4.13 t. 3.5). An
   * institution without a usable domain is `unavailable`, never another one.
   */
  storageRefFor(input: {
    institutionId: string;
    evidencePackageId: string;
    segmentHash: string;
  }): Promise<EvidenceStorageRefResult>;
};

export type EvidencePayloadReadResult =
  | { status: "found"; bytes: Uint8Array }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

export type EvidencePayloadReader = {
  /**
   * Returns the stored bytes exactly as they are, undecoded: the caller
   * verifies them, so an adapter must not parse, repair or re-serialize.
   */
  readImmutable(input: {
    evidencePackageId: string;
    segmentHash: string;
  }): Promise<EvidencePayloadReadResult>;
};

/**
 * The storage side of the read (BACKEND 4.1, B2): an object lives in the
 * storage domain of one institution under `v2/<institution>/<package>/<hash>.json`,
 * so the reader needs the institution to find the bucket and the key.
 *
 * - `found` only for bytes whose SHA-256 is `segmentHash`: the object is
 *   content-addressed, so other bytes under the key are not the segment.
 * - `not_found` only when the institution's own storage says there is no
 *   object under that key. A package of another institution is never there:
 *   its objects sit in another domain under another prefix.
 * - Everything else is `unavailable` and a retry may succeed: no domain or an
 *   unverified one, a timeout, a refused or failed request, an id that cannot
 *   form a key, and an object whose bytes do not hash to the key (logged as an
 *   incident with ids only). None of these says anything about the record.
 * - One request per call, no retry inside; the caller retries.
 */
export type InstitutionEvidencePayloadReader = {
  readImmutable(input: {
    institutionId: string;
    evidencePackageId: string;
    segmentHash: string;
  }): Promise<EvidencePayloadReadResult>;
};

/**
 * Binds the institution the server resolved for the record (a row read under
 * `withActor`, never a request field) to a storage reader, giving the reader
 * that reconstruction and the process summary take.
 */
export function bindPayloadReader(
  reader: InstitutionEvidencePayloadReader,
  institutionId: string,
): EvidencePayloadReader {
  return {
    readImmutable: ({ evidencePackageId, segmentHash }) =>
      reader.readImmutable({ institutionId, evidencePackageId, segmentHash }),
  };
}

/**
 * What one HEAD proves. `present` only when the store answers for exactly
 * this key with exactly `payloadBytes` bytes and the SHA-256 checksum of
 * `segmentHash`; `absent` only when it says the object is not there;
 * `mismatch` when it holds another length or checksum under the key. Every
 * other answer, a store that gives no checksum included, is `unavailable`.
 */
export type EvidencePayloadPresenceResult =
  | { status: "present" }
  | { status: "absent" }
  | { status: "mismatch" }
  | { status: "unavailable"; reason: string };

export type EvidencePayloadPresence = {
  headImmutable(input: {
    institutionId: string;
    evidencePackageId: string;
    segmentHash: string;
    payloadBytes: number;
  }): Promise<EvidencePayloadPresenceResult>;
};
