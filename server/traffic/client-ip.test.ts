// Client IP (S-1C.1, DAN-790; contract Ductus#1836 c.6900102277). Only
// documentation addresses: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 and
// 2001:db8::/32.
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import {
  clientIpLayer,
  clientIpOf,
  MAX_FORWARDED_HOPS,
  MAX_TRUSTED_PROXIES,
  NO_TRUSTED_PROXIES,
  parseTrustedProxies,
  resolveClientIp,
  type TrustedProxies,
} from "./client-ip.ts";

function trust(text: string): TrustedProxies {
  const list = parseTrustedProxies(text);
  if (list === null) throw new Error("bad test list");
  return list;
}

const PROXY = "192.0.2.10";
const PROXIES = trust("192.0.2.10, 198.51.100.0/24, 2001:db8:1::/48");
const CLIENT = "203.0.113.7";

describe("parseTrustedProxies", () => {
  it("unset or blank is the empty list", () => {
    expect(parseTrustedProxies(undefined)).toBe(NO_TRUSTED_PROXIES);
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies("  \t ")).toEqual([]);
  });

  it("takes addresses and CIDR ranges of both families", () => {
    expect(
      parseTrustedProxies("192.0.2.10,198.51.100.0/24 , 2001:db8::/32,2001:db8::1"),
    ).toHaveLength(4);
    expect(parseTrustedProxies("::ffff:192.0.2.1, ::ffff:198.51.100.0/120")).toHaveLength(2);
    expect(Object.isFrozen(PROXIES)).toBe(true);
  });

  it.each([
    ["a bad address", "192.0.2.256"],
    ["a name", "proxy.invalid"],
    ["an empty entry", "192.0.2.10,,198.51.100.1"],
    ["a trailing comma", "192.0.2.10,"],
    ["/0 for IPv4", "0.0.0.0/0"],
    ["/0 for IPv6", "::/0"],
    ["a prefix too long", "192.0.2.0/33"],
    ["an IPv6 prefix too long", "2001:db8::/129"],
    ["IPv4 broader than /8", "0.0.0.0/1"],
    ["IPv4 /7", "192.0.0.0/7"],
    ["IPv6 broader than /16", "8000::/1"],
    ["IPv6 /15", "2000::/15"],
    ["a mapped range broader than /8", "::ffff:0:0/97"],
    ["host bits", "192.0.2.5/24"],
    ["IPv6 host bits", "2001:db8::1/32"],
    ["a mapped range shorter than /96", "::ffff:0:0/95"],
    ["a mapped /96 (all of IPv4)", "::ffff:0:0/96"],
    ["a leading zero prefix", "192.0.2.0/024"],
    ["an empty prefix", "192.0.2.0/"],
    ["a port", "192.0.2.10:80"],
    ["brackets", "[2001:db8::1]"],
    ["a zone", "2001:db8::1%eth0"],
    ["a leading zero octet", "192.0.02.1"],
  ])("refuses %s", (_name, text) => {
    expect(parseTrustedProxies(text)).toBeNull();
  });

  it("takes the broadest allowed ranges", () => {
    expect(parseTrustedProxies("192.0.0.0/8, 2001::/16, ::ffff:192.0.0.0/104")).toHaveLength(3);
  });

  it(`refuses more than ${MAX_TRUSTED_PROXIES} entries`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `192.0.2.${i}`).join(",");
    expect(parseTrustedProxies(many(MAX_TRUSTED_PROXIES))).toHaveLength(MAX_TRUSTED_PROXIES);
    expect(parseTrustedProxies(many(MAX_TRUSTED_PROXIES + 1))).toBeNull();
  });
});

