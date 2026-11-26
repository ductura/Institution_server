import { describe, expect, it } from "vitest";

import { createWorkerEvidenceChainSource } from "./chain-source.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const INSTITUTION = "00000000-0000-4000-8000-0000000000f1";
const H = (letter: string) => letter.repeat(64);

function sourceOver(rows: unknown, calls: { text: string; values: readonly unknown[] }[] = []) {
  return createWorkerEvidenceChainSource({
    evidenceDomainId: DOMAIN,
    query: async (text, values) => {
      calls.push({ text, values });
      if (rows instanceof Error) throw rows;
      return { rows: rows as readonly unknown[] };
    },
  });
}
const due = (id: string, count = "60") => ({
  evidencePackageId: id,
  institutionId: INSTITUTION,
  segmentCount: count,
});
const link = (position: number, hash: string, head = H("b"), doc: string | null = "{}") => ({
  position: String(position),
  segmentHash: hash,
  headSegmentHash: head,
  initialDocument: doc,
});

describe("createWorkerEvidenceChainSource.listDue", () => {
  it("asks for the worker's own domain and returns the packages as numbers", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const answer = await sourceOver([due("paket-a"), due("paket-b", "120")], calls).listDue({
      interval: 50,
      afterPackageId: null,
      limit: 10,
    });
    expect(answer).toEqual({
      status: "found",
      packages: [
        { evidencePackageId: "paket-a", institutionId: INSTITUTION, segmentCount: 60 },
        { evidencePackageId: "paket-b", institutionId: INSTITUTION, segmentCount: 120 },
      ],
    });
    expect(calls[0]!.values).toEqual([DOMAIN, 50, null, 10]);
    expect(calls[0]!.text).toContain("app.worker_packages_due_checkpoints");
  });

  it("refuses a request that is not well formed before any statement", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const source = sourceOver([], calls);
    for (const input of [
      { interval: 0, afterPackageId: null, limit: 10 },
      { interval: 50, afterPackageId: null, limit: 0 },
      { interval: 50, afterPackageId: null, limit: 501 },
      { interval: 50, afterPackageId: "Paket/../x", limit: 10 },
      { interval: 1.5, afterPackageId: null, limit: 10 },
    ]) {
      expect(await source.listDue(input)).toEqual({
        status: "unavailable",
        reason: "invalid_request",
      });
    }
    const badDomain = createWorkerEvidenceChainSource({
      evidenceDomainId: "nije-uuid",
      query: async () => ({ rows: [] }),
    });
    expect(await badDomain.listDue({ interval: 50, afterPackageId: null, limit: 1 })).toEqual({
      status: "unavailable",
      reason: "invalid_request",
    });
    expect(calls).toEqual([]);
  });

  it("is unavailable for a driver error and for any answer it cannot take whole", async () => {
    const ask = (rows: unknown) =>
      sourceOver(rows).listDue({ interval: 50, afterPackageId: "paket-a", limit: 2 });
    expect(await ask(new Error("tajni tekst vozaca"))).toEqual({
      status: "unavailable",
      reason: "source_failed",
    });
    for (const rows of [
      "nije lista",
      [due("paket-b"), due("paket-c"), due("paket-d")], // more than asked
      [due("paket-a")], // not after the cursor
      [due("paket-c"), due("paket-b")], // not ascending
      [due("paket-b", "49")], // below the interval
      [due("paket-b", "01")],
      [{ ...due("paket-b"), osoba: "x" }],
      [{ ...due("paket-b"), institutionId: "nije-uuid" }],
      [due("Paket-B")],
    ]) {
      expect(await ask(rows)).toEqual({ status: "unavailable", reason: "invalid_row" });
    }
  });
});

describe("createWorkerEvidenceChainSource.readChain", () => {
  it("returns the chain in order with its head and starting document", async () => {
    const answer = await sourceOver([link(1, H("a")), link(2, H("b"))]).readChain("paket-a");
    expect(answer).toEqual({
      status: "found",
      chain: { headSegmentHash: H("b"), segmentHashes: [H("a"), H("b")], initialDocument: "{}" },
    });
  });

  it("reads no row as none, whatever the reason", async () => {
    expect(await sourceOver([]).readChain("paket-a")).toEqual({ status: "none" });
  });

  it("is unavailable for a chain that is out of order, of two snapshots or without its head", async () => {
    const ask = (rows: unknown) => sourceOver(rows).readChain("paket-a");
    expect(await ask(new Error("x"))).toEqual({ status: "unavailable", reason: "source_failed" });
    for (const rows of [
      [link(2, H("a")), link(1, H("b"))],
      [link(1, H("a"), H("b")), link(2, H("b"), H("c"))],
      [link(1, H("a"), H("b"), "{}"), link(2, H("b"), H("b"), null)],
      [link(1, H("a"), H("b"))], // the head is not the last segment
      [link(1, "kratki")],
      [{ ...link(1, H("b")), osoba: "x" }],
      [link(1, H("b"), H("b"), 7 as unknown as string)],
    ]) {
      expect(await ask(rows)).toEqual({ status: "unavailable", reason: "invalid_row" });
    }
    expect(await sourceOver([]).readChain("Paket/x")).toEqual({
      status: "unavailable",
      reason: "invalid_request",
    });
  });
});
