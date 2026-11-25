import { describe, expect, it } from "vitest";

import { ANALYSIS_REGISTRY } from "./registry.ts";
import { runAnalysis, type AnalysisRunOutcome } from "./run.ts";

// All data here is invented.
const COLUMNS = [
  { name: "sati", kind: "numeric" },
  { name: "bodovi", kind: "numeric" },
  { name: "grupa", kind: "category" },
];
const ROWS = [
  [1, 2, "č"],
  [2, 4, "a"],
  [3, 6, "č"],
  [4, 8.5, "a"],
  [null, 9, null],
];
const request = (over: Record<string, unknown> = {}) => ({
  analysisId: "descriptive",
  analysisVersion: "1.0.0",
  variables: ["sati", "bodovi"],
  columns: structuredClone(COLUMNS),
  rows: structuredClone(ROWS),
  ...over,
});

async function ok(input: unknown) {
  const outcome = await runAnalysis(input);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.value;
}
const errorOf = (outcome: AnalysisRunOutcome) => (outcome.ok ? undefined : outcome.error);

describe("the registry", () => {
  it("holds the three analyses at 1.0.0", () => {
    expect(ANALYSIS_REGISTRY.map((a) => [a.id, a.version])).toEqual([
      ["descriptive", "1.0.0"],
      ["frequencies", "1.0.0"],
      ["correlation", "1.0.0"],
    ]);
  });
});

describe("runAnalysis: the answer", () => {
  it("descriptive: hand-computed values, fingerprints and row count", async () => {
    const value = await ok(request());
    expect(value.analysisId).toBe("descriptive");
    expect(value.analysisVersion).toBe("1.0.0");
    expect(value.rowCount).toBe(5);
    expect(value.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(value.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(value.result.kind).toBe("descriptive");
    if (value.result.kind !== "descriptive") return;
    const [sati, bodovi] = value.result.columns;
    expect(sati).toMatchObject({
      name: "sati",
      n: 4,
      missing: 1,
      mean: 2.5,
      median: 2.5,
      min: 1,
      max: 4,
    });
    expect(sati?.sd).toBeCloseTo(1.290994, 6);
    expect(bodovi).toMatchObject({ name: "bodovi", n: 5, missing: 0, mean: 5.9, median: 6 });
  });

  it("frequencies: counts in the Croatian order, on a category and a numeric column", async () => {
    const value = await ok(request({ analysisId: "frequencies", variables: ["grupa", "sati"] }));
    if (value.result.kind !== "frequencies") throw new Error("kind");
    const [grupa] = value.result.columns;
    expect(grupa).toMatchObject({ name: "grupa", n: 4, missing: 1, otherCount: 0 });
    expect(grupa?.values.map((v) => [v.value, v.count, v.share])).toEqual([
      ["a", 2, 0.5],
      ["č", 2, 0.5],
    ]);
  });

  it("correlation: a perfect line gives r = 1 and n counts complete pairs", async () => {
    const value = await ok(
      request({
        analysisId: "correlation",
        variables: ["sati", "bodovi"],
        rows: [
          [1, 2, "a"],
          [2, 4, "a"],
          [3, 6, "a"],
          [null, 7, "a"],
        ],
      }),
    );
    expect(value.result).toEqual({
      kind: "correlation",
      pairs: [{ a: "sati", b: "bodovi", n: 3, r: 1 }],
    });
  });

  it("is frozen, and the result carries no time, randomness or identity", async () => {
    const value = await ok(request());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.result)).toBe(true);
    expect(Object.keys(value).sort()).toEqual([
      "analysisId",
      "analysisVersion",
      "datasetSha256",
      "result",
      "resultSha256",
      "rowCount",
    ]);
  });
});

