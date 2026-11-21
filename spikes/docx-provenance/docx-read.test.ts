import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DocxReadError, LIMITS, readDocx, type ReadFailure } from "./docx-read.ts";
import { FIXTURES, hostile } from "./fixtures.ts";

const byName = (name: string) => {
  const fixture = FIXTURES.find((f) => f.name === name);
  assert.ok(fixture, name);
  return readDocx(fixture.bytes);
};

function failure(bytes: Uint8Array): ReadFailure {
  try {
    readDocx(bytes);
  } catch (error) {
    assert.ok(error instanceof DocxReadError, String(error));
    return error.code;
  }
  assert.fail("expected the reader to refuse the input");
}

describe("five invented DOCX files", () => {
  it("has exactly five fixtures, all invented", () => {
    assert.equal(FIXTURES.length, 5);
    assert.equal(new Set(FIXTURES.map((f) => f.name)).size, 5);
    for (const { bytes } of FIXTURES) {
      const text = Buffer.from(bytes).toString("latin1");
      assert.doesNotMatch(text, /https?:\/\/(?!example\.invalid|schemas\.|purl\.org|www\.w3\.org)/);
    }
  });

  it("plain-word: headings, text, core and app properties, rsids", () => {
    const r = byName("plain-word");
    assert.deepEqual(
      r.paragraphs.map((p) => p.heading),
      [1, null, null, 2, null],
    );
    assert.equal(r.paragraphs[0]?.text, "Kućno kompostiranje u Lipovcu");
    assert.equal(r.wordCount, 21);
    assert.deepEqual(r.core, {
      creator: "Ana Izmišljena",
      lastModifiedBy: "Ana Izmišljena",
      created: "2026-09-14T08:02:00Z",
      modified: "2026-10-02T17:45:00Z",
      revision: 7,
    });
    assert.deepEqual(r.app, { application: "Microsoft Office Word", totalTimeMinutes: 94 });
    assert.equal(r.rsidCount, 3);
  });

  it("tracked-review: changes and comments with authors, deleted text out of the body", () => {
    const r = byName("tracked-review");
    assert.deepEqual(
      r.trackedChanges.map((c) => [c.kind, c.author, c.text]),
      [
        ["delete", "Marko Izmišljeni", "stari "],
        ["insert", "Marko Izmišljeni", "novi "],
        ["insert", "Iva Izmišljena", " Dodana rečenica."],
      ],
    );
    assert.equal(r.trackedChanges[0]?.date, "2026-10-05T10:00:00Z");
    assert.deepEqual(
      r.comments.map((c) => [c.author, c.text]),
      [
        ["Marko Izmišljeni", "Dodaj izvor."],
        ["Iva Izmišljena", "Uskladi s uvodom."],
      ],
    );
    assert.equal(r.paragraphs[0]?.text, "Pregled nacrta: novi tekst.");
    assert.equal(r.core.lastModifiedBy, "Iva Izmišljena");
    assert.equal(r.core.revision, 12);
  });

  it("footnotes-table: footnote without separators, table, external link flagged", () => {
    const r = byName("footnotes-table");
    assert.deepEqual(r.footnotes, ["Izmišljeni izvor, Lipovec 2026."]);
    assert.equal(r.tables, 1);
    assert.deepEqual(r.flags.externalRelationships, ["hyperlink"]);
    assert.equal(r.core.creator, "Luka Izmišljeni");
    assert.equal(r.app.application, null);
  });

  it("online-export: missing metadata is null, never invented", () => {
    const r = byName("online-export");
    assert.deepEqual(r.core, {
      creator: null,
      lastModifiedBy: null,
      created: null,
      modified: null,
      revision: null,
    });
    assert.deepEqual(r.app, { application: null, totalTimeMinutes: null });
    assert.equal(r.rsidCount, 0);
    assert.equal(r.text, "Gradski vrtovi\nIzmišljeni osvrt bez metapodataka.");
  });

  it("desktop-suite: entities decoded once, tab and break kept, field code dropped", () => {
    const r = byName("desktop-suite");
    assert.equal(r.text, "Šuma & vrt <2026> „citat”\tnakon tabulatoraprije prijeloma\nposlije34");
    assert.equal(r.app.application, "LibreOffice/26.8.2.2$Linux_X86_64");
    assert.equal(r.app.totalTimeMinutes, 0);
  });

  it("is deterministic and does not mutate its input", () => {
    for (const { bytes } of FIXTURES) {
      const copy = bytes.slice();
      assert.deepEqual(readDocx(bytes), readDocx(bytes));
      assert.deepEqual(bytes, copy);
    }
  });
});

describe("hostile and broken input", () => {
  it("refuses what is not a DOCX, with a closed code", () => {
    assert.equal(failure(hostile.notZip()), "not_zip");
    assert.equal(failure(new Uint8Array()), "not_zip");
    assert.equal(failure(hostile.encrypted()), "encrypted");
    assert.equal(failure(hostile.noDocument()), "missing_document");
    assert.equal(failure(hostile.malformed()), "invalid_xml");
  });

  it("refuses a DOCTYPE or ENTITY declaration without expanding it", () => {
    assert.equal(failure(hostile.doctype()), "unsafe_xml");
  });

  it("refuses too many entries and a package that inflates past the limit", () => {
    assert.equal(failure(hostile.tooManyEntries(LIMITS.maxEntries + 1)), "too_many_entries");
    const bomb = hostile.inflatesTo(60);
    assert.ok(bomb.byteLength < 200_000, `bomb is ${bomb.byteLength} bytes packed`);
    assert.equal(failure(bomb), "uncompressed_too_large");
  });

  it("refuses a package over the byte limit before unzipping", () => {
    assert.equal(failure(new Uint8Array(LIMITS.maxPackageBytes + 1)), "too_large");
  });

  it("flags macros and external templates, and executes neither", () => {
    assert.equal(readDocx(hostile.withMacro()).flags.hasMacros, true);
    assert.deepEqual(readDocx(hostile.withTemplateLink()).flags.externalRelationships, [
      "attachedTemplate",
    ]);
  });
});
