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
