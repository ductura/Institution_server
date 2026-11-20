// The acknowledgment body (Ductus acknowledgment-route.test.ts at 078c780,
// the body classes) and the template version held equal to the copied
// domain constant. All values are invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NOTICE_TEMPLATE_VERSION, parseAcknowledgmentBody } from "./acknowledgment-body.ts";

const FP = "c4d5e6f7".repeat(8);
const parse = (text: string) => parseAcknowledgmentBody(text, JSON.parse(text) as unknown);

describe("parseAcknowledgmentBody", () => {
  it("takes exactly {versionNo, fingerprint}", () => {
    expect(parse(`{"versionNo":2,"fingerprint":"${FP}"}`)).toEqual({
      versionNo: 2,
      fingerprint: FP,
    });
    expect(parse(`{ "fingerprint" : "${FP}", "versionNo" : 2147483647 }`)).toEqual({
      versionNo: 2147483647,
      fingerprint: FP,
    });
  });

  it.each([
    ["a repeated key", `{"versionNo":2,"fingerprint":"${"0".repeat(64)}","fingerprint":"${FP}"}`],
    ["an escaped key", `{"versionNo":2,"fingerpr\\u0069nt":"${FP}"}`],
    ["an escape in the value", `{"versionNo":2,"fingerprint":"\\u0063${FP.slice(1)}"}`],
    ["version 0", `{"versionNo":0,"fingerprint":"${FP}"}`],
    ["version past int4", `{"versionNo":2147483648,"fingerprint":"${FP}"}`],
    ["version 1.5", `{"versionNo":1.5,"fingerprint":"${FP}"}`],
    ["an upper-case digest", `{"versionNo":2,"fingerprint":"${FP.toUpperCase()}"}`],
    ["a short digest", `{"versionNo":2,"fingerprint":"${FP.slice(1)}"}`],
    ["a third key", `{"versionNo":2,"fingerprint":"${FP}","x":1}`],
    ["an array", `[2,"${FP}"]`],
  ])("refuses %s", (_name, text) => {
    expect(parse(text)).toBeNull();
  });
});

describe("NOTICE_TEMPLATE_VERSION", () => {
  it("is the value of the domain's notice fingerprint (server/domain/notice/fingerprint.ts)", () => {
    const source = readFileSync(
      new URL("../domain/notice/fingerprint.ts", import.meta.url),
      "utf8",
    );
    const found = /export const NOTICE_TEMPLATE_VERSION = (\d+) as const;/u.exec(source);
    expect(Number(found?.[1])).toBe(NOTICE_TEMPLATE_VERSION);
  });
});
