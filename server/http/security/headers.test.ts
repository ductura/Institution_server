// Port of Ductus src/server/http/content-security-policy.test.ts (DAN-489),
// the part that has an equivalent here: the API policy. The page policy
// (nonce, THEME_SCRIPT hash, form-action for the issuer, next dev) belongs to
// the pages, which this server does not render; docs/plan/osnovica-b/OSN-B4.md
// lists each case that was not carried over and why.
import { describe, expect, it } from "vitest";

import {
  CONTENT_SECURITY_POLICY,
  CSP_HEADER,
  enforcedHeaders,
  PRODUCTION_SECURITY,
} from "./index.ts";

const API_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

describe("API Content-Security-Policy (DAN-489)", () => {
  it("lets nothing load and nothing frame an API response", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(API_POLICY);
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe");
  });

  it("is the policy the server enforces in both modes", () => {
    for (const mode of [PRODUCTION_SECURITY, { local: true }]) {
      const csp = enforcedHeaders(mode).filter(({ key }) => key === CSP_HEADER);
      expect(csp).toEqual([{ key: CSP_HEADER, value: API_POLICY }]);
    }
  });
});
