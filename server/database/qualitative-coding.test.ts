// The qualitative coding adapter (SRV-V18-KODIRANJE-BAZA) over a fake withActor:
// the statements and parameters, refused input before a round trip, a material
// that is not there as ZD404 and the export built in the order of the codebook.
// All values are invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "./index.ts";
import { createQualitativeCodingStore } from "./qualitative-coding.ts";

const TOKEN = "izmisljeni-token-studenta-0000000000000001";
const ID = "5d1c2b3a-4f5e-4a6b-9c7d-8e9f0a1b2c31";
const CODE = "6e2d3c4b-5a6f-4b7c-8d8e-9fa0b1c2d3e4";

const seen: { text: string; values: readonly unknown[] }[] = [];
const fake =
  (answer: (text: string) => unknown[]): WithActor =>
  async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ text, values });
        const rows = answer(text);
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
const calls = () => seen.length;

describe("qualitative coding store", () => {
  it("keeps a material with the line breaks turned into line feeds", async () => {
    seen.length = 0;
    const store = createQualitativeCodingStore(fake(() => [{ id: ID }]));
    await expect(store.createMaterial(TOKEN, "Intervju A", "interview", "a\r\nb\rc")).resolves.toBe(
      ID,
    );
    expect(seen[0]?.values).toEqual(["Intervju A", "interview", "a\nb\nc"]);
    expect(seen[0]?.text).toContain("app.create_qual_material");
  });

  it.each([
    ["an empty title", ["", "note", "Tekst"]],
    ["a title with a space at the start", [" A", "note", "Tekst"]],
    ["a kind outside the closed set", ["A", "audio", "Tekst"]],
    ["an empty text", ["A", "note", ""]],
    ["a text over the limit", ["A", "note", "a".repeat(100_001)]],
    ["a control character", ["A", "note", "a\u0001"]],
  ])("refuses %s before a round trip", async (_name, args) => {
    seen.length = 0;
    const store = createQualitativeCodingStore(fake(() => [{ id: ID }]));
    await expect(
      store.createMaterial(TOKEN, ...(args as [string, string, string])),
    ).rejects.toMatchObject({
      code: "ZD422",
    });
    expect(calls()).toBe(0);
  });

  it("answers ZD404-shaped nothing as an error, not as an empty material", async () => {
    const store = createQualitativeCodingStore(fake(() => []));
    await expect(store.readMaterial(TOKEN, ID)).rejects.toThrow();
  });

  it("refuses a code with no name and a place below 1 before a round trip", async () => {
    seen.length = 0;
    const store = createQualitativeCodingStore(fake(() => [{ id: CODE }]));
    await expect(store.createCode(TOKEN, "", "")).rejects.toMatchObject({ code: "ZD422" });
    await expect(store.updateCode(TOKEN, CODE, "A".repeat(81), "")).rejects.toMatchObject({
      code: "ZD422",
    });
    await expect(store.moveCode(TOKEN, CODE, 0)).rejects.toMatchObject({ code: "ZD422" });
    await expect(store.moveCode(TOKEN, CODE, 1.5)).rejects.toMatchObject({ code: "ZD422" });
    expect(calls()).toBe(0);
  });

  it("deletes a code only on a real confirmation and says how many passages went", async () => {
    seen.length = 0;
    const store = createQualitativeCodingStore(fake(() => [{ removed: 2 }]));
    await expect(store.deleteCode(TOKEN, CODE, true)).resolves.toBe(2);
    await store.deleteCode(TOKEN, CODE, "yes" as unknown as boolean);
    expect(seen.map((call) => call.values[1])).toEqual([true, false]);
  });

  it("refuses an anchor that cannot be one before a round trip", async () => {
    seen.length = 0;
    const store = createQualitativeCodingStore(fake(() => [{ id: ID }]));
    const bad = [
      { paragraph: 0, start: 0, end: 5, quote: "Prvi" },
      { paragraph: -1, start: 0, end: 4, quote: "Prvi" },
      { paragraph: 0, start: -1, end: 3, quote: "Prvi" },
      { paragraph: 0, start: 4, end: 4, quote: "" },
      { paragraph: 0, start: 0, end: 1, quote: " " },
    ];
    for (const anchor of bad) {
      await expect(store.createSegment(TOKEN, ID, CODE, anchor)).rejects.toMatchObject({
        code: "ZD422",
      });
    }
    await expect(
      store.createSegment(TOKEN, ID, CODE, { paragraph: 0, start: 0, end: 4, quote: "Prvi" }, ""),
    ).rejects.toMatchObject({ code: "ZD422" });
    expect(calls()).toBe(0);
    await expect(
      store.createSegment(
        TOKEN,
        ID,
        CODE,
        { paragraph: 2, start: 13, end: 17, quote: "šuma" },
        "Bilješka",
      ),
    ).resolves.toBe(ID);
    expect(seen[0]?.values).toEqual([ID, CODE, 2, 13, 17, "šuma", "Bilješka"]);
  });

  it("builds the export from one statement, in the order of the codebook", async () => {
    seen.length = 0;
    const seg = (codeId: string, materialRank: number, quote: string) => ({
      kind: "segment",
      item: {
        materialId: ID,
        materialRank,
        codeId,
        paragraph: 0,
        start: 0,
        end: quote.length,
        quote,
        memo: null,
      },
    });
    const code = (id: string, name: string, order: number) => ({
      kind: "code",
      item: { id, name, description: "", order, segmentCount: 1 },
    });
    const store = createQualitativeCodingStore(
      fake(() => [
        code("k1", "Kompost", 1),
        code("k2", "Šuma", 2),
        seg("k2", 1, "šuma"),
        seg("k1", 1, "Prvi"),
        seg("k2", 2, "šuti"),
      ]),
    );
    const result = await store.exportOf(TOKEN);
    expect(calls()).toBe(1);
    expect(result.schema).toBe("qualitative-export-v1");
    expect(result.segments.map((segment) => segment.quote)).toEqual(["Prvi", "šuma", "šuti"]);
    expect(result.counts.map((count) => count.n)).toEqual([1, 2]);
    expect(seen.at(-1)?.values).toEqual([null]);
    await store.exportOf(TOKEN, ID);
    expect(seen.at(-1)?.values).toEqual([ID]);
  });

  it("answers a malformed id as ZD404 before a round trip, like an unknown one", async () => {
    seen.length = 0;
    const store = createQualitativeCodingStore(fake(() => []));
    const bad = "nije-uuid";
    await expect(store.readMaterial(TOKEN, bad)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.deleteMaterial(TOKEN, bad)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.updateCode(TOKEN, bad, "A")).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.moveCode(TOKEN, bad, 1)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.deleteCode(TOKEN, bad, true)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.listSegments(TOKEN, bad)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.deleteSegment(TOKEN, bad)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.exportOf(TOKEN, bad)).rejects.toMatchObject({ code: "ZD404" });
    await expect(
      store.createSegment(TOKEN, bad, CODE, { paragraph: 0, start: 0, end: 4, quote: "Prvi" }),
    ).rejects.toMatchObject({ code: "ZD404" });
    expect(calls()).toBe(0);
  });
});
