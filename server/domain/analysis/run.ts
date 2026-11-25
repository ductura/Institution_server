// SRV-V15-IZVRSITELJ (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §3.4, §4 t. 5):
// `runAnalysis` turns the body of an analysis request into the answer: the result of
// one analysis plus the fingerprints. Pure apart from the SHA-256 (WebCrypto), no
// clock, no randomness, no identity, nothing stored, and it never throws on bad
// input: it returns a structured error. The same analysisVersion over the same
// dataset gives the same bytes. Only the version this registry holds is accepted.
import { analysisSpecOf, type AnalysisId, type AnalysisSpec } from "./registry.ts";
import { datasetFingerprint, sha256OfJcs } from "./fingerprint.ts";
import { validateDataset, type Dataset, type DatasetError } from "./dataset.ts";
import { describeNumeric, type DescriptiveColumn } from "./descriptive.ts";
import { tabulate, type FrequencyColumn } from "./frequencies.ts";
import { correlate, type CorrelationPair } from "./correlation.ts";

export type AnalysisResult =
  | { readonly kind: "descriptive"; readonly columns: readonly DescriptiveColumn[] }
  | { readonly kind: "frequencies"; readonly columns: readonly FrequencyColumn[] }
  | { readonly kind: "correlation"; readonly pairs: readonly CorrelationPair[] };

export type AnalysisRunResponse = {
  readonly analysisId: AnalysisId;
  readonly analysisVersion: string;
  readonly datasetSha256: string;
  readonly resultSha256: string;
  readonly rowCount: number;
  readonly result: AnalysisResult;
};

export type AnalysisRunError =
  | { readonly code: "unknown_analysis_version" }
  | {
      readonly code: "invalid_input";
      readonly problem: AnalysisRunProblem;
      readonly dataset?: DatasetError;
    };

export type AnalysisRunProblem =
  | "request_invalid"
  | "analysis_unknown"
  | "dataset_invalid"
  | "variables_invalid"
  | "variable_unknown"
  | "variable_duplicate"
  | "variable_count"
  | "variable_kind"
  | "unreadable";

export type AnalysisRunOutcome =
  | { readonly ok: true; readonly value: AnalysisRunResponse }
  | { readonly ok: false; readonly error: AnalysisRunError };

const REQUEST_KEYS = ["analysisId", "analysisVersion", "variables", "columns", "rows"];

function fail(problem: AnalysisRunProblem, dataset?: DatasetError): AnalysisRunOutcome {
  const error: AnalysisRunError = dataset
    ? { code: "invalid_input", problem, dataset }
    : { code: "invalid_input", problem };
  return { ok: false, error: Object.freeze(error) };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

type Chosen = { readonly name: string; readonly index: number };

/** The chosen variables as columns of the dataset, in the order the request names them. */
function chooseVariables(
  spec: AnalysisSpec,
  names: readonly unknown[],
  dataset: Dataset,
): { ok: true; chosen: readonly Chosen[] } | { ok: false; problem: AnalysisRunProblem } {
  if (names.length < spec.variables.min || names.length > spec.variables.max) {
    return { ok: false, problem: "variable_count" };
  }
  const chosen: Chosen[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") return { ok: false, problem: "variables_invalid" };
    if (seen.has(name)) return { ok: false, problem: "variable_duplicate" };
    seen.add(name);
    const index = dataset.columns.findIndex((column) => column.name === name);
    if (index < 0) return { ok: false, problem: "variable_unknown" };
    if (spec.variables.kind === "numeric" && dataset.columns[index]?.kind !== "numeric") {
      return { ok: false, problem: "variable_kind" };
    }
    chosen.push({ name, index });
  }
  return { ok: true, chosen };
}

function compute(spec: AnalysisSpec, dataset: Dataset, chosen: readonly Chosen[]): AnalysisResult {
  const cellsOf = (index: number) => dataset.rows.map((row) => row[index] ?? null);
  switch (spec.id) {
    case "descriptive":
      return {
        kind: "descriptive",
        columns: chosen.map(({ name, index }) => describeNumeric(name, cellsOf(index))),
      };
    case "frequencies":
      return {
        kind: "frequencies",
        columns: chosen.map(({ name, index }) => tabulate(name, cellsOf(index))),
      };
    case "correlation":
      return {
        kind: "correlation",
        pairs: correlate(
          chosen.map(({ name, index }) => ({
            name,
            values: cellsOf(index).map((cell) => (typeof cell === "number" ? cell : null)),
          })),
        ),
      };
  }
}

/**
 * Calculate one analysis over the dataset in `request` (the flat body of
 * `analysis.runs.post`: analysisId, analysisVersion, variables, columns, rows).
 * Unknown fields, an unknown analysis, a dataset outside the limits, a repeated,
 * unknown or wrongly typed variable are `invalid_input`; a version this registry
 * does not hold is `unknown_analysis_version`.
 */
export async function runAnalysis(request: unknown): Promise<AnalysisRunOutcome> {
  try {
    if (!isPlain(request)) return fail("request_invalid");
    if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) {
      return fail("request_invalid");
    }
    const analysisId = own(request, "analysisId");
    const analysisVersion = own(request, "analysisVersion");
    if (typeof analysisId !== "string" || typeof analysisVersion !== "string") {
      return fail("request_invalid");
    }
    const spec = analysisSpecOf(analysisId);
    if (!spec) return fail("analysis_unknown");
    if (analysisVersion !== spec.version)
      return { ok: false, error: { code: "unknown_analysis_version" } };

    const variables = own(request, "variables");
    if (!Array.isArray(variables)) return fail("variables_invalid");

    const checked = validateDataset({
      columns: own(request, "columns"),
      rows: own(request, "rows"),
    });
    if (!checked.ok) return fail("dataset_invalid", checked.error);
    const dataset = checked.value;

    const choice = chooseVariables(spec, variables as unknown[], dataset);
    if (!choice.ok) return fail(choice.problem);

    const names = choice.chosen.map((c) => c.name);
    const datasetSha256 = await datasetFingerprint(dataset, names);
    if (!datasetSha256.ok) return fail("unreadable");
    const result = compute(spec, dataset, choice.chosen);
    const resultSha256 = await sha256OfJcs(result);
    if (!resultSha256.ok) return fail("unreadable");

    return {
      ok: true,
      value: deepFreeze({
        analysisId: spec.id,
        analysisVersion: spec.version,
        datasetSha256: datasetSha256.value,
        resultSha256: resultSha256.value,
        rowCount: dataset.rows.length,
        result,
      }),
    };
  } catch {
    return fail("unreadable");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
