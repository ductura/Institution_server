// Public interface of server/http, the only composition root; only the entry
// point (server/server.ts) and test-server import it (docs/server-map.md §2).
export { finishLogin, LOGIN_COOKIE_NAME, startLogin, type AuthDeps } from "./auth-flow.ts";
export { AREA_NAMES, routesOf, type AreaWithRoutes } from "./areas.ts";
export { createDatabases, type Databases } from "./databases.ts";
export {
  catalogErrorFor,
  catalogErrorOf,
  ERROR_CATALOG,
  reportServerError,
  SERVER_ERROR_CLASSES,
  SESSION_EXPIRED,
  type CatalogError,
  type ServerErrorClass,
  type ServerErrorRecord,
  type ServerErrorSite,
} from "./error-catalog.ts";
export {
  createEvidenceOpenRoute,
  OPEN_MAX_BYTES,
  OPEN_PROTOCOLS,
  OPEN_TIMEOUT_MS,
  type EvidenceOpenOptions,
} from "./evidence-open.ts";
export {
  parseClosedObject,
  readEvidenceBody,
  sendEvidenceAnswer,
  type EvidenceAnswer,
  type GuardedBody,
} from "./evidence-request.ts";
export { evidenceSession, type EvidenceRefusal, type EvidenceSession } from "./evidence-session.ts";
export { CHECK_DEADLINE_MS, createHealthRoute, type HealthState } from "./health.ts";
export {
  declaredLengthRefusal,
  readBodyWithLimit,
  type LimitedBodyResult,
} from "./mutation-request.ts";
export { knownError, problemOf, sendProblem, sendRouteRefusal, type Problem } from "./problem.ts";
export { REQUEST_ID_HEADER, requestIdOf } from "./request-id.ts";
export { createRouter, routePath, type Handler, type Route, type Router } from "./router.ts";
export {
  createLayers,
  createPipeline,
  PIPELINE_STEPS,
  type App,
  type Layer,
  type Layers,
  type Step,
} from "./pipeline.ts";
export { clientIpOf, parseTrustedProxies, type TrustedProxies } from "../traffic/index.ts";
export { startServer, type Running, type StartOptions } from "./start.ts";
export {
  createShutdownCoordinator,
  FLUSH_LOGS,
  installShutdown,
  SHUTDOWN_GRACE_MS,
  type ShutdownCoordinator,
  type ShutdownHook,
} from "./shutdown.ts";
