import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dailyRootOf,
  dailyRootPayload,
  dailyRootPublicKey,
  dailyRootSigningInput,
  dayStart,
  encodeDailyRoot,
  readDailyRootEntries,
  readDailyRootRecord,
  verifyDailyRoot,
  type DailyRootRecord,
} from "./daily-root.ts";
import { createDailyRootService } from "./job.ts";
import {
  createFakeSigner,
  createFakeStore,
  DAY,
  entries,
  entry,
  INSTITUTION,
} from "./daily-root.fixture.ts";

const EMPTY_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const signal = new AbortController().signal;

async function signedDay(list = entries(5), signer = createFakeSigner()) {
  const service = createDailyRootService({
    institutionId: INSTITUTION,
    readEntries: async () => list,
    signer,
    store: createFakeStore(),
  });
  const built = await service.build(DAY, signal);
  return { ...built, signer, list };
}

describe("daily root: the root (acceptance 1)", () => {
  it("the same entries give the same root, in any input order", async () => {
    const list = entries(9);
    const a = readDailyRootEntries(list)!;
    const b = readDailyRootEntries([...list].reverse())!;
    expect(await dailyRootOf(a)).toBe(await dailyRootOf(b));
  });

  it("the empty day is the root of the empty tree (RFC 9162)", async () => {
    expect(await dailyRootOf([])).toBe(EMPTY_ROOT);
  });

  it("one entry changes the root", async () => {
    const list = entries(4);
    const changed = [...list.slice(0, 3), { ...list[3]!, digest: "0".repeat(64) }];
    expect(await dailyRootOf(readDailyRootEntries(list)!)).not.toBe(
      await dailyRootOf(readDailyRootEntries(changed)!),
    );
  });

  it("the signed record is the same bytes for the same entries (Ed25519 is deterministic)", async () => {
    const signer = createFakeSigner();
    const one = await signedDay(entries(6), signer);
    const two = await signedDay([...entries(6)].reverse(), signer);
    expect(one.bytes).toEqual(two.bytes);
  });
});

describe("daily root: reading", () => {
  it("refuses a repeated receipt id, a bad digest, a non-canonical time and an extra key", () => {
    const one = entry(1);
    expect(readDailyRootEntries([one, { ...one }])).toBeNull();
    expect(readDailyRootEntries([{ ...one, digest: "A".repeat(64) }])).toBeNull();
    expect(readDailyRootEntries([{ ...one, acceptedAt: "2026-11-20T00:01:00Z" }])).toBeNull();
    expect(readDailyRootEntries([{ ...one, extra: 1 }])).toBeNull();
    expect(readDailyRootEntries("not a list")).toBeNull();
  });

  it("knows only real calendar days", () => {
    expect(dayStart("2026-11-20")).toBe(Date.parse("2026-11-20T00:00:00.000Z"));
    expect(dayStart("2026-02-30")).toBeNull();
    expect(dayStart("2026-1-2")).toBeNull();
    expect(dayStart(20261120)).toBeNull();
  });

  it("refuses a record with a missing or extra field", async () => {
    const { record } = await signedDay();
    expect(readDailyRootRecord(record)).toEqual(record);
    const partial: Partial<DailyRootRecord> = { ...record };
    delete partial.signature;
    expect(readDailyRootRecord(partial)).toBeNull();
    expect(readDailyRootRecord({ ...record, extra: true })).toBeNull();
    expect(readDailyRootRecord({ ...record, count: -1 })).toBeNull();
  });
});

