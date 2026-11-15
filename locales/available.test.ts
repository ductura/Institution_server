// S-1L.5 (DAN-781): a language is offered only with full key parity with `hr`.
// Every case works on a copy of the English table, never on the real catalogue.
import { describe, expect, it } from "vitest";

import { messagesEn } from "./en.ts";
import { messagesHr } from "./hr.ts";
import {
  DEFAULT_LANGUAGE,
  INTERFACE_CATALOGUES,
  isCompleteCatalogue,
  OFFERED_LANGUAGES,
  offeredLanguages,
} from "./parity.ts";

type Table = Record<string, unknown>;

/** A fake language: a deep copy of `en`, changed by `edit`. */
function fake(edit: (table: Table) => void = () => {}): Table {
  const table = structuredClone(messagesEn) as unknown as Table;
  edit(table);
  return table;
}

const section = (table: Table, key: string) => table[key] as Table;

describe("offeredLanguages", () => {
  it("offers a complete copy after Croatian", () => {
    expect(offeredLanguages(messagesHr, { xx: fake() })).toEqual(["hr", "xx"]);
  });

  it.each<[string, (table: Table) => void]>([
    ["one key less", (t) => delete section(t, "app").name],
    ["a whole section less", (t) => delete t.app],
    ["one extra key", (t) => (section(t, "app").extraKey = "Extra")],
    ["an extra nested key", (t) => (section(t, "app").nested = { deeper: "Deeper" })],
    ["a nested section where a text stands", (t) => (section(t, "app").name = { name: "N" })],
    ["an empty text", (t) => (section(t, "app").name = "")],
    ["a text of white space only", (t) => (section(t, "app").name = " \n\t\u00a0\u3000")],
    [
      "a text of zero-width characters only",
      (t) => (section(t, "app").name = "\u200b\u200d\u2060\ufeff"),
    ],
    ["a text of a soft hyphen only", (t) => (section(t, "app").name = "\u00ad")],
    ["a text of blank filler letters only", (t) => (section(t, "app").name = "\u3164\u2800")],
    ["a text of a combining grapheme joiner only", (t) => (section(t, "app").name = "\u034f")],
    ["a text of combining marks only", (t) => (section(t, "app").name = "\u0301\ufe0f\u{e0100}")],
    ["a text of private-use characters only", (t) => (section(t, "app").name = "\ue000")],
    ["a text of tag characters only", (t) => (section(t, "app").name = "\u{e0041}\u{e007f}")],
    ["a table where a list stands", (t) => listToTable(t)],
    ["a text that is not a string", (t) => (section(t, "app").name = 7)],
    ["a list one item shorter", (t) => shortenFirstList(t)],
    ["a blank item in a list", (t) => blankFirstListItem(t)],
    ["another placeholder", (t) => renameFirstPlaceholder(t)],
    ["a placeholder less", (t) => dropFirstPlaceholder(t)],
  ])("does not offer a language with %s", (_, edit) => {
    const broken = fake(edit);
    expect(isCompleteCatalogue(messagesHr, broken)).toBe(false);
    expect(offeredLanguages(messagesHr, { xx: broken, yy: fake() })).toEqual(["hr", "yy"]);
  });

  it("offers a language whose texts carry visible characters among invisible ones", () => {
    expect(
      isCompleteCatalogue(
        messagesHr,
        fake((t) => (section(t, "app").name = "\u200bA")),
      ),
    ).toBe(true);
    expect(
      isCompleteCatalogue(
        messagesHr,
        fake((t) => (section(t, "app").name = "\u3164·")),
      ),
    ).toBe(true);
  });

  it("does not offer a catalogue that throws while it is read", () => {
    const throwing = new Proxy(fake(), {
      ownKeys: () => {
        throw new Error("unreadable");
      },
    });
    expect(offeredLanguages(messagesHr, { xx: throwing })).toEqual(["hr"]);
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["an empty table", {}],
    ["a text", "Croatian"],
  ])("does not offer a language whose catalogue is %s", (_, catalogue) => {
    expect(offeredLanguages(messagesHr, { xx: catalogue })).toEqual(["hr"]);
  });

  it("leaves only Croatian when the catalogues cannot be listed", () => {
    const throwing = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("unreadable");
        },
      },
    );
    expect(offeredLanguages(messagesHr, throwing)).toEqual(["hr"]);
    expect(
      offeredLanguages(messagesHr, {
        get xx(): unknown {
          throw new Error("unreadable");
        },
      }),
    ).toEqual(["hr"]);
  });

  it.each(["HR", " hr", "hr-HR", "", "__proto__", "0", "eng", "En"])(
    "does not offer a complete catalogue under the code %j",
    (code) => {
      const catalogues = Object.defineProperty({}, code, { value: fake(), enumerable: true });
      expect(offeredLanguages(messagesHr, catalogues)).toEqual(["hr"]);
    },
  );

  it("always offers Croatian first, whatever the catalogues hold", () => {
    expect(offeredLanguages(messagesHr, {})).toEqual(["hr"]);
    expect(offeredLanguages(messagesHr, { hr: undefined })).toEqual(["hr"]);
    expect(offeredLanguages(messagesHr, { hr: {}, xx: fake() })).toEqual(["hr", "xx"]);
    expect(offeredLanguages(messagesHr, { xx: fake(), hr: fake() })).toEqual(["hr", "xx"]);
  });

  it("keeps Croatian the default and the first offered language", () => {
    expect(DEFAULT_LANGUAGE).toBe("hr");
    expect(OFFERED_LANGUAGES[0]).toBe("hr");
    expect(Object.isFrozen(OFFERED_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(INTERFACE_CATALOGUES)).toBe(true);
  });
});

