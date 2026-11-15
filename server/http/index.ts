// Public interface of server/http, the only composition root; only the entry
// point (server/server.ts) and test-server import it (docs/server-map.md §2).
export { AREA_NAMES, routesOf, type AreaWithRoutes } from "./areas.ts";
export { createDatabases, type Databases } from "./databases.ts";
export { HEALTH_ROUTE } from "./health.ts";
export {
  declaredLengthRefusal,
  readBodyWithLimit,
  type LimitedBodyResult,
} from "./mutation-request.ts";
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