describe("resolveClientIp", () => {
  it("ignores a forged header when the peer is not a trusted proxy", () => {
    expect(resolveClientIp(CLIENT, "198.51.100.99", PROXIES)).toBe(CLIENT);
    expect(resolveClientIp(CLIENT, "192.0.2.10", PROXIES)).toBe(CLIENT);
  });

  it("never reads the header with an empty list", () => {
    expect(resolveClientIp(PROXY, CLIENT, NO_TRUSTED_PROXIES)).toBe(PROXY);
    expect(resolveClientIp("198.51.100.1", CLIENT, NO_TRUSTED_PROXIES)).toBe("198.51.100.1");
  });

  it("takes the header from a trusted proxy", () => {
    expect(resolveClientIp(PROXY, CLIENT, PROXIES)).toBe(CLIENT);
  });

  it("takes the first untrusted address from the right in a chain", () => {
    const chain = `198.51.100.250, ${CLIENT}, 198.51.100.3, 2001:db8:1::5`;
    expect(resolveClientIp(PROXY, chain, PROXIES)).toBe(CLIENT);
    // What the client wrote itself, left of its own address, never counts.
    expect(resolveClientIp(PROXY, `203.0.113.200, ${CLIENT}`, PROXIES)).toBe(CLIENT);
  });

  it("joins repeated headers in order", () => {
    expect(resolveClientIp(PROXY, ["203.0.113.1", "198.51.100.3"], PROXIES)).toBe("203.0.113.1");
  });

  it("takes the leftmost entry when every hop is trusted", () => {
    expect(resolveClientIp(PROXY, "198.51.100.1, 198.51.100.2", PROXIES)).toBe("198.51.100.1");
  });

  it("keeps the peer for an absent or empty header", () => {
    expect(resolveClientIp(PROXY, undefined, PROXIES)).toBe(PROXY);
    expect(resolveClientIp(PROXY, "", PROXIES)).toBe(PROXY);
    expect(resolveClientIp(PROXY, " \t", PROXIES)).toBe(PROXY);
  });

  it("stops at a bad entry with the nearest trusted hop", () => {
    expect(resolveClientIp(PROXY, "unknown", PROXIES)).toBe(PROXY);
    expect(resolveClientIp(PROXY, "garbage, 198.51.100.4", PROXIES)).toBe("198.51.100.4");
    expect(resolveClientIp(PROXY, `${CLIENT}, `, PROXIES)).toBe(PROXY);
  });

  it("does not let client garbage left of an untrusted address reach a proxy", () => {
    expect(resolveClientIp(PROXY, `garbage, ${CLIENT}`, PROXIES)).toBe(CLIENT);
    expect(resolveClientIp(PROXY, `${"x".repeat(8000)}, ${CLIENT}`, PROXIES)).toBe(CLIENT);
  });

  it("refuses an entry longer than any address, padding aside", () => {
    expect(resolveClientIp(PROXY, `${" ".repeat(500)}${CLIENT}\t\t`, PROXIES)).toBe(CLIENT);
    expect(resolveClientIp(PROXY, `[2001:db8:2::1]:443${"0".repeat(40)}`, PROXIES)).toBe(PROXY);
  });

  it("trims a long run of spaces in linear time (adversarial pass on DAN-790)", () => {
    // The quadratic trim took about 300 ms here; linear work is well under 1 ms.
    const entry = `1${" ".repeat(16_000)}1`;
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) expect(resolveClientIp(PROXY, entry, PROXIES)).toBe(PROXY);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it(`walks at most ${MAX_FORWARDED_HOPS} entries`, () => {
    const hops = (n: number) => Array.from({ length: n }, (_, i) => `198.51.100.${i + 1}`);
    expect(
      resolveClientIp(PROXY, [CLIENT, ...hops(MAX_FORWARDED_HOPS - 1)].join(","), PROXIES),
    ).toBe(CLIENT);
    const long = [CLIENT, ...hops(MAX_FORWARDED_HOPS)].join(",");
    expect(resolveClientIp(PROXY, long, PROXIES)).toBe(`198.51.100.1`);
    const huge = `${Array<string>(10_000).fill(CLIENT).join(",")},${hops(3).join(",")}`;
    expect(resolveClientIp(PROXY, huge, PROXIES)).toBe(CLIENT);
  });

  it("treats IPv4, IPv6 and IPv4-mapped IPv6 the same", () => {
    expect(resolveClientIp("::ffff:192.0.2.10", CLIENT, PROXIES)).toBe(CLIENT);
    expect(resolveClientIp("::ffff:203.0.113.7", "198.51.100.1", PROXIES)).toBe(CLIENT);
    expect(resolveClientIp(PROXY, "::ffff:203.0.113.7", PROXIES)).toBe(CLIENT);
    expect(resolveClientIp(PROXY, "::ffff:cb00:7107", PROXIES)).toBe(CLIENT);
    expect(resolveClientIp(PROXY, "::FFFF:198.51.100.3", PROXIES)).toBe("198.51.100.3");
    expect(resolveClientIp("2001:DB8:1:0::9", "2001:db8:2::7", PROXIES)).toBe("2001:db8:2::7");
    expect(resolveClientIp("2001:db8:1::9", "2001:DB8:0:0:0:0:0:1", PROXIES)).toBe("2001:db8::1");
    // A different spelling of a trusted IPv6 address is still trusted.
    expect(resolveClientIp(PROXY, `${CLIENT}, 2001:0db8:0001:0000::5`, PROXIES)).toBe(CLIENT);
    const mapped = trust("::ffff:192.0.2.0/120");
    expect(resolveClientIp("192.0.2.77", CLIENT, mapped)).toBe(CLIENT);
  });

  it("writes IPv6 in RFC 5952 form", () => {
    const all = trust("2001:db8::/32");
    const cases: [string, string][] = [
      ["2001:0db8:0000:0000:0001:0000:0000:0001", "2001:db8::1:0:0:1"],
      ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
      ["2001:db8::", "2001:db8::"],
      ["2001:db8:0:0:0:0:0:0", "2001:db8::"],
      ["2001:db8:1:0:0:1:0:0", "2001:db8:1::1:0:0"],
      ["2001:db8:0:0:1::1", "2001:db8::1:0:0:1"],
    ];
    for (const [entry, out] of cases) expect(resolveClientIp("2001:db8::a", entry, all)).toBe(out);
  });

  it.each([
    ["IPv4 with a port", "203.0.113.7:4711", CLIENT],
    ["bracketed IPv6", "[2001:db8:2::1]", "2001:db8:2::1"],
    ["bracketed IPv6 with a port", "[2001:db8:2::1]:443", "2001:db8:2::1"],
    ["spaces and tabs around", " \t203.0.113.7\t ", CLIENT],
  ])("accepts %s", (_name, entry, out) => {
    expect(resolveClientIp(PROXY, entry, PROXIES)).toBe(out);
  });

  it.each([
    ["a zone id", "2001:db8:2::1%eth0"],
    ["a space inside", "203.0.113. 7"],
    ["port 0", "203.0.113.7:0"],
    ["a port too big", "203.0.113.7:65536"],
    ["an empty port", "203.0.113.7:"],
    ["a bare IPv6 with a port", "2001:db8::1:443:"],
    ["bracketed IPv4", "[203.0.113.7]"],
    ["an unclosed bracket", "[2001:db8::1"],
    ["junk after brackets", "[2001:db8::1]x"],
    ["an obfuscated node", "_hidden"],
    ["hex IPv4", "0xcb.0.113.7"],
    ["octal IPv4", "0313.0.113.7"],
    ["short IPv4", "203.7"],
    ["integer IPv4", "3405803783"],
    ["two double colons", "2001::db8::1"],
    ["a group too long", "2001:db8::12345"],
    ["nine groups", "1:2:3:4:5:6:7:8:9"],
    ["a mapped tail with a leading zero", "::ffff:203.0.113.07"],
    ["a quoted address", '"203.0.113.7"'],
    ["a newline", "203.0.113.7\n"],
    ["a non-ASCII digit", "203.0.113.٧"],
    ["a node name", "for=203.0.113.7"],
  ])("refuses %s and keeps the proxy", (_name, entry) => {
    expect(resolveClientIp(PROXY, entry, PROXIES)).toBe(PROXY);
  });

  it("has no address without a usable peer", () => {
    expect(resolveClientIp(undefined, CLIENT, PROXIES)).toBeNull();
    expect(resolveClientIp("", CLIENT, PROXIES)).toBeNull();
  });

  it("drops the zone of the peer", () => {
    expect(resolveClientIp("2001:db8::1%eth0", CLIENT, NO_TRUSTED_PROXIES)).toBe("2001:db8::1");
  });
});

describe("clientIpLayer", () => {
  function request(remote: string | undefined, headers: Record<string, string>): IncomingMessage {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: remote });
    const message = new IncomingMessage(socket);
    message.headers = headers;
    return message;
  }

  it("records the client IP and lets the request through", async () => {
    const message = request(PROXY, { "x-forwarded-for": CLIENT });
    expect(clientIpOf(message)).toBeNull();
    await expect(clientIpLayer(PROXIES)(message)).resolves.toBe("next");
    expect(clientIpOf(message)).toBe(CLIENT);
  });

  it("reads no other header, even from a trusted proxy", async () => {
    const message = request(PROXY, {
      forwarded: "for=203.0.113.9",
      "x-real-ip": "203.0.113.9",
      "true-client-ip": "203.0.113.9",
      "cf-connecting-ip": "203.0.113.9",
    });
    await clientIpLayer(PROXIES)(message);
    expect(clientIpOf(message)).toBe(PROXY);
  });

  it("touches no header unless the peer is a trusted proxy (Codex CLI review)", async () => {
    const read = async (remote: string, list: TrustedProxies): Promise<string[]> => {
      const message = request(remote, {});
      const keys: string[] = [];
      const headers = new Proxy(
        { "x-forwarded-for": CLIENT },
        {
          get: (target, key, receiver) => {
            keys.push(String(key));
            return Reflect.get(target, key, receiver) as unknown;
          },
          has: (target, key) => {
            keys.push(String(key));
            return Reflect.has(target, key);
          },
          ownKeys: (target) => {
            keys.push("*");
            return Reflect.ownKeys(target);
          },
        },
      );
      Object.defineProperty(message, "headers", {
        get: () => {
          keys.push("headers");
          return headers;
        },
      });
      await clientIpLayer(list)(message);
      return keys;
    };
    expect(await read(PROXY, NO_TRUSTED_PROXIES)).toEqual([]);
    expect(await read(CLIENT, PROXIES)).toEqual([]);
    expect(await read(PROXY, PROXIES)).toEqual(["headers", "x-forwarded-for"]);
  });

  it("records null without a peer and never throws", async () => {
    const message = request(undefined, { "x-forwarded-for": CLIENT });
    await expect(clientIpLayer(PROXIES)(message)).resolves.toBe("next");
    expect(clientIpOf(message)).toBeNull();
    const broken = request(PROXY, {});
    Object.defineProperty(broken, "headers", {
      get: () => {
        throw new Error("boom");
      },
    });
    await expect(clientIpLayer(PROXIES)(broken)).resolves.toBe("next");
    expect(clientIpOf(broken)).toBeNull();
  });
});