describe("the catalogues of this repository", () => {
  it("offer exactly the languages with a complete catalogue", () => {
    expect(Object.keys(INTERFACE_CATALOGUES)).toEqual(["en"]);
    expect(OFFERED_LANGUAGES).toEqual(["hr", "en"]);
  });

  it("have no blank text in Croatian, so the reference itself is complete", () => {
    expect(isCompleteCatalogue(messagesHr, messagesHr)).toBe(true);
  });
});

/** Every [path, list] of a table, depth first. */
function lists(node: unknown, path: string[] = []): [string[], unknown[]][] {
  if (Array.isArray(node)) return [[path, node]];
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => lists(value, [...path, key]));
}

/** Every [holder, key, text] of a table, depth first. */
function texts(node: unknown): [Table, string, string][] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "string" ? [[node as Table, key, value]] : texts(value),
  );
}

function shortenFirstList(table: Table): void {
  const found = lists(table).find(([, list]) => list.length > 1);
  if (!found) throw new Error("the copy has no list of two items");
  found[1].pop();
}

function listToTable(table: Table): void {
  const found = lists(table).find(([path]) => path.length > 0);
  if (!found) throw new Error("the copy has no list");
  const [path, list] = found;
  const holder = path.slice(0, -1).reduce<Table>((node, key) => node[key] as Table, table);
  holder[path.at(-1)!] = { ...list };
}

function blankFirstListItem(table: Table): void {
  const found = lists(table).find(([, list]) => typeof list[0] === "string");
  if (!found) throw new Error("the copy has no list of texts");
  found[1][0] = "";
}

function withPlaceholder(table: Table): [Table, string, string] {
  const found = texts(table).find(([, , text]) => /\{\w+\}/.test(text));
  if (!found) throw new Error("the copy has no text with a placeholder");
  return found;
}

function renameFirstPlaceholder(table: Table): void {
  const [holder, key, text] = withPlaceholder(table);
  holder[key] = text.replace(/\{(\w+)\}/, "{$1Renamed}");
}

function dropFirstPlaceholder(table: Table): void {
  const [holder, key, text] = withPlaceholder(table);
  holder[key] = text.replace(/\{\w+\}/g, "");
}
