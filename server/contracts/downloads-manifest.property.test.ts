// DAN-931, review FAIL on 398a509: every url the manifest schema accepts must
// be one a client opens as written. WHATWG URL in Node must parse it and keep
// its host and path. Node does not run IDNA validation (it keeps xn--a), so
// reserved labels, punycode included, are a closed table below.
import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";

const body = ROUTES.find((r) => r.id === "downloads.manifest.get")?.responses[0]?.body;
const SHA = "0".repeat(64);
const BASE = "https://ductura.example.invalid";

function accepts(url: string): boolean {
  if (body === undefined) throw new Error("downloads.manifest.get has no 200 body");
  const row = { system: "windows", architecture: "x64", version: "1.0.0", url, sha256: SHA };
  return Value.Check(body, { packages: [row] });
}

// Labels built from pieces that hit the edges: the ACE prefix xn--, hyphens,
// digits, and punycode tails that decode to nothing valid.
const label = fc
  .array(
    fc.constantFrom("xn--", "a", "z", "0", "9", "-", "--", "x", "n", "zz", "ab", "a".repeat(30)),
    {
      minLength: 1,
      maxLength: 6,
    },
  )
  .map((parts) => parts.join(""));
const host = fc.array(label, { minLength: 2, maxLength: 4 }).map((labels) => labels.join("."));
const segment = fc
  .array(fc.constantFrom("a", ".", "..", "%2e", "%2F", "%41", "-", "_", "~", "'", "(", "@", ":"), {
    minLength: 1,
    maxLength: 4,
  })
  .map((parts) => parts.join(""));
const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => `/${s.join("/")}`);
const query = fc.option(fc.constantFrom("?v=1", "?a=%2F&b=c", "?x"), { nil: "" });

describe("an accepted manifest url", () => {
  it("is opened by WHATWG URL at the same host and path", () => {
    fc.assert(
      fc.property(fc.option(host, { nil: undefined }), path, query, (name, file, rest) => {
        const url = `${name === undefined ? "" : `https://${name}`}${file}${rest}`;
        fc.pre(accepts(url));
        const opened = new URL(url, BASE);
        expect(opened.protocol).toBe("https:");
        expect(opened.host).toBe(name ?? new URL(BASE).host);
        expect(opened.pathname).toBe(file);
        // DNS: a name of at most 253 characters, each label at most 63.
        expect(opened.hostname.length).toBeLessThanOrEqual(253);
        for (const part of opened.hostname.split(".")) expect(part.length).toBeLessThanOrEqual(63);
      }),
      { numRuns: 2000 },
    );
  });

  it.each([
    "https://xn--a.example.invalid/a.msi",
    "https://xn--.example.invalid/a.msi",
    "https://a.xn--a/a.msi",
    "https://xn--abc-.example.invalid/a.msi",
    "https://ab--c.example.invalid/a.msi",
    "https://a.zz--b/a.msi",
    "https://a.b.xn--p1ai/a.msi",
  ])("never has a reserved label (punycode included): %j", (url) => {
    expect(accepts(url)).toBe(false);
  });

  it.each([
    "https://paketi.localhost/a.msi",
    "https://a.b.localhost/a.msi",
    "https://paketi.local/a.msi",
    "https://paketi.internal/a.msi",
    "https://paketi.home.arpa/a.msi",
    "https://a.b.home.arpa/a.msi",
  ])("never names this machine or the local network: %j", (url) => {
    expect(accepts(url)).toBe(false);
  });

  it.each([
    "https://localhost.example.invalid/a.msi",
    "https://paketi.localhost-x.invalid/a.msi",
    "https://paketi.arpa/a.msi",
    "https://paketi.home.arpa.example.invalid/a.msi",
  ])("may use those words elsewhere in the name: %j", (url) => {
    expect(accepts(url)).toBe(true);
  });

  it("never has a host longer than 253 characters", () => {
    const label = "a".repeat(63);
    const host = (last: number) => `${label}.${label}.${label}.${"b".repeat(last)}`;
    expect(host(61).length).toBe(253);
    expect(accepts(`https://${host(61)}/a.msi`)).toBe(true);
    expect(accepts(`https://${host(62)}/a.msi`)).toBe(false);
    expect(accepts(`https://${host(63)}/a.msi`)).toBe(false);
    expect(accepts(`https://${host(61)}.b/a.msi`)).toBe(false);
  });

  it.each(["https://a--b.example.invalid/a.msi", "https://abc--d.example.invalid/a.msi"])(
    "may have -- outside positions 3 and 4: %j",
    (url) => {
      expect(accepts(url)).toBe(true);
    },
  );
});
