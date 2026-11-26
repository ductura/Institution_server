// DAN-811, plan of attack ductura/server#107 parts D and E: every row the open
// statements return is checked before it leaves server/database; an
// unexpected one is OPEN_WORK_ROW_MALFORMED, never a partial answer. The
// answer is a Result with an AppError (docs/CODE_STYLE.md §8; DAN-859, contract
// Ductus#1836 c.6946658606).
// Every identifier, hash and key below is invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REVISION_ZERO_SHA256,
  REVISION_ZERO_V2_SHA256,
  REVISION_ZERO_V3_SHA256,
} from "../domain/index.ts";

import {
  count,
  createWorkOpener,
  OPEN_WORK_DATABASE_ERROR,
  OPEN_WORK_ERRORS,
  OPEN_WORK_NOT_ACCEPTING,
  OPEN_WORK_NOT_CONFIGURED,
  OPEN_WORK_NOT_FOUND,
  OPEN_WORK_NOT_STARTED,
  OPEN_WORK_ROW_MALFORMED,
  OPEN_WORK_UNAUTHENTICATED,
} from "./open-work.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-evidencije-000000000000001";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
// At revision 0 the current document is revision 0 (SRV-7F).
const HASH = REVISION_ZERO_SHA256;
const LATER_HASH = "a".repeat(64);
const OPENED = {
  outcome: "opened",
  document_id: "dokument-izmisljeni-1",
  evidence_profile_id: "standard-v1",
  current_revision: "0",
  document_hash: HASH,
  head_segment_hash: null,
  last_sequence_to: "0",
  snapshot: '{"nodes":[],"naslov":"Čćžšđ"}',
};
const KEY = {
  key_id: "kljuc-1",
  key_version: "1",
  evidence_domain_id: DOMAIN,
  purpose: "receipt",
  algorithm: "Ed25519",
  key_base64url: "MCowBQYDK2VwAyEA" + "A".repeat(43),
  valid_from: "2026-11-01T10:00:00.000Z",
  valid_to: null,
  revoked_at: null,
};

type Rows = {
  open?: Record<string, unknown>[];
  submitted?: Record<string, unknown>[];
  domain?: Record<string, unknown>[];
  keys?: Record<string, unknown>[];
  revisionZero?: Record<string, unknown>[];
};

function opener(rows: Rows) {
  const seen: { text: string; values: readonly unknown[] | undefined; token: unknown }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values, token });
        const pick = text.includes("open_student_work")
          ? (rows.open ?? [OPENED])
          : text.includes("work_submitted")
            ? (rows.submitted ?? [{ submitted: false }])
            : text.includes("evidence.document_revision")
              ? (rows.revisionZero ?? [{ content_hash: REVISION_ZERO_SHA256 }])
              : text.includes("evidence.package")
                ? (rows.domain ?? [{ evidence_domain_id: DOMAIN, last_signed_at: null }])
                : (rows.keys ?? [KEY]);
        return { rows: pick as never[], rowCount: pick.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { open: createWorkOpener(withActor), seen };
}

const failed = (error: unknown) => ({ ok: false, error });
const ROW_MALFORMED = failed(OPEN_WORK_ROW_MALFORMED);

const catalogue = JSON.parse(
  readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
) as { openWork?: Record<string, unknown> };

describe("open work errors (docs/CODE_STYLE.md §8)", () => {
  it("has a Croatian text for every key, and no other key in its section", () => {
    const section = catalogue.openWork ?? {};
    for (const { messageKey } of OPEN_WORK_ERRORS) {
      const text = section[messageKey.replace(/^openWork\./, "")];
      expect(typeof text === "string" && text.trim().length > 0, messageKey).toBe(true);
    }
    expect(
      Object.keys(section)
        .map((k) => `openWork.${k}`)
        .sort(),
    ).toEqual(OPEN_WORK_ERRORS.map((e) => e.messageKey).sort());
  });

  it("lists seven errors with distinct UPPER_SNAKE codes", () => {
    expect(OPEN_WORK_ERRORS).toHaveLength(7);
    for (const { code } of OPEN_WORK_ERRORS) expect(code).toMatch(/^OPEN_WORK_[A-Z_]+$/);
    expect(new Set(OPEN_WORK_ERRORS.map((e) => e.code)).size).toBe(7);
  });
});

