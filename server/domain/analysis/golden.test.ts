// SRV-V15-PONOVLJIVOST (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §3.4, §4 t. 7):
// golden vectors of reproducibility. Each file in `golden/` holds an invented dataset,
// the request over it and the exact answer of `runAnalysis`: `result`, `datasetSha256`,
// `resultSha256`. The tests compare bytes (the JCS of the answer), and tie the answers
// to the version of the analysis: `golden/versions.json` records, per analysis and
// version, the SHA-256 of its vectors' expected answers. Changing the numerics (or an
// expected answer) under the same version fails; the way forward is to raise the
// version in `registry.ts`, regenerate the vectors and add the new entry to
// `versions.json` (keep the old entries). All data here is invented.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalizeJcs, sha256WebCrypto } from "../forensics/index.ts";
import { ANALYSIS_REGISTRY } from "./registry.ts";
import { runAnalysis } from "./run.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

type Vector = {
  readonly id: string;
  readonly description: string;
  readonly request: {
    readonly analysisId: string;
    readonly analysisVersion: string;
    readonly variables: readonly string[];
    readonly columns: readonly { readonly name: string; readonly kind: string }[];
    readonly rows: readonly (readonly unknown[])[];
  };
  readonly expected: {
    readonly analysisId: string;
    readonly analysisVersion: string;
    readonly rowCount: number;
    readonly datasetSha256: string;
    readonly resultSha256: string;
    readonly result: unknown;
  };
};

const FILES = readdirSync(DIR)
  .filter((name) => name.endsWith(".json") && name !== "versions.json")
  .sort();
const VECTORS: readonly Vector[] = FILES.map(
  (name) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as Vector,
);
const LOCK = JSON.parse(readFileSync(join(DIR, "versions.json"), "utf8")) as Record<
  string,
  Record<string, string>
>;

async function answerBytes(request: unknown): Promise<string> {
  const outcome = await runAnalysis(request);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return canonicalizeJcs(outcome.value);
}

/** The same request with every object's keys in reverse order (arrays keep theirs). */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, reverseKeys(inner)]),
    );
  }
  return value;
}

describe("golden vectors: the files", () => {
  it("cover the three analyses and the awkward inputs val 15 names", () => {
    expect(new Set(VECTORS.map((v) => v.request.analysisId))).toEqual(
      new Set(["descriptive", "frequencies", "correlation"]),
    );
    expect(FILES).toEqual(
      expect.arrayContaining([
        "small-descriptive.json",
        "missing-descriptive.json",
        "croatian-frequencies.json",
        "negative-descriptive.json",
        "rounding-descriptive.json",
      ]),
    );
    expect(VECTORS.map((v) => `${v.id}.json`)).toEqual(FILES);
  });

  it("hold only invented data: no e-mail, OIB or student number", () => {
    const text = FILES.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\b\d{11}\b/);
    expect(text).not.toMatch(/jmbag/i);
  });
});

describe.each(VECTORS.map((v) => [v.id, v] as const))("golden vector %s", (_id, vector) => {
  it("runAnalysis gives exactly the recorded bytes", async () => {
    expect(await answerBytes(vector.request)).toBe(canonicalizeJcs(vector.expected));
  });

  it("gives the same bytes the second time and for a fresh copy of the request", async () => {
    const first = await answerBytes(vector.request);
    expect(await answerBytes(structuredClone(vector.request))).toBe(first);
    expect(await answerBytes(vector.request)).toBe(first);
  });

  it("does not depend on the order of keys in the request", async () => {
    const outcome = await runAnalysis(reverseKeys(vector.request));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.datasetSha256).toBe(vector.expected.datasetSha256);
    expect(outcome.value.resultSha256).toBe(vector.expected.resultSha256);
    expect(canonicalizeJcs(outcome.value)).toBe(canonicalizeJcs(vector.expected));
  });

  it("does not depend on the order of rows (result and resultSha256)", async () => {
    const reversed = { ...vector.request, rows: [...vector.request.rows].reverse() };
    const outcome = await runAnalysis(reversed);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(canonicalizeJcs(outcome.value.result)).toBe(canonicalizeJcs(vector.expected.result));
    expect(outcome.value.resultSha256).toBe(vector.expected.resultSha256);
  });

  it("changes datasetSha256 when one cell changes", async () => {
    const rows = structuredClone(vector.request.rows) as unknown[][];
    const row = rows[0] as unknown[];
    const column = vector.request.columns.findIndex((c) => c.name === vector.request.variables[0]);
    const cell = row[column];
    row[column] = typeof cell === "number" ? cell + 1 : cell === null ? 1 : `${String(cell)}x`;
    const outcome = await runAnalysis({ ...vector.request, rows });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.datasetSha256).not.toBe(vector.expected.datasetSha256);
  });

  it("is a vector of the version the registry holds", () => {
    const spec = ANALYSIS_REGISTRY.find((a) => a.id === vector.request.analysisId);
    expect(spec?.version).toBe(vector.request.analysisVersion);
    expect(vector.expected.analysisVersion).toBe(vector.request.analysisVersion);
  });

  it("a different analysisVersion is refused, not calculated", async () => {
    const outcome = await runAnalysis({ ...vector.request, analysisVersion: "1.0.1" });
    expect(outcome).toEqual({ ok: false, error: { code: "unknown_analysis_version" } });
  });

  it("a changed expectation would fail the comparison", async () => {
    const tampered = structuredClone(vector.expected) as { rowCount: number };
    tampered.rowCount += 1;
    expect(await answerBytes(vector.request)).not.toBe(canonicalizeJcs(tampered));
  });
});

describe("golden vectors: the vector does not change without a new analysis version", () => {
  it.each(ANALYSIS_REGISTRY.map((spec) => [spec.id, spec] as const))(
    "%s: the digest of its expected answers matches versions.json for its version",
    async (id, spec) => {
      const mine = VECTORS.filter((v) => v.request.analysisId === id)
        .map((v) => ({ id: v.id, expected: v.expected }))
        .sort((a, b) => a.id.localeCompare(b.id, "en"));
      expect(mine.length).toBeGreaterThan(0);
      const digest = await sha256WebCrypto(canonicalizeJcs(mine));
      const recorded = LOCK[id]?.[spec.version];
      expect(
        recorded,
        `no entry for ${id} ${spec.version} in golden/versions.json: regenerate the vectors and add the entry`,
      ).toBeDefined();
      expect(
        digest,
        `the expected answers of ${id} changed under version ${spec.version}: raise the version in registry.ts`,
      ).toBe(recorded);
    },
  );

  it("versions.json has no entry for an analysis or a later version the registry lacks", () => {
    const ids = ANALYSIS_REGISTRY.map((a) => a.id).sort();
    expect(Object.keys(LOCK).sort()).toEqual(ids);
    for (const spec of ANALYSIS_REGISTRY) {
      expect(Object.keys(LOCK[spec.id] ?? {})).toContain(spec.version);
    }
  });
});
