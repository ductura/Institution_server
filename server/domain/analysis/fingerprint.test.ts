import { describe, expect, it } from "vitest";

import { validateDataset, type Dataset } from "./dataset.ts";
import { datasetFingerprint, sha256OfJcs } from "./fingerprint.ts";

// All data here is invented.
function dataset(rows: unknown[][]): Dataset {
  const result = validateDataset({
    columns: [
      { name: "sati", kind: "numeric" },
      { name: "grupa", kind: "category" },
    ],
    rows,
  });
  if (!result.ok) throw new Error("fixture must be valid");
  return result.value;
}

async function print(d: Dataset, variables: string[]): Promise<string> {
  const r = await datasetFingerprint(d, variables);
  if (!r.ok) throw new Error("expected ok");
  return r.value;
}

const ROWS = [
  [1.5, "a"],
  [2, "š"],
  [null, null],
];

describe("datasetFingerprint", () => {
  it("is 64 lower-case hex characters", async () => {
    expect(await print(dataset(ROWS), ["sati"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same fingerprint for the same dataset", async () => {
    expect(await print(dataset(ROWS), ["sati"])).toBe(
      await print(dataset(structuredClone(ROWS)), ["sati"]),
    );
  });

  it("changes when one cell changes", async () => {
    const changed = structuredClone(ROWS);
    changed[1]![0] = 2.0000001;
    expect(await print(dataset(changed), ["sati"])).not.toBe(await print(dataset(ROWS), ["sati"]));
  });

  it("changes when a cell becomes missing, when rows are reordered, or with other variables", async () => {
    const base = await print(dataset(ROWS), ["sati"]);
    expect(await print(dataset([ROWS[0]!, ROWS[1]!, [1, null]]), ["sati"])).not.toBe(base);
    expect(await print(dataset([ROWS[1]!, ROWS[0]!, ROWS[2]!]), ["sati"])).not.toBe(base);
    expect(await print(dataset(ROWS), ["grupa"])).not.toBe(base);
  });

  it("does not depend on the order of keys in the request", async () => {
    const a = validateDataset({
      rows: ROWS,
      columns: [
        { kind: "numeric", name: "sati" },
        { kind: "category", name: "grupa" },
      ],
    });
    if (!a.ok) throw new Error("expected ok");
    expect(await print(a.value, ["sati"])).toBe(await print(dataset(ROWS), ["sati"]));
  });

  it("gives one fingerprint for -0 and 0", async () => {
    expect(await print(dataset([[-0, "a"]]), ["sati"])).toBe(
      await print(dataset([[0, "a"]]), ["sati"]),
    );
  });

  it("is a fixed value (golden): the bytes hashed are the JCS of {dataset, variables}", async () => {
    const d = dataset([[1, "a"]]);
    const expected = await sha256OfJcs({
      dataset: {
        columns: [
          { kind: "numeric", name: "sati" },
          { kind: "category", name: "grupa" },
        ],
        rows: [[1, "a"]],
      },
      variables: ["sati"],
    });
    expect(await print(d, ["sati"])).toBe(expected.ok ? expected.value : "");
    expect(await print(d, ["sati"])).toBe(
      "af6bd46e1bc14d9cd83497f67abd3751f820d3e4b9ab3e56253fe9b7c43256f9",
    );
  });
});

describe("sha256OfJcs", () => {
  it("returns a structured error, not a throw, for a value JCS refuses", async () => {
    for (const bad of [NaN, Infinity, "\ud800", { a: undefined, b: () => 1 }]) {
      const r = await sha256OfJcs(bad);
      expect(r.ok).toBe(false);
    }
  });
});
