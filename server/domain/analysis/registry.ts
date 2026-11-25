// SRV-V15-IZVRSITELJ (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §4 t. 5): the
// registry of analyses the server can calculate. Each entry has an id from a closed
// list, a version of its algorithm and the columns it takes. The version changes with
// every change of the numerics (the golden vectors of SRV-V15-PONOVLJIVOST then
// fail until it does). The catalogue route reports the same ids, versions and
// variable rules (a test of the HTTP task asserts that they are equal).

export const ANALYSIS_IDS = ["descriptive", "frequencies", "correlation"] as const;
export type AnalysisId = (typeof ANALYSIS_IDS)[number];

export type AnalysisSpec = {
  readonly id: AnalysisId;
  /** `major.minor.patch` of the algorithm. */
  readonly version: string;
  readonly variables: {
    /** `numeric`: only numeric columns; `any`: numeric and category columns. */
    readonly kind: "numeric" | "any";
    readonly min: number;
    readonly max: number;
  };
};

const MAX_VARIABLES = 12;

export const ANALYSIS_REGISTRY: readonly AnalysisSpec[] = Object.freeze([
  Object.freeze({
    id: "descriptive",
    version: "1.0.0",
    variables: Object.freeze({ kind: "numeric", min: 1, max: MAX_VARIABLES }),
  }),
  Object.freeze({
    id: "frequencies",
    version: "1.0.0",
    variables: Object.freeze({ kind: "any", min: 1, max: MAX_VARIABLES }),
  }),
  Object.freeze({
    id: "correlation",
    version: "1.0.0",
    variables: Object.freeze({ kind: "numeric", min: 2, max: MAX_VARIABLES }),
  }),
]);

export function analysisSpecOf(id: string): AnalysisSpec | undefined {
  return ANALYSIS_REGISTRY.find((spec) => spec.id === id);
}
