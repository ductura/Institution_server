// The values of the security headers (security-headers.ts), apart so that
// problem.ts can keep them on an error answer without an import cycle. CSP,
// Permissions-Policy and HSTS come from security/ (SRV-1401), which also
// enforces them on every answer; in local mode HSTS is removed there.
import {
  CONTENT_SECURITY_POLICY,
  CSP_HEADER,
  HSTS_HEADER,
  PERMISSIONS_POLICY,
  PERMISSIONS_POLICY_HEADER,
  STRICT_TRANSPORT_SECURITY,
} from "./security/index.ts";

export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] =
  Object.freeze([
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: HSTS_HEADER, value: STRICT_TRANSPORT_SECURITY },
    { key: PERMISSIONS_POLICY_HEADER, value: PERMISSIONS_POLICY },
    { key: CSP_HEADER, value: CONTENT_SECURITY_POLICY },
    { key: "Cache-Control", value: "no-store" },
  ]);
