// SRV-1401 acceptance 4: no route sets its own Content-Security-Policy (nor
// Permissions-Policy or HSTS). The runtime already overrides any such value
// (security.integration.test.ts); this keeps the names out of route code, so
// nobody writes a policy believing it takes effect.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ENFORCED_HEADER_NAMES } from "./index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SERVER = join(ROOT, "server");

// The only production files that may name the enforced headers.
const ALLOWED = new Set(["server/http/security-header-values.ts"]);
const ALLOWED_DIR = "server/http/security/";
const TEST_FILE = /\.(test|property\.test|integration\.test|pg\.integration\.test)\.ts$/u;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const posix = (path: string) => relative(ROOT, path).split(sep).join("/");

/**
 * Production files under server/ that name an enforced header in a string
 * (the only way to set one; hyphens rule out a bare key), outside the allowed
 * ones. Comments may still mention the names.
 */
function namingFiles(files: readonly string[], read: (file: string) => string): string[] {
  return files.filter((file) => {
    if (ALLOWED.has(file) || file.startsWith(ALLOWED_DIR) || TEST_FILE.test(file)) return false;
    const text = read(file).toLowerCase();
    return ENFORCED_HEADER_NAMES.some((name) =>
      ['"', "'", "`"].some((quote) => text.includes(`${quote}${name}`)),
    );
  });
}

describe("no route sets its own security policy (SRV-1401)", () => {
  it("names CSP, Permissions-Policy and HSTS only in server/http/security", () => {
    const files = sources(SERVER).map(posix);
    expect(files.length).toBeGreaterThan(100);
    expect(namingFiles(files, (file) => readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
  });

  it("finds a route file that names one in a string, in any letter case", () => {
    const text: Record<string, string> = {
      "server/http/some-route.ts": 'response.setHeader("content-SECURITY-policy", "x")',
      "server/http/other.ts": "// a comment on Content-Security-Policy",
      "server/http/some-route.test.ts": '"Content-Security-Policy"',
      "server/http/head.ts": "res.writeHead(200, { 'Permissions-Policy': 'camera=*' })",
    };
    expect(namingFiles(Object.keys(text), (file) => text[file] ?? "")).toEqual([
      "server/http/some-route.ts",
      "server/http/head.ts",
    ]);
  });
});