describe("runAnalysis: reproducibility", () => {
  it("the same request twice gives equal bytes", async () => {
    const a = await ok(request());
    const b = await ok(request());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the order of rows changes neither the result nor its fingerprint", async () => {
    const a = await ok(request());
    const b = await ok(request({ rows: structuredClone(ROWS).reverse() }));
    expect(b.result).toEqual(a.result);
    expect(b.resultSha256).toBe(a.resultSha256);
  });

  it("the order of keys in the request changes no fingerprint", async () => {
    const a = await ok(request());
    const b = await ok({
      rows: structuredClone(ROWS),
      columns: COLUMNS.map((c) => ({ kind: c.kind, name: c.name })),
      variables: ["sati", "bodovi"],
      analysisVersion: "1.0.0",
      analysisId: "descriptive",
    });
    expect(b.datasetSha256).toBe(a.datasetSha256);
    expect(b.resultSha256).toBe(a.resultSha256);
  });

  it("one changed cell changes the dataset fingerprint, another analysis changes the result's", async () => {
    const a = await ok(request());
    const rows = structuredClone(ROWS);
    rows[0]![0] = 1.5;
    const b = await ok(request({ rows }));
    expect(b.datasetSha256).not.toBe(a.datasetSha256);
    const c = await ok(request({ analysisId: "correlation" }));
    expect(c.resultSha256).not.toBe(a.resultSha256);
  });
});

describe("runAnalysis: refuses", () => {
  it("another analysisVersion: unknown_analysis_version", async () => {
    for (const analysisVersion of ["1.0.1", "2.0.0", "0.9.0", "x"]) {
      expect(errorOf(await runAnalysis(request({ analysisVersion })))).toEqual({
        code: "unknown_analysis_version",
      });
    }
  });

  it("a variable outside the dataset", async () => {
    expect(errorOf(await runAnalysis(request({ variables: ["nema"] })))).toMatchObject({
      code: "invalid_input",
      problem: "variable_unknown",
    });
  });

  it("a variable of the wrong kind, a repeated one, too few or too many", async () => {
    const problem = async (over: Record<string, unknown>) => {
      const error = errorOf(await runAnalysis(request(over)));
      return error?.code === "invalid_input" ? error.problem : error?.code;
    };
    expect(await problem({ variables: ["grupa"] })).toBe("variable_kind");
    expect(await problem({ variables: ["sati", "sati"] })).toBe("variable_duplicate");
    expect(await problem({ analysisId: "correlation", variables: ["sati"] })).toBe(
      "variable_count",
    );
    expect(await problem({ variables: [] })).toBe("variable_count");
    expect(await problem({ variables: [1] })).toBe("variables_invalid");
    expect(await problem({ variables: "sati" })).toBe("variables_invalid");
  });

  it("a bad dataset, with the place of the problem", async () => {
    const error = errorOf(await runAnalysis(request({ rows: [[1, 2]] })));
    expect(error).toMatchObject({
      code: "invalid_input",
      problem: "dataset_invalid",
      dataset: { problem: "row_length_mismatch", row: 0 },
    });
    expect(
      errorOf(
        await runAnalysis(
          request({
            rows: [
              [1, 2, "a"],
              ["x", 2, "a"],
            ],
          }),
        ),
      ),
    ).toMatchObject({ dataset: { problem: "cell_not_numeric", row: 1, column: 0 } });
    expect(errorOf(await runAnalysis(request({ rows: [] })))).toMatchObject({
      dataset: { problem: "no_rows" },
    });
  });

  it("an unknown analysis, an unknown field, and anything that is not a request, without throwing", async () => {
    expect(errorOf(await runAnalysis(request({ analysisId: "ttest" })))).toMatchObject({
      problem: "analysis_unknown",
    });
    expect(errorOf(await runAnalysis(request({ userId: "u1" })))).toMatchObject({
      problem: "request_invalid",
    });
    for (const bad of [null, undefined, 1, "x", [], { analysisId: 1 }, Object.create(null)]) {
      expect((await runAnalysis(bad)).ok).toBe(false);
    }
    const hostile = JSON.parse('{"__proto__": {"x": 1}, "analysisId": "descriptive"}');
    expect((await runAnalysis(hostile)).ok).toBe(false);
  });

  it("does not change the request", async () => {
    const input = request();
    const before = JSON.stringify(input);
    await ok(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
