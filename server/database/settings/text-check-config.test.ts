// SRV-V20-STIL-STUDENT: the citation style of the institution in the text check
// configuration. The reader runs on a fake withActor holding invented settings;
// the contract package imports nothing from the server, so the list of styles in
// the contract source is read here and kept equal to the settings catalogue.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { settingOf } from "../../domain/index.ts";

import { readTextCheckConfig } from "./text-check-config.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";

function withSettings(rows: { key: string | null; value: unknown }[], inWorkspace = true) {
  return (async (_token: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      async query(sql: string) {
        if (sql.includes("student_workspace")) return { rows: inWorkspace ? [{}] : [] };
        return { rows };
      },
    })) as never;
}

const read = (rows: { key: string | null; value: unknown }[]) =>
  readTextCheckConfig(withSettings(rows), "izmisljeni-token", ASSIGNMENT);

describe("readTextCheckConfig citationStyle", () => {
  it("returns every style of the catalogue as stored", async () => {
    const definition = settingOf("citation.style");
    if (definition?.kind !== "enum") throw new Error("citation.style is not an enum");
    for (const value of definition.values)
      expect((await read([{ key: "citation.style", value }]))?.citationStyle).toBe(value);
  });

  it("returns the catalogue default when no row or an unknown value is stored", async () => {
    expect((await read([{ key: null, value: null }]))?.citationStyle).toBe("fpzg");
    expect((await read([{ key: "citation.style", value: "mla" }]))?.citationStyle).toBe("fpzg");
    expect((await read([{ key: "citation.style", value: 7 }]))?.citationStyle).toBe("fpzg");
  });

  it("ignores the style row of the Lekta profile and the reverse", async () => {
    const config = await read([
      { key: "lekta.profile", value: "agr-diplomski" },
      { key: "citation.style", value: "ieee" },
    ]);
    expect(config).toMatchObject({ lektaProfileId: "agr-diplomski", citationStyle: "ieee" });
  });

  it("is null for an assignment outside the workspace, whatever the institution holds", async () => {
    const config = await readTextCheckConfig(
      withSettings([{ key: "citation.style", value: "apa" }], false),
      "izmisljeni-token",
      ASSIGNMENT,
    );
    expect(config).toBeNull();
  });

  it("keeps the styles of the contract equal to the settings catalogue", () => {
    const source = readFileSync(
      new URL("../../contracts/routes/text-check-config.ts", import.meta.url),
      "utf8",
    );
    const list = /const CITATION_STYLES = \[([^\]]*)\] as const/u.exec(source)?.[1] ?? "";
    const styles = [...list.matchAll(/"([a-z]+)"/gu)].map((match) => match[1]);
    const definition = settingOf("citation.style");
    if (definition?.kind !== "enum") throw new Error("citation.style is not an enum");
    expect(styles).toEqual([...definition.values]);
  });
});
