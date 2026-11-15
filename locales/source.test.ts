// S-1L.1 (DAN-768): the port changed no text. Every text, taken back to its
// path in the Ductus table, gives the digest recorded from the source
// (locales/source.ts; scripts/locales/source-digest.ts recomputes it).
import { describe, expect, it } from "vitest";

import { messagesEn } from "./en.ts";
import { messagesHr, textOf, type MessageKey } from "./hr.ts";
import { digestOf, SOURCE_DIGESTS, SOURCE_KEY_RENAMES, sourcePath, textPairs } from "./source.ts";

const TABLES = [
  ["hr", messagesHr],
  ["en", messagesEn],
] as const;

describe("port from Ductus", () => {
  it.each(TABLES)("%s holds every source text unchanged", (language, table) => {
    expect(digestOf(table, sourcePath)).toEqual(SOURCE_DIGESTS[language]);
  });

  it.each(TABLES)("%s gives a different digest when one character changes", (language, table) => {
    const copy = structuredClone(table) as unknown as { app: Record<string, string> };
    copy.app["tagline"] = `${copy.app["tagline"] ?? ""} `;
    expect(digestOf(copy, sourcePath).sha256).not.toBe(SOURCE_DIGESTS[language].sha256);
  });

  it.each(TABLES)(
    "%s gives a different digest when a text moves to another key",
    (language, table) => {
      const copy = structuredClone(table) as unknown as { app: Record<string, string> };
      [copy.app["name"], copy.app["tagline"]] = [copy.app["tagline"] ?? "", copy.app["name"] ?? ""];
      expect(digestOf(copy, sourcePath).sha256).not.toBe(SOURCE_DIGESTS[language].sha256);
    },
  );

  it("gives a different digest without the key renames", () => {
    expect(digestOf(messagesHr).sha256).not.toBe(SOURCE_DIGESTS.hr.sha256);
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
