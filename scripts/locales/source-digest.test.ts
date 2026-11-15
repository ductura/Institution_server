// The digest script reads a Ductus checkout. These tests build a made-up one in
// a temporary folder from the ported tables written back under their source
// keys, so they need no Ductus checkout and no network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  messagesEn,
  messagesHr,
  SOURCE,
  SOURCE_DIGESTS,
  sourcePath,
  textPairs,
} from "../../locales/index.ts";

import { checkSource } from "./source-digest.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A table with every text under its source path, as plain nested objects. */
function asSource(table: unknown, change?: (text: string) => string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, text] of textPairs(table)) {
    const segments = sourcePath(path);
    let node = root;
    for (const segment of segments.slice(0, -1))
      node = (node[segment] ??= {}) as Record<string, unknown>;
    node[segments.at(-1) ?? ""] = change && path.join(".") === "app.tagline" ? change(text) : text;
  }
  return root;
}

function checkout(change?: (text: string) => string): string {
  const root = mkdtempSync(path.join(tmpdir(), "locales-source-"));
  folders.push(root);
  for (const [language, name, table] of [
    ["hr", "messagesHr", messagesHr],
    ["en", "messagesEn", messagesEn],
  ] as const) {
    const file = path.join(root, SOURCE[language].path);
    mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify(asSource(table, language === "hr" ? change : undefined));
    writeFileSync(file, `import type { X } from "./x";\nexport const ${name}: X = ${body};\n`);
  }
  return root;
}

describe("checkSource", () => {
  it("matches the recorded digests on a checkout with the same texts", () => {
    expect(checkSource(checkout())).toEqual([
      { language: "hr", ...SOURCE_DIGESTS.hr, matches: true },
      { language: "en", ...SOURCE_DIGESTS.en, matches: true },
    ]);
  });

  it("reports a checkout in which one character of one text differs", () => {
    const [hr, en] = checkSource(checkout((text) => text.replace(/\.$/u, "!")));
    expect(hr?.matches).toBe(false);
    expect(hr?.texts).toBe(SOURCE_DIGESTS.hr.texts);
    expect(en?.matches).toBe(true);
  });
});
