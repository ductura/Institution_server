// The values of the security headers (security-headers.ts), apart so that
// problem.ts can keep them on an error answer without an import cycle.
export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] =
  Object.freeze([
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Ignored over plain http (RFC 6797 §8.1); it acts behind TLS.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), display-capture=(), clipboard-write=(self)",
    },
    // API responses carry no markup to run; nothing may load from them.
    {
      key: "Content-Security-Policy",
      value: "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
    { key: "Cache-Control", value: "no-store" },
  ]);
