// Ported from Ductus src/lib/i18n/messages.en.test.ts at d52a92c3 (S-1L.1, DAN-768).
// Ductus checks the forbidden vocabulary with findForbiddenTerms of its
// scanner (scripts/forbidden-terms). The scanner is ported in the next step
// (S-1L.1 PR-b); until then this test reads the English column of Ductus
// docs/PRODUCT.md §5 as stems, the way messages.test.ts reads the Croatian one.
import { describe, expect, it } from "vitest";

import { messagesEn } from "./en.ts";
import { leaves } from "./test-leaves.ts";

// Ductus docs/PRODUCT.md §5, "Engleski ekvivalenti" (stems, so inflected forms match).
const FORBIDDEN = [
  "suspic",
  "suspect",
  "doubt",
  "risk",
  "anomal",
  "warning about the student",
  "ai percentage",
  "ai share",
  "human share",
  "humanness",
  "probab",
  "likelihood",
  "authentic",
  "written by ai",
  "verified authorship",
  "proof of authorship",
  "copy-paste",
  "someone else's text",
  "not their own",
  "vanished data",
  "hidden",
  "concealed",
  "plagiar",
  "originality",
  "unoriginal",
  "integrity",
  "unusual",
  "atypical",
  "irregularit",
  "human-written",
  "written by a human",
];

/** Paths of texts that hold a word of `words`, written as "path: word". */
function found(texts: readonly [string, string][], words: readonly string[]): string[] {
  return texts.flatMap(([path, text]) => {
    const lower = text.toLowerCase();
    return words.filter((word) => lower.includes(word)).map((word) => `${path}: ${word}`);
  });
}

// The English table carries the checks `messages.test.ts` makes on the
// Croatian one, in English. Key parity with the Croatian table is
// `parity.test.ts`.
describe("messages.en", () => {
  const all = leaves(messagesEn);

  it("has no empty text", () => {
    for (const [path, text] of all) {
      expect(text.trim(), path).not.toBe("");
    }
  });

  it("uses no word from the forbidden vocabulary", () => {
    expect(found(all, FORBIDDEN)).toEqual([]);
  });

  it("finds a forbidden word put into a copy of the table", () => {
    const copy = structuredClone(messagesEn) as unknown as { app: Record<string, string> };
    copy.app["tagline"] = "No hidden steps";
    expect(found(leaves(copy), FORBIDDEN)).toEqual(["app.tagline: hidden"]);
  });

  it("never says a bare 'saved'", () => {
    for (const [path, text] of all) {
      expect(/^saved\.?$/i.test(text.trim()), path).toBe(false);
    }
  });

  // A Croatian letter left in a value is a string that was not translated.
  it("has no Croatian text left", () => {
    for (const [path, text] of all) {
      expect(/[čćđšžČĆĐŠŽ]/u.test(text), `${path}: "${text}"`).toBe(false);
    }
  });
});

// FE-D3 (DAN-222) in English: AAI@EduHr alone (D-09), and nothing about what
// is or is not recorded (D-142..D-144).
describe("messages.en signIn", () => {
  const signIn = leaves(messagesEn.signIn, "signIn");

  it("names AAI@EduHr on the sign-in button", () => {
    expect(messagesEn.signIn.button).toContain("AAI@EduHr");
  });

  it("offers no other way to sign in", () => {
    expect(found(signIn, ["email", "e-mail", "passport", "google", "microsoft"])).toEqual([]);
  });

  it("makes no claim about recording, live view or replay", () => {
    const words = ["record", "live", "replay", "keeps", "stored", "does not see", "cannot see"];
    expect(found(signIn, words)).toEqual([]);
  });
});

// D-124: the interface name is Ductura in every language.
describe("product name in the English catalogue", () => {
  it("uses Ductura, never Ductus", () => {
    const named = leaves(messagesEn).filter(([, text]) => /\bDuctus\b/.test(text));
    expect(named).toEqual([]);
  });
});
