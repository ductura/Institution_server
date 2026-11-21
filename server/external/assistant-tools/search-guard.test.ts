// The search guard (Ductus ai-tools-v1, "Odlazni dohvat"; plan #1664 S3-N1 to
// S3-N4). The network is closed for the whole file: every attempt to open a
// socket, resolve a name or call fetch fails the test. Destinations are
// invented hosts under .invalid that never resolve; the transport is a fake.
import dns from "node:dns";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { SearchDestination } from "../../domain/index.ts";

import { readFacultyAiSettings } from "./faculty-config.ts";
import {
  createSearchGuard,
  FETCH_MAX_BYTES,
  isPublicAddress,
  NO_TRANSPORT,
  type SearchTransport,
} from "./search-guard.ts";

const attempts: string[] = [];
beforeAll(() => {
  const refuse = (what: string) => () => {
    attempts.push(what);
    throw new Error(`network closed in this test: ${what}`);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(refuse("fetch"));
  vi.spyOn(net, "connect").mockImplementation(refuse("net.connect"));
  vi.spyOn(net, "createConnection").mockImplementation(refuse("net.createConnection"));
  vi.spyOn(tls, "connect").mockImplementation(refuse("tls.connect"));
  vi.spyOn(http, "request").mockImplementation(refuse("http.request"));
  vi.spyOn(https, "request").mockImplementation(refuse("https.request"));
  vi.spyOn(http, "get").mockImplementation(refuse("http.get"));
  vi.spyOn(https, "get").mockImplementation(refuse("https.get"));
  vi.spyOn(dns, "lookup").mockImplementation(refuse("dns.lookup"));
  vi.spyOn(dns.promises, "lookup").mockImplementation(refuse("dns.promises.lookup"));
});
afterAll(() => {
  vi.restoreAllMocks();
  expect(attempts).toEqual([]);
});

const A: SearchDestination = {
  id: "trazilica-a",
  endpoint: "https://trazilica-a.invalid/search",
  queryParameter: "q",
};
const PUBLIC = "93.184.216.34";

type Call = { readonly kind: "resolve" | "get"; readonly value: string; readonly address?: string };

function fakeTransport(script: {
  readonly addresses?: readonly string[];
  readonly status?: number;
  readonly body?: string;
  readonly overflow?: boolean;
  readonly throwOnGet?: boolean;
}): SearchTransport & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    resolve(hostname) {
      calls.push({ kind: "resolve", value: hostname });
      return Promise.resolve(script.addresses ?? [PUBLIC]);
    },
    get(request) {
      calls.push({ kind: "get", value: request.url, address: request.address });
      if (script.throwOnGet) return Promise.reject(new Error("izmišljeni prekid"));
      const text = script.body ?? "Izmišljeni rezultat pretrage.";
      const over = new TextEncoder().encode(text).byteLength > request.maxBytes;
      return Promise.resolve({
        status: script.status ?? 200,
        text: over ? text.slice(0, request.maxBytes) : text,
        overflow: script.overflow ?? over,
      });
    },
  };
}

describe("the production guard (OC-2)", () => {
  it("the repository's setting has no destination, so search is never possible", async () => {
    const settings = readFacultyAiSettings(
      new URL("../../../config/faculties/", import.meta.url).pathname,
    );
    for (const slug of settings.faculties) {
      const guard = createSearchGuard({
        destinations: settings.searchDestinations(slug),
        transport: NO_TRANSPORT,
      });
      expect(guard.destinationIds).toEqual([]);
      expect(await guard.search("trazilica-a", "upit")).toEqual({
        kind: "failed",
        rule: "unknown_destination",
      });
    }
  });

  it("without a transport even a listed destination fails before any connection", async () => {
    const guard = createSearchGuard({ destinations: [A], transport: NO_TRANSPORT });
    expect(await guard.search("trazilica-a", "upit")).toEqual({
      kind: "failed",
      rule: "no_transport",
    });
  });
});

describe("destinations come from the server's list only (S3-N2, S3-N3)", () => {
  it("an id the list does not hold is refused, whatever it looks like", async () => {
    const transport = fakeTransport({});
    const guard = createSearchGuard({ destinations: [A], transport });
    for (const id of [
      "trazilica-b",
      "https://zlo.invalid/",
      "127.0.0.1",
      "TRAZILICA-A",
      " trazilica-a",
    ])
      expect(await guard.search(id, "upit")).toEqual({
        kind: "failed",
        rule: "unknown_destination",
      });
    expect(transport.calls).toEqual([]);
  });

  it("a destination with an endpoint outside the rules never enters the list", () => {
    const guard = createSearchGuard({
      destinations: [
        { ...A, id: "http", endpoint: "http://trazilica-a.invalid/search" },
        { ...A, id: "ip", endpoint: "https://10.0.0.1/search" },
        { ...A, id: "port", endpoint: "https://trazilica-a.invalid:8443/search" },
        A,
        { ...A, endpoint: "https://druga.invalid/search" },
      ],
      transport: fakeTransport({}),
    });
    expect(guard.destinationIds).toEqual(["trazilica-a"]);
  });

  it("a query that looks like an address is only an encoded parameter of the fixed endpoint", async () => {
    for (const query of [
      "https://zlonamjerno.invalid/put",
      "http://127.0.0.1:8080/",
      "file:///etc/passwd",
      "[::1]",
      "169.254.169.254",
      "xn--prmjer-gva.invalid",
      "a&q=drugi#frag",
      "dio izmišljenog rada: Gradsko vijeće je odlučilo …",
    ]) {
      const transport = fakeTransport({});
      const guard = createSearchGuard({ destinations: [A], transport });
      expect((await guard.search("trazilica-a", query)).kind).toBe("result");
      expect(transport.calls.map((call) => call.kind)).toEqual(["resolve", "get"]);
      expect(transport.calls[0]!.value).toBe("trazilica-a.invalid");
      const url = new URL(transport.calls[1]!.value);
      expect(url.origin + url.pathname).toBe("https://trazilica-a.invalid/search");
      expect([...url.searchParams.keys()]).toEqual(["q"]);
      expect(url.searchParams.get("q")).toBe(query);
      expect(url.hash).toBe("");
    }
  });
});

