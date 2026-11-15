// S-1L.1 (DAN-768): the port changed no text but the recorded ones
// (SOURCE_TEXT_CHANGES: Ductus#1836 c.6889314023, ductura/server#38 c.6889516654). With those put back, every
// text, taken back to its path in the Ductus table, gives the digest recorded
// from the source (locales/source.ts; scripts/locales/source-digest.ts recomputes it).
import { describe, expect, it } from "vitest";

import { messagesEn } from "./en.ts";
import { messagesHr, type MessageKey } from "./hr.ts";
import {
  digestOf,
  SOURCE_DIGESTS,
  SOURCE_KEY_RENAMES,
  SOURCE_TEXT_CHANGES,
  sourcePath,
  textPairs,
  withSourceTexts,
} from "./source.ts";
import { textOf } from "./text-of.ts";

/** The table with the recorded changes put back; it gives the source digest. */
const sourceOf = <T>(table: T, language: "hr" | "en"): T => withSourceTexts(table, language);

const TABLES = [
  ["hr", messagesHr],
  ["en", messagesEn],
] as const;

describe("port from Ductus", () => {
  it.each(TABLES)("%s holds every other source text unchanged", (language, table) => {
    expect(digestOf(withSourceTexts(table, language), sourcePath)).toEqual(
      SOURCE_DIGESTS[language],
    );
  });

  it.each(TABLES)(
    "%s does not match the source without the recorded changes",
    (language, table) => {
      expect(digestOf(table, sourcePath).sha256).not.toBe(SOURCE_DIGESTS[language].sha256);
    },
  );

  it.each(TABLES)("%s gives a different digest when one character changes", (language, table) => {
    const copy = sourceOf(table, language) as unknown as { app: Record<string, string> };
    expect(digestOf(copy, sourcePath)).toEqual(SOURCE_DIGESTS[language]);
    copy.app["tagline"] = `${copy.app["tagline"] ?? ""} `;
    expect(digestOf(copy, sourcePath).sha256).not.toBe(SOURCE_DIGESTS[language].sha256);
  });

  it.each(TABLES)(
    "%s gives a different digest when a text moves to another key",
    (language, table) => {
      const copy = sourceOf(table, language) as unknown as { app: Record<string, string> };
      expect(digestOf(copy, sourcePath)).toEqual(SOURCE_DIGESTS[language]);
      [copy.app["name"], copy.app["tagline"]] = [copy.app["tagline"] ?? "", copy.app["name"] ?? ""];
      expect(digestOf(copy, sourcePath).sha256).not.toBe(SOURCE_DIGESTS[language].sha256);
    },
  );

  it("gives a different digest when a list becomes an object", () => {
    const copy = sourceOf(messagesHr, "hr");
    expect(digestOf(copy, sourcePath)).toEqual(SOURCE_DIGESTS.hr);
    const dialog = copy.teacherRoles.confirmDialog as unknown as Record<string, unknown>;
    expect(Array.isArray(dialog["points"])).toBe(true);
    dialog["points"] = { ...(dialog["points"] as string[]) };
    expect(digestOf(copy, sourcePath).sha256).not.toBe(SOURCE_DIGESTS.hr.sha256);
  });

  it("gives a different digest without the key renames", () => {
    const source = sourceOf(messagesHr, "hr");
    expect(digestOf(source, sourcePath)).toEqual(SOURCE_DIGESTS.hr);
    expect(digestOf(source).sha256).not.toBe(SOURCE_DIGESTS.hr.sha256);
  });
});

