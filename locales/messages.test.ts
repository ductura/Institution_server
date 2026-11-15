// Ported from Ductus src/lib/i18n/messages.test.ts at d52a92c3 (S-1L.1, DAN-768).
// Not ported: "does not repeat the save-state wording kept in the sync domain",
// which reads @/domain/sync/labels; that module is not in this repository. It
// returns with the task that ports the sync labels (locales/README.md, "Dug").
import { describe, expect, it } from "vitest";

import { messagesHr } from "./hr.ts";
import { leaves } from "./test-leaves.ts";

// Ductus docs/PRODUCT.md §5, "Ne koristiti nikad" (stems, so inflected forms match).
const FORBIDDEN = [
  "sumnj",
  "rizik",
  "anomalij",
  "upozorenje o studentu",
  "postot",
  "vjerojatnost",
  "autentičn",
  "napisao ai",
  "verificirano autorstvo",
  "dokaz autorstva",
  "kopiran",
  "prepisan",
  "nestali podaci",
  "skriven",
  "skriva",
];

/** Paths of texts that hold a word of `words`, written as "path: word". */
function found(texts: readonly [string, string][], words: readonly string[]): string[] {
  return texts.flatMap(([path, text]) => {
    const lower = text.toLocaleLowerCase("hr");
    return words.filter((word) => lower.includes(word)).map((word) => `${path}: ${word}`);
  });
}

describe("messages.hr", () => {
  const all = leaves(messagesHr);

  it("has no empty text", () => {
    for (const [path, text] of all) {
      expect(text.trim(), path).not.toBe("");
    }
  });

  it("uses no word from the forbidden vocabulary", () => {
    expect(found(all, FORBIDDEN)).toEqual([]);
  });

  it("finds a forbidden word put into a copy of the table", () => {
    const copy = structuredClone(messagesHr) as unknown as { app: Record<string, string> };
    copy.app["tagline"] = "Sumnjivo pisanje";
    expect(found(leaves(copy), FORBIDDEN)).toEqual(["app.tagline: sumnj"]);
  });

  it("never says a bare 'spremljeno'", () => {
    for (const [path, text] of all) {
      const lower = text.toLocaleLowerCase("hr").trim();
      expect(/^spremljeno\.?$/.test(lower), path).toBe(false);
    }
  });
});

// FE-D3 (DAN-222): the sign-in screen offers AAI@EduHr alone (D-09) and says
// nothing about what is or is not recorded, so it cannot contradict the live
// view and replay (D-142..D-144) or the notice of each assignment.
describe("messages.hr signIn", () => {
  const signIn = leaves(messagesHr.signIn, "signIn");

  it("names AAI@EduHr on the sign-in button", () => {
    expect(messagesHr.signIn.button).toContain("AAI@EduHr");
  });

  it("offers no other way to sign in", () => {
    expect(found(signIn, ["e-pošt", "email", "e-mail", "putovnic", "google", "microsoft"])).toEqual(
      [],
    );
  });

  it("makes no claim about recording, live view or replay", () => {
    expect(found(signIn, ["bilje", "uživo", "reproduc", "čuva", "ne vidi"])).toEqual([]);
  });
});

// D-124: the interface name is Ductura; the repo and code stay Ductus (#838).
describe("product name in the interface catalogue", () => {
  it("uses Ductura, never Ductus", () => {
    const named = leaves(messagesHr).filter(([, text]) => /\bDuctus\b/.test(text));
    expect(named).toEqual([]);
  });
});
