// The statistical analysis of val 15 (docs/nalazi/val15-razlika.md): pure, stateless and deterministic.
// This index is written only by SRV-V15-IZVRSITELJ.
export * from "./dataset.ts";
export * from "./fingerprint.ts";
export * from "./descriptive.ts";
export * from "./frequencies.ts";
export * from "./correlation.ts";
export { ANALYSIS_IDS, analysisSpecOf, type AnalysisId, type AnalysisSpec } from "./registry.ts";
export {
  runAnalysis,
  type AnalysisResult,
  type AnalysisRunError,
  type AnalysisRunOutcome,
  type AnalysisRunProblem,
  type AnalysisRunResponse,
} from "./run.ts";
