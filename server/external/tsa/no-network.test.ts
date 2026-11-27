import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// docs/plan/ISTR-2-TSA.md §5: tests and CI never call a real TSA. The port
// itself opens no connection: it uses only the `fetch` its caller injects, so
// the only real call is from the worker of step 3, in an environment with a
// network. Only the pilot configuration names the two TSA addresses.

const DIR = new URL("./", import.meta.url);
const own = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const text = (file: string): string => readFileSync(new URL(file, DIR), "utf8");

const NETWORK_MODULE = /node:(?:https?|http2|net|tls|dgram|dns|child_process)\b/u;
// `fetch(` that is not the injected `deps.fetch(`, and globalThis.fetch.
const GLOBAL_FETCH = /(?<![.\w])fetch\s*\(|globalThis\.fetch|\bXMLHttpRequest\b|\bWebSocket\b/u;
const URL_LITERAL = /https?:\/\/[^\s"'`]+/giu;

describe("no network in the TSA port", () => {
  it("scans every source file of the port", () => {
    expect(own).toEqual(
      expect.arrayContaining(["client.ts", "config.ts", "request.ts", "verify.ts", "index.ts"]),
    );
  });

  it("imports no network module and never reaches the global fetch", () => {
    const found = own.flatMap((file) => {
      const source = text(file);
      return [
        ...(NETWORK_MODULE.test(source) ? [`${file}: network module`] : []),
        ...(GLOBAL_FETCH.test(source) ? [`${file}: global network call`] : []),
      ];
    });
    expect(found).toEqual([]);
  });

  it("names TSA addresses only in the pilot configuration", () => {
    const addresses = own.flatMap((file) =>
      [...text(file).matchAll(URL_LITERAL)].map((m) => `${file} ${m[0]}`),
    );
    expect(addresses.sort()).toEqual([
      "config.ts http://timestamp.digicert.com",
      "config.ts https://timestamp.sectigo.com",
    ]);
  });
});
