import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// SRV-V22-ISVU-PORT: the ISVU adapter opens no network, names no ISVU or
// Studomat address and takes no secret. The only adapter is the synthetic
// one (Ductus docs/nalazi/val22-razlika.md §3 t. 1; pattern of
// server/external/assistant/no-external-ai.test.ts).

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
const SOURCE = /\.(?:ts|mts|cts|js|mjs|cjs|sql|json|ya?ml|sh)$/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SOURCE.test(entry.name)) out.push(relative(ROOT, path));
  }
  return out;
}

const files = walk(ROOT).filter((file) => file !== SELF);
const own = files.filter((f) => f.startsWith("server/external/isvu/") && !f.endsWith(".test.ts"));

const NETWORK_MODULE = /node:(?:https?|http2|net|tls|dgram|dns|worker_threads|child_process)\b/u;
const NETWORK_CALL =
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*[(.]|\bnew\s+(?:WebSocket|EventSource)\b/u;
const URL_LITERAL = /https?:\/\//iu;
const SECRET_WORD = /\b(?:password|passwd|lozinka|api[_-]?key|secret|token)\b/iu;
const ISVU_HOST =
  /\b(?:[a-z0-9-]+\.)*(?:isvu\.(?:hr|srce\.hr)|studomat\.(?:hr|srce\.hr)|isvu\.srce\.hr)\b/iu;
const ISVU_PACKAGE = /"(?:@?[a-z0-9-]*\/)?[a-z0-9-]*(?:isvu|studomat)[a-z0-9-]*"\s*:/iu;

describe("no real ISVU in this repo", () => {
  it("scans the adapter and the repo", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(own).toEqual(
      expect.arrayContaining([
        "server/external/isvu/port.ts",
        "server/external/isvu/setting.ts",
        "server/external/isvu/synthetic-isvu.ts",
      ]),
    );
  });

  it("the adapter imports no network module, calls no network and has no address", () => {
    const found: string[] = [];
    for (const file of own) {
      const text = readFileSync(join(ROOT, file), "utf8");
      if (NETWORK_MODULE.test(text)) found.push(`${file}: network module`);
      if (NETWORK_CALL.test(text)) found.push(`${file}: network call`);
      if (URL_LITERAL.test(text)) found.push(`${file}: address`);
    }
    expect(found).toEqual([]);
  });

  it("the adapter has no password, token or key field", () => {
    const code = (file: string) =>
      readFileSync(join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
    const found = own.filter((file) => SECRET_WORD.test(code(file)));
    expect(found).toEqual([]);
  });

  it("no source file names an ISVU or Studomat address", () => {
    const found = files.filter((file) => ISVU_HOST.test(readFileSync(join(ROOT, file), "utf8")));
    expect(found).toEqual([]);
  });

  it("no package.json depends on an ISVU or Studomat package", () => {
    const found = files
      .filter((file) => file.endsWith("package.json"))
      .filter((file) => ISVU_PACKAGE.test(readFileSync(join(ROOT, file), "utf8")));
    expect(found).toEqual([]);
  });
});
