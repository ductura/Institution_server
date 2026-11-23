// Public interface of server/http/security (SRV-1401, DAN-296, M1.6): the
// enforced security headers and idle expiry on the routes that need a session.
// headers.ts comes first: security-header-values.ts reads its values while
// server/http loads, and it imports nothing from server/http.
export {
  CONTENT_SECURITY_POLICY,
  CSP_HEADER,
  DEPLOYMENT_HEADER,
  ENFORCED_HEADER_NAMES,
  enforcedHeaders,
  enforceSecurityHeaders,
  HSTS_HEADER,
  PERMISSIONS_POLICY,
  PERMISSIONS_POLICY_HEADER,
  PRODUCTION_SECURITY,
  STAGING_DEPLOYMENT,
  STRICT_TRANSPORT_SECURITY,
  type SecurityMode,
} from "./headers.ts";
export { guardIdleSessions, IDLE_EXEMPT_ROUTE_IDS, needsIdleCheck } from "./idle-guard.ts";
