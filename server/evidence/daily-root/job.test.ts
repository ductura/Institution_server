import { describe, expect, it } from "vitest";
import { verifyDailyRoot } from "./daily-root.ts";
import {
  createDailyRootService,
  DAILY_ROOT_EVERY_MS,
  DAILY_ROOT_JOB,
  DAILY_ROOT_OBJECT_GROUP,
  dailyRootDay,
  dailyRootJob,
  dailyRootObjectHash,
  DailyRootError,
  registerDailyRoot,
  type DailyRootDeps,
  type DailyRootJob,
} from "./job.ts";
import {
  createFakeSigner,
  createFakeStore,
  DAY,
  entries,
  entry,
  INSTITUTION,
} from "./daily-root.fixture.ts";

const signal = new AbortController().signal;
// The slot that closes DAY starts at midnight of the next day.
const SLOT = new Date("2026-11-21T00:00:00.000Z");

function deps(over: Partial<DailyRootDeps> = {}) {
  const reads: [string, string][] = [];
  const store = createFakeStore();
  const signer = createFakeSigner();
  const all: DailyRootDeps = {
    institutionId: INSTITUTION,
    readEntries: async (from, to) => {
      reads.push([from.toISOString(), to.toISOString()]);
      return entries(3);
    },
    signer,
    store,
    ...over,
  };
  return { deps: all, reads, store, signer };
}

describe("daily root job", () => {
  it("is a daily job named evidence_daily_root that asks to execute", () => {
    const job = dailyRootJob(deps().deps);
    expect(job.name).toBe(DAILY_ROOT_JOB);
    expect(DAILY_ROOT_JOB).toBe("evidence_daily_root");
    expect(job.everyMs).toBe(DAILY_ROOT_EVERY_MS);
    expect(DAILY_ROOT_EVERY_MS).toBe(86_400_000);
    expect(job.mode).toBe("execute");
    expect(Object.isFrozen(job)).toBe(true);
  });

  it("registers itself through the schedule's function", () => {
    const seen: DailyRootJob[] = [];
    registerDailyRoot((definition) => seen.push(definition), deps().deps);
    expect(seen.map((job) => job.name)).toEqual([DAILY_ROOT_JOB]);
  });

  it("closes the day before the slot, read as [midnight, next midnight)", async () => {
    const { deps: d, reads } = deps();
    expect(await dailyRootJob(d).candidates(SLOT, signal)).toBe(3);
    expect(reads).toEqual([["2026-11-20T00:00:00.000Z", "2026-11-21T00:00:00.000Z"]]);
    expect(dailyRootDay(SLOT)).toBe(DAY);
    expect(dailyRootDay(new Date("2026-11-21T00:00:01.000Z"))).toBeNull();
  });

  it("the dry run counts and neither signs nor stores", async () => {
    const { deps: d, store, signer } = deps();
    await dailyRootJob(d).candidates(SLOT, signal);
    expect(signer.calls).toBe(0);
    expect(store.objects.size).toBe(0);
  });

  it("execute stores one record under the day's key and returns its count", async () => {
    const { deps: d, store, signer } = deps();
    expect(await dailyRootJob(d).execute(SLOT, signal)).toBe(3);
    const key = `v2/${INSTITUTION}/${DAILY_ROOT_OBJECT_GROUP}/${dailyRootObjectHash(DAY)}.json`;
    const text = store.objects.get(key)!;
    const record = JSON.parse(text);
    expect(record.day).toBe(DAY);
    expect(record.count).toBe(3);
    expect(await verifyDailyRoot(record, entries(3), signer.publicKey)).toEqual({ ok: true });
  });

  it("a second run of the same slot gives the same record: existing, not a second object", async () => {
    const { deps: d, store } = deps();
    const service = createDailyRootService(d);
    const one = await service.build(DAY, signal);
    const two = await service.build(DAY, signal);
    expect(one.stored).toBe("stored");
    expect(two.stored).toBe("existing");
    expect(two.bytes).toEqual(one.bytes);
    expect(store.objects.size).toBe(1);
  });

  it("acceptance 4: a day with no entries stores a record with count 0 and does not fail", async () => {
    const { deps: d, store } = deps({ readEntries: async () => [] });
    expect(await dailyRootJob(d).execute(SLOT, signal)).toBe(0);
    const record = JSON.parse([...store.objects.values()][0]!);
    expect(record.count).toBe(0);
    expect(record.root).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("a different record for a day already stored is a conflict and is never overwritten", async () => {
    const store = createFakeStore();
    const signer = createFakeSigner();
    const first = deps({ store, signer, readEntries: async () => entries(2) }).deps;
    const later = deps({ store, signer, readEntries: async () => entries(3) }).deps;
    await dailyRootJob(first).execute(SLOT, signal);
    const before = [...store.objects.values()];
    await expect(dailyRootJob(later).execute(SLOT, signal)).rejects.toMatchObject({
      code: "daily_root_conflict",
    });
    expect([...store.objects.values()]).toEqual(before);
  });

  it("refuses entries of another day and malformed entries by code, storing nothing", async () => {
    const outside = deps({ readEntries: async () => [entry(1, 1, "2026-11-21")] });
    await expect(dailyRootJob(outside.deps).execute(SLOT, signal)).rejects.toMatchObject({
      code: "entry_outside_day",
    });
    const bad = deps({ readEntries: async () => [{ receiptId: "x" }] });
    await expect(dailyRootJob(bad.deps).execute(SLOT, signal)).rejects.toMatchObject({
      code: "entries_malformed",
    });
    expect(outside.store.objects.size + bad.store.objects.size).toBe(0);
  });

  it("stores nothing when the signer fails or signs with another key", async () => {
    const failing = deps();
    failing.deps.signer.sign = async () =>
      ({ ok: false, error: { code: "x", message: "x" } }) as never;
    await expect(dailyRootJob(failing.deps).execute(SLOT, signal)).rejects.toMatchObject({
      code: "signing_unavailable",
    });

    const other = createFakeSigner();
    const mixed = deps();
    mixed.deps.signer = {
      sign: (message) => other.sign(message),
      publicVerificationKey: () => createFakeSigner("daily-root-test-key").publicVerificationKey(),
    };
    await expect(dailyRootJob(mixed.deps).execute(SLOT, signal)).rejects.toMatchObject({
      code: "self_check_failed",
    });
    expect(failing.store.objects.size + mixed.store.objects.size).toBe(0);
  });

  it("maps storage answers to closed codes", async () => {
    for (const [answer, code] of [
      [{ status: "invalid" }, "storage_invalid"],
      [{ status: "unavailable", reason: "down" }, "storage_unavailable"],
    ] as const) {
      const { deps: d, store } = deps();
      store.answer = answer as never;
      await expect(dailyRootJob(d).execute(SLOT, signal)).rejects.toMatchObject({ code });
    }
  });

  it("throws the error the composition root gives, or a DailyRootError", async () => {
    class Given extends Error {}
    const { deps: d } = deps({ readEntries: async () => null, fail: (code) => new Given(code) });
    await expect(dailyRootJob(d).execute(SLOT, signal)).rejects.toBeInstanceOf(Given);
    const plain = deps({ readEntries: async () => null }).deps;
    await expect(dailyRootJob(plain).execute(SLOT, signal)).rejects.toBeInstanceOf(DailyRootError);
    await expect(
      dailyRootJob(plain).execute(new Date("2026-11-21T10:00:00.000Z"), signal),
    ).rejects.toMatchObject({ code: "day_invalid" });
  });
});
