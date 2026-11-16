// Public interface of server/traffic; other areas import only this file.
export { TRAFFIC_ROUTES } from "./routes.ts";
export { TRAFFIC_SCHEMAS } from "./schemas.ts";
export type { TrafficService } from "./service.ts";
export {
  clientIpLayer,
  clientIpOf,
  NO_TRUSTED_PROXIES,
  parseTrustedProxies,
  type TrustedProxies,
} from "./client-ip.ts";
export {
  checkRateLimits,
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CLASSES,
  type ClassLimits,
  type RateLimitClass,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimits,
} from "./rate-limit.ts";