describe("resolved addresses (S3-N2)", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:a00:1::",
    "not-an-address",
    "",
  ])("%s is not public, and a listed destination resolving to it fails", async (address) => {
    expect(isPublicAddress(address)).toBe(false);
    const transport = fakeTransport({ addresses: [address] });
    const guard = createSearchGuard({ destinations: [A], transport });
    expect(await guard.search("trazilica-a", "upit")).toEqual({
      kind: "failed",
      rule: "private_address",
    });
    expect(transport.calls.map((call) => call.kind)).toEqual(["resolve"]);
  });

  it("one private answer among public ones fails the whole call (no rebinding by order)", async () => {
    const transport = fakeTransport({ addresses: [PUBLIC, "10.0.0.1"] });
    const guard = createSearchGuard({ destinations: [A], transport });
    expect(await guard.search("trazilica-a", "upit")).toEqual({
      kind: "failed",
      rule: "private_address",
    });
  });

  it("public addresses pass and the GET goes to the vetted address", async () => {
    expect(isPublicAddress(PUBLIC)).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    const transport = fakeTransport({ addresses: [PUBLIC] });
    const guard = createSearchGuard({ destinations: [A], transport });
    expect(await guard.search("trazilica-a", "upit")).toEqual({
      kind: "result",
      text: "Izmišljeni rezultat pretrage.",
    });
    expect(transport.calls[1]!.address).toBe(PUBLIC);
  });

  it("no answer or a resolver error fails", async () => {
    const empty = createSearchGuard({
      destinations: [A],
      transport: fakeTransport({ addresses: [] }),
    });
    expect(await empty.search("trazilica-a", "upit")).toEqual({
      kind: "failed",
      rule: "resolve_failed",
    });
    const broken: SearchTransport = {
      resolve: () => Promise.reject(new Error("ENOTFOUND")),
      get: () => Promise.reject(new Error("never")),
    };
    const guard = createSearchGuard({ destinations: [A], transport: broken });
    expect(await guard.search("trazilica-a", "upit")).toEqual({
      kind: "failed",
      rule: "resolve_failed",
    });
  });
});

describe("the response (S3-N3, S3-I1)", () => {
  it.each([301, 302, 303, 307, 308])("a redirect (%s) is not followed: failed", async (status) => {
    const transport = fakeTransport({ status });
    const guard = createSearchGuard({ destinations: [A], transport });
    expect(await guard.search("trazilica-a", "upit")).toEqual({ kind: "failed", rule: "redirect" });
    expect(transport.calls.filter((call) => call.kind === "get")).toHaveLength(1);
  });

  it("any other status but 200 fails", async () => {
    for (const status of [204, 404, 500]) {
      const guard = createSearchGuard({ destinations: [A], transport: fakeTransport({ status }) });
      expect(await guard.search("trazilica-a", "upit")).toEqual({ kind: "failed", rule: "status" });
    }
  });

  it("the body is bounded before it is read whole: at the bound it passes, one byte over fails", async () => {
    const atBound = createSearchGuard({
      destinations: [A],
      transport: fakeTransport({ body: "a".repeat(FETCH_MAX_BYTES) }),
    });
    expect((await atBound.search("trazilica-a", "upit")).kind).toBe("result");
    const over = createSearchGuard({
      destinations: [A],
      transport: fakeTransport({ body: "a".repeat(FETCH_MAX_BYTES + 1) }),
    });
    expect(await over.search("trazilica-a", "upit")).toEqual({ kind: "failed", rule: "too_large" });
  });

  it("a transport error fails without a throw", async () => {
    const guard = createSearchGuard({
      destinations: [A],
      transport: fakeTransport({ throwOnGet: true }),
    });
    expect(await guard.search("trazilica-a", "upit")).toEqual({
      kind: "failed",
      rule: "transport_error",
    });
  });
});

describe("the tool layer has no other way out (S3-N1)", () => {
  const dir = new URL("./", import.meta.url);
  const code = readdirSync(dir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  it.each(code)("%s opens no connection, calls no fetch and reads no secret", (name) => {
    const text = readFileSync(new URL(name, dir), "utf8");
    const imports = ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName);
    for (const spec of imports)
      expect(spec, `${name} imports ${spec}`).toMatch(/^(?:\.\.?\/|node:(?:crypto|fs|path|net)$)/u);
    expect(text).not.toMatch(
      /\bfetch\s*\(|process\.env|XMLHttpRequest|WebSocket|node:(?:http|https|tls|dgram|dns)\b/u,
    );
    // node:net only for BlockList and isIP: never a socket.
    expect(text).not.toMatch(/\b(?:connect|createConnection|Socket)\s*\(/u);
  });

  it("no function of the layer takes an address: search takes a destination id and a query", () => {
    const text = readFileSync(new URL("./search-guard.ts", dir), "utf8");
    expect(text).toMatch(/search\(destinationId: string, query: string\)/u);
    expect(text).not.toMatch(/search\([^)]*url/iu);
  });
});
