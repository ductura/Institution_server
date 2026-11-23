// Public interface of server/settings; other areas import only this file.
export { SETTINGS_ROUTES } from "./routes.ts";
export { SETTINGS_SCHEMAS } from "./schemas.ts";
export type { SettingsService } from "./service.ts";
export {
  DEFAULT_METRICS_INTERVAL_MS,
  METRICS_INTERVAL_MAX_MS,
  METRICS_INTERVAL_MIN_MS,
  metricsIntervalMs,
  metricsIntervalProblems,
} from "./metrics-interval.ts";
export {
  INSTITUTIONS_ERROR_CODES,
  institutionsProblems,
  loadInstitutions,
} from "./institutions.ts";
export type {
  InstitutionRecord,
  InstitutionsErrorCode,
  InstitutionsResult,
} from "./institutions.ts";
export {
  deploymentProblems,
  DEPLOYMENT_VARIABLE,
  isProductionHost,
  isStagingDeployment,
  PRODUCTION_DOMAIN,
  stagingDeploymentOrigin,
} from "./deployment.ts";
export { isNonProductionBuild } from "./non-production.ts";
export { testModeProblems } from "./test-mode.ts";
