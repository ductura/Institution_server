// DAN-805, plan of attack ductura/server#98 part A as properties: any header
// at all, the order of other pairs, and a large header (A8).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sessionTokenFromCookie } from "./cookie.ts";

const NAME = "__Host-ductus_session";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const base64url = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
);
const token = fc.array(base64url, { minLength: 43, maxLength: 43 }).map((c) => c.join(""));
const otherPair = fc
  .tuple(fc.stringMatching(/^[a-z_-]{1,12}$/u), fc.stringMatching(/^[A-Za-z0-9]{0,20}$/u))
  .filter(([name]) => name !== NAME)
  .map(([name, value]) => `${name}=${value}`);

describe("sessionTokenFromCookie, properties", () => {
  it("never throws, and a token it gives has the form and is in the header", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string({ unit: "binary" }),
          fc
            .array(fc.oneof(fc.constant(`${NAME}=`), fc.constant("; "), token, fc.string()))
            .map((p) => p.join("")),
          fc.array(fc.string()),
        ),
        (header) => {
          const found = sessionTokenFromCookie(header);
          if (found === undefined) return;
          expect(found).toMatch(TOKEN);
          const text = typeof header === "string" ? header : header.join("; ");
          expect(text.includes(`${NAME}=${found}`)).toBe(true);
        },
      ),
    );
  });

  it("one session pair among any others gives its token, in any order", () => {
    fc.assert(
      fc.property(token, fc.array(otherPair, { maxLength: 8 }), fc.nat(), (value, others, at) => {
        const pairs = [...others];
        pairs.splice(at % (pairs.length + 1), 0, `${NAME}=${value}`);
        expect(sessionTokenFromCookie(pairs.join("; "))).toBe(value);
      }),
    );
  });

  it("two session pairs give nothing, whatever their values and place", () => {
    fc.assert(
      fc.property(
        token,
        fc.string(),
        fc.array(otherPair, { maxLength: 6 }),
        (value, twin, others) => {
          const header = [`${NAME}=${value}`, ...others, `${NAME}=${twin}`].join("; ");
          expect(sessionTokenFromCookie(header)).toBeUndefined();
        },
      ),
    );
  });

  it("A8: a header of a hundred thousand pairs is read in linear time", () => {
    const pairs = Array.from({ length: 100_000 }, (_, i) => `c${i}=v${i}`);
    const value = "q".repeat(43);
    const started = performance.now();
    expect(sessionTokenFromCookie([...pairs, `${NAME}=${value}`].join("; "))).toBe(value);
    expect(sessionTokenFromCookie(";".repeat(1_000_000))).toBeUndefined();
    expect(sessionTokenFromCookie("=".repeat(1_000_000))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