describe("daily root: the check (acceptance 2)", () => {
  it("passes for the stored bytes, the parsed record and entries in another order", async () => {
    const { bytes, record, signer, list } = await signedDay();
    expect(await verifyDailyRoot(bytes, list, signer.publicKey)).toEqual({ ok: true });
    expect(await verifyDailyRoot(record, [...list].reverse(), signer.publicKey)).toEqual({
      ok: true,
    });
  });

  it("refuses a changed entry", async () => {
    const { bytes, signer, list } = await signedDay();
    const changed = list.map((e, i) => (i === 2 ? { ...e, digest: "f".repeat(64) } : e));
    expect(await verifyDailyRoot(bytes, changed, signer.publicKey)).toEqual({
      ok: false,
      problem: "root_mismatch",
    });
  });

  it("refuses a removed entry", async () => {
    const { bytes, signer, list } = await signedDay();
    expect(await verifyDailyRoot(bytes, list.slice(1), signer.publicKey)).toEqual({
      ok: false,
      problem: "count_mismatch",
    });
  });

  it("refuses an added entry", async () => {
    const { bytes, signer, list } = await signedDay();
    expect(await verifyDailyRoot(bytes, [...list, entry(99, 999)], signer.publicKey)).toEqual({
      ok: false,
      problem: "count_mismatch",
    });
  });

  it("refuses an entry swapped for another with the same count", async () => {
    const { bytes, signer, list } = await signedDay();
    expect(
      await verifyDailyRoot(bytes, [...list.slice(1), entry(99, 999)], signer.publicKey),
    ).toEqual({ ok: false, problem: "root_mismatch" });
  });

  it("refuses an entry of another day", async () => {
    const { bytes, signer, list } = await signedDay();
    const other = [...list.slice(1), entry(100, 1, "2026-11-21")];
    expect(await verifyDailyRoot(bytes, other, signer.publicKey)).toEqual({
      ok: false,
      problem: "entry_outside_day",
    });
  });

  it("refuses the wrong key", async () => {
    const { bytes, list } = await signedDay();
    expect(await verifyDailyRoot(bytes, list, createFakeSigner().publicKey)).toEqual({
      ok: false,
      problem: "signature_invalid",
    });
  });

  it("refuses a record whose day, root, count or key id was changed after signing", async () => {
    const { record, signer, list } = await signedDay();
    const forged: DailyRootRecord[] = [
      { ...record, day: "2026-11-19" },
      { ...record, root: "0".repeat(64) },
      { ...record, count: record.count + 1 },
      { ...record, keyId: "another-key" },
    ];
    for (const one of forged) {
      expect(await verifyDailyRoot(one, list, signer.publicKey)).toEqual({
        ok: false,
        problem: "signature_invalid",
      });
    }
  });

  it("refuses a key that is not Ed25519 and text that is not a key", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(
      dailyRootPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString()),
    ).toBeNull();
    expect(dailyRootPublicKey("not a key")).toBeNull();
    const { bytes, list } = await signedDay();
    expect(await verifyDailyRoot(bytes, list, null)).toEqual({ ok: false, problem: "key_invalid" });
  });

  it("refuses malformed record bytes and entries, with a closed code only", async () => {
    const { bytes, signer, list } = await signedDay();
    expect(await verifyDailyRoot(new Uint8Array([0xff]), list, signer.publicKey)).toEqual({
      ok: false,
      problem: "record_malformed",
    });
    expect(await verifyDailyRoot(bytes, [{ receiptId: "x" }], signer.publicKey)).toEqual({
      ok: false,
      problem: "entries_malformed",
    });
  });

  it("signs the fixed context line and the JCS of the four fields", async () => {
    const payload = await dailyRootPayload(DAY, [], "k");
    const text = new TextDecoder().decode(dailyRootSigningInput(payload));
    expect(text).toBe(
      `ductura.evidence-daily-root.v1\n{"count":0,"day":"${DAY}","keyId":"k","root":"${EMPTY_ROOT}"}`,
    );
  });

  it("the stored form is the JCS of the five fields", async () => {
    const { record, bytes } = await signedDay(entries(1));
    expect(new TextDecoder().decode(bytes)).toBe(
      `{"count":1,"day":"${DAY}","keyId":"${record.keyId}","root":"${record.root}","signature":"${record.signature}"}`,
    );
    expect(encodeDailyRoot(record)).toEqual(bytes);
  });
});