describe("text changes", () => {
  const texts = (table: unknown) =>
    new Map(textPairs(table).map(([path, text]) => [path.join("."), text]));

  it.each(TABLES)(
    "%s differs from its source texts exactly in the recorded ones",
    (language, table) => {
      const [port, source] = [texts(table), texts(withSourceTexts(table, language))];
      const changed = [...port].filter(([path, text]) => source.get(path) !== text);
      const recorded = SOURCE_TEXT_CHANGES.filter((change) => change.language === language);
      expect(changed.map(([path]) => path).sort()).toEqual(recorded.map((c) => c.path).sort());
      for (const change of recorded) {
        expect(port.get(change.path), change.path).toBe(change.port);
        expect(source.get(change.path), change.path).toBe(change.source);
      }
    },
  );

  it("are the four texts of the decision in both languages and the English noun copy", () => {
    const decision =
      "https://github.com/danielrisavi77-create/Ductus/issues/1836#issuecomment-6889314023";
    const finding = "https://github.com/ductura/server/pull/38#issuecomment-6889516654";
    const paths = (language: "hr" | "en", reason: string) =>
      SOURCE_TEXT_CHANGES.filter((c) => c.language === language && c.decision === reason)
        .map((c) => c.path)
        .sort();
    const decided = [
      "revisions.keptHint",
      "revisions.keptUnloadedHint",
      "workspace.earlierDraftCopy",
      "workspace.earlierDraftExplain",
    ];
    expect(paths("hr", decision)).toEqual(decided);
    expect(paths("en", decision)).toEqual(decided);
    expect(paths("hr", finding)).toEqual([]);
    expect(paths("en", finding)).toEqual(
      [
        "auth.copyDiscard",
        "auth.copyDiscardAsk",
        "auth.copyDiscardConfirm",
        "auth.copyDiscardFailed",
        "auth.copyKeep",
        "auth.copyNewestOnly",
        "auth.copyTitle",
        "auth.logoutCopy.few",
        "auth.logoutCopy.many",
        "auth.logoutCopy.one",
        "auth.logoutCopyKept",
      ].sort(),
    );
    expect(SOURCE_TEXT_CHANGES).toHaveLength(decided.length * 2 + 11);
  });

  it("remove the root kopir- / copy from every changed text", () => {
    for (const change of SOURCE_TEXT_CHANGES) {
      expect(change.source, change.path).toMatch(/kopir|cop(y|i)/iu);
      expect(change.port, change.path).not.toMatch(/kopir|cop(y|i)/iu);
    }
  });

  it("leave no root kopir- or copy in a text outside the allowed actions (PRODUCT §5, D-59)", () => {
    const allowed = /Kopiraj navod|kopiranj\p{L}* navoda|Kopirano u međuspremnik|Copy citation/giu;
    for (const [language, table] of TABLES)
      for (const [path, text] of textPairs(table))
        expect(text.replace(allowed, ""), `${language} ${path.join(".")}`).not.toMatch(
          /kopir|cop(y|i)/iu,
        );
  });

  it("refuse a recorded change whose new text is not in the table", () => {
    const copy = structuredClone(messagesHr);
    (copy.workspace as Record<string, unknown>)["earlierDraftCopy"] = "Kopiraj tekst";
    expect(() => withSourceTexts(copy, "hr")).toThrow(
      /no recorded text at hr workspace.earlierDraftCopy/,
    );
  });

  it("leave the table it is given as it is", () => {
    withSourceTexts(messagesHr, "hr");
    expect(messagesHr.workspace.earlierDraftCopy).toBe("Stavi tekst u međuspremnik");
  });
});

describe("key renames", () => {
  const paths = new Set(textPairs(messagesHr).map(([path]) => path.join(".")));

  it("rename only Croatian keys to keys the table has, one to one", () => {
    const ports = SOURCE_KEY_RENAMES.map(([, port]) => port);
    expect(new Set(ports).size).toBe(ports.length);
    for (const [source, port] of SOURCE_KEY_RENAMES) {
      const [from, to] = [source.split("."), port.split(".")];
      // Only the last segment is renamed; the parent path stays the source one.
      expect(to.slice(0, -1), port).toEqual(from.slice(0, -1));
      expect(
        [...paths].some((path) => path === port || path.startsWith(`${port}.`)),
        port,
      ).toBe(true);
    }
  });

  it("take every renamed path back to a distinct source path", () => {
    const back = textPairs(messagesHr).map(([path]) => sourcePath(path).join("."));
    expect(new Set(back).size).toBe(back.length);
  });

  it("leave a path outside the renames as it is", () => {
    expect(sourcePath(["workspace", "title"])).toEqual(["workspace", "title"]);
    expect(sourcePath(["workspaceX", "upute"])).toEqual(["workspaceX", "upute"]);
  });
});

describe("message keys", () => {
  it("read a text by its key", () => {
    expect(textOf(messagesHr, "statusPage.states.working")).toBe("Radi");
    expect(textOf(messagesEn, "signIn.button")).toBe(messagesEn.signIn.button);
  });

  it("refuse a key with no text at run time", () => {
    expect(() => textOf(messagesHr, "app.missing" as MessageKey)).toThrow(/no text at app.missing/);
    for (const key of ["constructor.name", "app.toString", "app.name.length", "app.name.0"])
      expect(() => textOf(messagesHr, key as MessageKey), key).toThrow(/no text at/);
  });

  it("do not compile with a key the Croatian table lacks", () => {
    // @ts-expect-error: no such key in hr (a missing key breaks the typecheck).
    const missing: MessageKey = "app.missing";
    // @ts-expect-error: the source key was renamed (prijava → signIn).
    const renamed: MessageKey = "prijava.button";
    // @ts-expect-error: a section is not a text.
    const section: MessageKey = "app";
    expect([missing, renamed, section]).toHaveLength(3);
  });

  it("do not compile an English table without a key of the Croatian one", () => {
    const app = { name: messagesEn.app.name };
    // @ts-expect-error: app.tagline is missing (Messages requires every key of hr).
    const table: typeof messagesHr = { ...messagesEn, app };
    expect(table.app).toBe(app);
  });
});
