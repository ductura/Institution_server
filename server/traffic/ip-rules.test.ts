// The IP rules of operator paths (S-1C.2, DAN-832-1; contract Ductus#1836).
// Addresses come from the documentation ranges only.
import { describe, expect, it } from "vitest";

import { isOpsPath, NO_ALLOWED_NETWORKS, networkAllows, parseAllowedNetworks } from "./ip-rules.ts";

const NETS = parseAllowedNetworks("192.0.2.0/24, 2001:db8::/32");

describe("parseAllowedNetworks refuses every unusable value", () => {
  it.each([
    ["CRLF", "192.0.2.0/24\r\n"],
    ["LF between entries", "192.0.2.0/24\n,198.51.100.0/24"],
    ["tab", "\t192.0.2.0/24"],
    ["NBSP", "192.0.2.0/24\u00a0"],
    ["DEL", "192.0.2.0/24\u007f"],
    ["zone id", "fe80::1%eth0"],
    ["brackets", "[2001:db8::1]"],
    ["port", "192.0.2.1:80"],
    ["prefix too long", "192.0.2.0/33"],
    ["prefix with sign", "192.0.2.0/+24"],
    ["host bits", "192.0.2.1/24"],
    ["IPv4 broader than /8", "10.0.0.0/7"],
    ["IPv4 everything", "0.0.0.0/0"],
    ["IPv6 everything", "::/0"],
    ["leading zero", "01.2.3.4"],
    ["empty entry", "192.0.2.0/24,,198.51.100.0/24"],
    ["leading comma", ",192.0.2.0/24"],
    ["trailing comma", "192.0.2.0/24,"],
    ["blank entry", "192.0.2.0/24, ,198.51.100.0/24"],
    ["only a separator", " , "],
    ["17 entries", Array.from({ length: 17 }, (_, i) => `192.0.2.${i}`).join(",")],
    ["257 characters", `192.0.2.1${" ".repeat(248)}`],
    ["Windows path", "C:\\networks.txt"],
    ["fullwidth digit", "１92.0.2.0/24"],
  ])("%s", (_name, text) => {
    expect(parseAllowedNetworks(text)).toBeNull();
  });

  it.each([
    ["number", 3232235520],
    ["array", ["192.0.2.0/24"]],
    ["null", null],
    ["undefined", undefined],
    ["object with toString", { toString: () => "192.0.2.0/24" }],
    ["String object", new String("192.0.2.0/24")],
    ["inherited key", Object.create({ toString: () => "192.0.2.0/24" }) as unknown],
    ["__proto__", JSON.parse('{"__proto__":"192.0.2.0/24"}') as unknown],
  ])("%s is not a string", (_name, value) => {
    expect(parseAllowedNetworks(value)).toBeNull();
  });
});

describe("parseAllowedNetworks accepts the list", () => {
  it.each([
    ["", 0],
    ["   ", 0],
    ["192.0.2.7", 1],
    [" 192.0.2.0/24 , 198.51.100.0/24 ", 2],
    ["2001:DB8::/32", 1],
    ["::ffff:192.0.2.0/120", 1],
    [Array.from({ length: 16 }, (_, i) => `192.0.2.${i}`).join(","), 16],
  ])("%j has %i networks", (text, count) => {
    expect(parseAllowedNetworks(text)?.length).toBe(count);
  });

  it("the empty list is the frozen NO_ALLOWED_NETWORKS", () => {
    expect(parseAllowedNetworks("")).toBe(NO_ALLOWED_NETWORKS);
    expect(Object.isFrozen(NETS)).toBe(true);
  });
});

describe("networkAllows", () => {
  it.each([
    ["203.0.113.5", false],
    ["192.0.3.0", false],
    ["2001:db9::1", false],
    [null, false],
    ["", false],
    ["192.0.2.255", true],
    ["2001:db8:ffff::1", true],
  ])("%j → %s", (ip, allowed) => {
    expect(networkAllows(NETS ?? [], ip)).toBe(allowed);
  });

  it("an IPv4-mapped range holds the same IPv4 addresses", () => {
    const mapped = parseAllowedNetworks("::ffff:192.0.2.0/120") ?? [];
    expect(networkAllows(mapped, "192.0.2.9")).toBe(true);
    expect(networkAllows(mapped, "198.51.100.9")).toBe(false);
  });

  it("the empty list allows every address and none", () => {
    expect(networkAllows(NO_ALLOWED_NETWORKS, "203.0.113.5")).toBe(true);
    expect(networkAllows(NO_ALLOWED_NETWORKS, null)).toBe(true);
  });

  it("a list that did not come from the parser allows nothing", () => {
    const forged = ["192.0.2.0/24"] as unknown as typeof NO_ALLOWED_NETWORKS;
    expect(networkAllows(forged, "192.0.2.1")).toBe(false);
  });
});

describe("isOpsPath", () => {
  it.each([
    "/api/v1/ops",
    "/api/v1/ops/",
    "/api/v1/ops/ip-rules",
    "/api/v1/ops/ip-rules?x=1",
    "/api/v1/ops?x",
    "/api/v1/ops#x",
    "/API/V1/OPS/ip-rules",
    "/api//v1///ops/x",
    "//api/v1/ops",
    "http://ductura.invalid/api/v1/ops/ip-rules",
    "HTTPS://ductura.invalid:8443/api/v1/ops",
  ])("%j is an operator path", (target) => {
    expect(isOpsPath(target)).toBe(true);
  });

  it.each([
    "/api/v1/opsx",
    "/api/v1/op",
    "/api/v1/student/assignments",
    "/api/v1/x?/api/v1/ops/",
    "/api/v2/ops",
    "/",
    "",
    "*",
    "http://ductura.invalid",
    "http://ductura.invalid/api/v1/student/assignments",
    undefined,
  ])("%j is not an operator path", (target) => {
    expect(isOpsPath(target)).toBe(false);
  });
});