describe("createWorkOpener", () => {
  it("opens the work in one transaction with the token presented, never a parameter", async () => {
    const { open, seen } = opener({});
    const result = await open.openWork(TOKEN, ASSIGNMENT, true);
    expect(result).toEqual({
      ok: true,
      value: {
        documentId: "dokument-izmisljeni-1",
        evidenceProfileId: "standard-v1",
        currentRevision: 0,
        documentHash: HASH,
        headSegmentHash: null,
        lastSequenceTo: 0,
        schemaVersion: 1,
        revisionZeroHash: REVISION_ZERO_SHA256,
        snapshot: OPENED.snapshot,
        receiptKeys: [
          {
            algorithm: "Ed25519",
            keyId: "kljuc-1",
            keyVersion: "1",
            encoding: "spki-der",
            keyBase64Url: KEY.key_base64url,
            evidenceDomainId: DOMAIN,
            purpose: "receipt",
            validFrom: KEY.valid_from,
            validTo: null,
            revokedAt: null,
          },
        ],
        submitted: false,
        lastSignedAt: null,
      },
    });
    expect(seen.map((s) => s.values)).toEqual([
      [ASSIGNMENT, true],
      [ASSIGNMENT],
      ["dokument-izmisljeni-1"],
      ["dokument-izmisljeni-1"],
      [DOMAIN],
    ]);
    for (const s of seen) expect(JSON.stringify(s.values)).not.toContain(TOKEN);
  });

  it.each([
    ["unauthenticated", OPEN_WORK_UNAUTHENTICATED],
    ["not_found", OPEN_WORK_NOT_FOUND],
    ["not_accepting", OPEN_WORK_NOT_ACCEPTING],
    ["not_started", OPEN_WORK_NOT_STARTED],
  ])("passes the refusal %s on as its error and asks nothing more", async (outcome, error) => {
    const { open, seen } = opener({ open: [{ outcome }] });
    const result = await open.openWork(TOKEN, ASSIGNMENT, false);
    expect(result).toEqual(failed(error));
    expect(!result.ok && result.error).toBe(error);
    expect(seen).toHaveLength(1);
  });

  it.each(["toString", "__proto__", "constructor", "hasOwnProperty"])(
    "reads an inherited name %s as an outcome as a malformed row, not a refusal",
    async (outcome) => {
      const { open, seen } = opener({ open: [{ ...OPENED, outcome }] });
      expect(await open.openWork(TOKEN, ASSIGNMENT, false)).toEqual(ROW_MALFORMED);
      expect(seen).toHaveLength(1);
    },
  );

  it("C8: not configured is its own error", async () => {
    const { open } = opener({ open: [{ outcome: "not_configured" }] });
    expect(await open.openWork(TOKEN, ASSIGNMENT, true)).toEqual(failed(OPEN_WORK_NOT_CONFIGURED));
  });

  it.each([
    ["no row", []],
    ["two rows", [OPENED, OPENED]],
    ["an unknown outcome", [{ ...OPENED, outcome: "otvoreno" }]],
    ["an outcome of another type", [{ ...OPENED, outcome: 1 }]],
    ["an empty document id", [{ ...OPENED, document_id: "" }]],
    ["no profile", [{ ...OPENED, evidence_profile_id: null }]],
    ["a hash in capitals", [{ ...OPENED, document_hash: HASH.toUpperCase() }]],
    ["a short hash", [{ ...OPENED, document_hash: "a".repeat(63) }]],
    ["a head segment hash that is not one", [{ ...OPENED, head_segment_hash: "x" }]],
    ["a negative revision", [{ ...OPENED, current_revision: -1 }]],
    ["a revision with a leading zero", [{ ...OPENED, current_revision: "01" }]],
    ["a revision past 2^53", [{ ...OPENED, current_revision: "9007199254740993" }]],
    ["a fractional sequence", [{ ...OPENED, last_sequence_to: 0.5 }]],
    ["a snapshot that is not text", [{ ...OPENED, snapshot: null }]],
  ])("E2: %s is a malformed row", async (_name, rows) => {
    const { open } = opener({ open: rows });
    expect(await open.openWork(TOKEN, ASSIGNMENT, true)).toEqual(ROW_MALFORMED);
  });

  // SRV-7F (docs/contracts/document-schema-v3.md §7): the version and the hash
  // of revision 0 come from the server's record, at every revision.
  it.each([
    [REVISION_ZERO_SHA256, 1],
    [REVISION_ZERO_V2_SHA256, 2],
    [REVISION_ZERO_V3_SHA256, 3],
  ])("SRV-7F: a later revision over revision 0 %s is a work of version %s", async (hash, v) => {
    const { open, seen } = opener({
      open: [{ ...OPENED, current_revision: "7", document_hash: LATER_HASH }],
      revisionZero: [{ content_hash: hash }],
    });
    const result = await open.openWork(TOKEN, ASSIGNMENT, false);
    expect(result.ok && result.value).toMatchObject({
      currentRevision: 7,
      documentHash: LATER_HASH,
      schemaVersion: v,
      revisionZeroHash: hash,
    });
    const read = seen.find((s) => s.text.includes("evidence.document_revision"));
    expect(read?.text).toMatch(/revision = 0/);
    expect(read?.values).toEqual(["dokument-izmisljeni-1"]);
  });

  it("SRV-7F: at revision 0 a v3 work opens with the v3 revision 0", async () => {
    const { open } = opener({
      open: [{ ...OPENED, document_hash: REVISION_ZERO_V3_SHA256 }],
      revisionZero: [{ content_hash: REVISION_ZERO_V3_SHA256 }],
    });
    const result = await open.openWork(TOKEN, ASSIGNMENT, true);
    expect(result.ok && [result.value.schemaVersion, result.value.revisionZeroHash]).toEqual([
      3,
      REVISION_ZERO_V3_SHA256,
    ]);
  });

  it.each([
    ["no revision 0", []],
    ["two revisions 0", [{ content_hash: HASH }, { content_hash: HASH }]],
    ["a hash that is no revision 0 the server writes", [{ content_hash: LATER_HASH }]],
    ["a known hash in capitals", [{ content_hash: REVISION_ZERO_V3_SHA256.toUpperCase() }]],
    ["an inherited name", [{ content_hash: "__proto__" }]],
    ["no hash", [{ content_hash: null }]],
  ])("SRV-7F: %s is a malformed row, never a guessed version", async (_name, rows) => {
    const { open, seen } = opener({ revisionZero: rows });
    expect(await open.openWork(TOKEN, ASSIGNMENT, false)).toEqual(ROW_MALFORMED);
    expect(seen.some((s) => s.text.includes("signing_key"))).toBe(false);
  });

  it("SRV-7F: at revision 0 a current hash other than revision 0's is a malformed row", async () => {
    // A v1 document hash on a work whose revision 0 is v3: the two records disagree.
    const { open } = opener({ revisionZero: [{ content_hash: REVISION_ZERO_V3_SHA256 }] });
    expect(await open.openWork(TOKEN, ASSIGNMENT, false)).toEqual(ROW_MALFORMED);
  });

  it.each([
    ["null", [{ submitted: null }]],
    ["text", [{ submitted: "false" }]],
    ["no row", []],
  ])("E3: submitted as %s is a malformed row, never false by assumption", async (_name, rows) => {
    const { open } = opener({ submitted: rows });
    expect(await open.openWork(TOKEN, ASSIGNMENT, true)).toEqual(ROW_MALFORMED);
  });

  it("D4: a submitted work says so", async () => {
    const { open } = opener({ submitted: [{ submitted: true }] });
    const result = await open.openWork(TOKEN, ASSIGNMENT, false);
    expect(result.ok && result.value.submitted).toBe(true);
  });

  it.each([
    ["no package", []],
    [
      "a domain id that is not a UUID v4",
      [{ evidence_domain_id: "00000000-0000-1000-8000-0000000000d1" }],
    ],
    ["a domain id in capitals", [{ evidence_domain_id: DOMAIN.toUpperCase() }]],
  ])("E4: %s is a malformed row before any key is read", async (_name, rows) => {
    const { open, seen } = opener({ domain: rows, keys: [] });
    expect(await open.openWork(TOKEN, ASSIGNMENT, true)).toEqual(ROW_MALFORMED);
    expect(seen.some((s) => s.text.includes("signing_key"))).toBe(false);
  });

  it("IZV-RUTE-1a: sends the signed minute of the newest signed receipt", async () => {
    const at = "2026-11-20T09:41:00.000Z";
    const { open, seen } = opener({ domain: [{ evidence_domain_id: DOMAIN, last_signed_at: at }] });
    const result = await open.openWork(TOKEN, ASSIGNMENT, true);
    expect(result.ok && result.value.lastSignedAt).toBe(at);
    // Only a signed receipt counts, newest by the sequence its segment ends at.
    const sql = seen.find((s) => s.text.includes("evidence.package"))?.text ?? "";
    expect(sql).toMatch(/r\.status = 'signed'/);
    expect(sql).toMatch(/ORDER BY s\.sequence_to DESC LIMIT 1/);
  });

  it.each([
    ["absent", {}],
    ["seconds in it", { last_signed_at: "2026-11-20T09:41:07.000Z" }],
    ["another zone", { last_signed_at: "2026-11-20T09:41:00.000+01:00" }],
    ["empty", { last_signed_at: "" }],
    ["a number", { last_signed_at: 1 }],
  ])("IZV-RUTE-1a: a last signed time %s is a malformed row", async (_name, change) => {
    const { open } = opener({ domain: [{ evidence_domain_id: DOMAIN, ...change }] });
    expect(await open.openWork(TOKEN, ASSIGNMENT, true)).toEqual(ROW_MALFORMED);
  });

  it.each([
    ["another algorithm", { algorithm: "RSA_PSS_SHA256" }],
    ["another purpose", { purpose: "signing" }],
    ["an empty key id", { key_id: "" }],
    ["no key version", { key_version: null }],
    ["a key of another domain", { evidence_domain_id: "00000000-0000-4000-8000-0000000000d2" }],
    ["no key bytes", { key_base64url: "" }],
    ["no valid_from", { valid_from: null }],
    ["a valid_to that is not text", { valid_to: 1 }],
    ["a revoked_at that is empty", { revoked_at: "" }],
  ])("E4: a key row with %s makes the whole list malformed", async (_name, change) => {
    const { open } = opener({ keys: [KEY, { ...KEY, ...change }] });
    expect(await open.openWork(TOKEN, ASSIGNMENT, true)).toEqual(ROW_MALFORMED);
  });

  it("D2: a checkpoint key is checked but never sent", async () => {
    const { open } = opener({
      keys: [{ ...KEY, purpose: "checkpoint", key_id: "kontrolni" }, KEY],
    });
    const result = await open.openWork(TOKEN, ASSIGNMENT, true);
    expect(result.ok && result.value.receiptKeys.map((k) => k.keyId)).toEqual(["kljuc-1"]);
  });

  it("D3: a domain without a receipt key opens with no keys", async () => {
    const { open } = opener({ keys: [] });
    const result = await open.openWork(TOKEN, ASSIGNMENT, true);
    expect(result.ok && result.value.receiptKeys).toEqual([]);
  });

  // Review FAIL c.6947022168: an operational failure of the database is a Result;
  // only a programming error stays an exception, which the route records by class.
  const throwing = (thrown: unknown) =>
    createWorkOpener((async () => {
      throw thrown;
    }) as WithActor);

  it.each([
    [
      "a refused connection",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    ],
    ["a connection that ends", new Error("Connection terminated unexpectedly")],
    ["an SQLSTATE", Object.assign(new Error("tekst greške baze"), { code: "57P01" })],
    ["a session refused by withActor", Object.assign(new Error("x"), { code: "ZD401" })],
    ["a value that is no Error", "veza prekinuta"],
    [
      "an error with a throwing code getter",
      Object.defineProperty(new Error("x"), "code", {
        get() {
          throw new Error("getter");
        },
      }),
    ],
  ])("E1: %s is OPEN_WORK_DATABASE_ERROR, with no text of it", async (_name, thrown) => {
    const result = await throwing(thrown).openWork(TOKEN, ASSIGNMENT, true);
    expect(result).toEqual(failed(OPEN_WORK_DATABASE_ERROR));
    expect(!result.ok && result.error).toBe(OPEN_WORK_DATABASE_ERROR);
  });

  it.each([
    ["a TypeError", new TypeError("x")],
    ["a RangeError", new RangeError("x")],
    ["a ReferenceError", new ReferenceError("x")],
    ["a SyntaxError", new SyntaxError("x")],
  ])("E1: %s is a programming error and stays an exception", async (_name, thrown) => {
    await expect(throwing(thrown).openWork(TOKEN, ASSIGNMENT, true)).rejects.toBe(thrown);
  });

  it("E1: a revoked Proxy, unreadable as an error, stays the same exception", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    await expect(throwing(proxy).openWork(TOKEN, ASSIGNMENT, true)).rejects.toBe(proxy);
  });
});

describe("count", () => {
  it.each([
    [0, 0],
    ["0", 0],
    ["42", 42],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])("%s is %s", (value, expected) => expect(count(value)).toBe(expected));

  it.each([-1, "-1", "01", " 1", "1e3", 1.5, "9007199254740992", null, undefined, true, 10n])(
    "%s is no count",
    (value) => expect(count(value)).toBeNull(),
  );
});
