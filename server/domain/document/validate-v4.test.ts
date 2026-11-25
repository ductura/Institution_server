import { describe, expect, it } from "vitest";

import { validateDocument } from "./validate.ts";
import { validateDocumentV4 } from "./validate-v4.ts";

// Document v4 blocks, part 1 (docs/contracts/document-schema-v4.md §1 to §4;
// SRV-10A). The marks themselves are tested in validate-marks-v4.test.ts.
// Synthetic data only.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";

const doc = (...nodes: unknown[]) => ({ schemaVersion: 4, sources: [], nodes });
const text = (value: string, marks: unknown[] = []) => ({ type: "text", text: value, marks });
const para = (...children: unknown[]) => doc({ type: "paragraph", id: P, children });
const errorsOf = (value: unknown) => {
  const outcome = validateDocumentV4(value);
  return outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code]);
};
const accepts = (value: unknown) => {
  const outcome = validateDocumentV4(value);
  expect(outcome).toEqual({ ok: true, doc: value });
};

describe("top level (§1, class 46)", () => {
  it("refuses a missing sources, an unknown key and a wrong version", () => {
    expect(errorsOf({ schemaVersion: 4, nodes: [{ type: "pageBreak", id: P }] })).toEqual([
      ["$.sources", "SOURCES_NOT_ARRAY"],
    ]);
    expect(errorsOf({ ...para(), extra: 1 })).toEqual([["$.extra", "UNKNOWN_FIELD"]]);
    for (const version of ["4", 4.5, 5, 3]) {
      expect(errorsOf({ ...para(), schemaVersion: version })).toEqual([
        ["$.schemaVersion", "SCHEMA_VERSION_INVALID"],
      ]);
    }
    expect(errorsOf("x")).toEqual([["$", "DOCUMENT_NOT_OBJECT"]]);
    expect(errorsOf(doc())).toEqual([["$.nodes", "NODES_EMPTY"]]);
  });
});

describe("marks in text blocks (§3, class 50)", () => {
  const all = [
    "bold",
    "italic",
    "sup",
    { color: "#f2d24b", type: "highlight" },
    { lang: "en", type: "lang" },
    { href: "https://primjer.invalid/a?b=1", type: "link" },
    { pasteId: A, sourceId: B, type: "paste" },
    "imported",
  ];

  it("accepts every mark but sub together, in canonical order", () => {
    accepts(para(text("Izmišljeni tekst", all)));
    accepts(para(text("H", ["sub"])));
    accepts(para(text("x", [{ href: "mailto:netko@primjer.invalid", type: "link" }])));
    accepts(para(text("x", [{ pasteId: A, type: "paste" }])));
  });

  it("compares attributes for adjacent text (class 50)", () => {
    const lang = (value: string) => [{ lang: value, type: "lang" }];
    accepts(para(text("a", lang("en")), text("b", lang("de"))));
    expect(errorsOf(para(text("a", lang("en")), text("b", lang("en"))))).toEqual([
      ["$.nodes[0].children[1]", "ADJACENT_TEXT_SAME_MARKS"],
    ]);
    const link = (href: string) => [{ href, type: "link" }];
    accepts(
      para(
        text("a", link("https://primjer.invalid/1")),
        text("b", link("https://primjer.invalid/2")),
      ),
    );
  });
});

describe("variantGroup (§2.1, class 51)", () => {
  it("accepts a lowercase UUID v4 on a paragraph, even alone", () => {
    accepts(doc({ type: "paragraph", id: P, children: [], variantGroup: A }));
  });

  it("refuses nil, upper case and the field on another block", () => {
    for (const value of ["00000000-0000-0000-0000-000000000000", A.toUpperCase(), ""]) {
      expect(
        errorsOf(doc({ type: "paragraph", id: P, children: [], variantGroup: value })),
      ).toEqual([["$.nodes[0].variantGroup", "VARIANT_GROUP_INVALID"]]);
    }
    expect(
      errorsOf(doc({ type: "heading", id: P, level: 1, children: [], variantGroup: A })),
    ).toEqual([["$.nodes[0].variantGroup", "UNKNOWN_FIELD"]]);
  });
});

describe("formula (§4.1, class 52)", () => {
  it("accepts tex up to 4000 code points in a block and 1000 inline", () => {
    accepts(doc({ type: "formula", id: P, tex: "\\frac{a}{b}" }));
    accepts(doc({ type: "formula", id: P, tex: "x".repeat(4000) }));
    accepts(para(text("Neka je "), { type: "inlineFormula", tex: "x".repeat(1000) }));
  });

  it("refuses an empty, too long, untidy or missing tex", () => {
    for (const tex of ["", " x", "x ", "a\nb", "x".repeat(4001), 1]) {
      expect(errorsOf(doc({ type: "formula", id: P, tex }))).toEqual([
        ["$.nodes[0].tex", "FORMULA_TEX_INVALID"],
      ]);
    }
    expect(errorsOf(doc({ type: "formula", id: P }))).toEqual([
      ["$.nodes[0].tex", "FORMULA_TEX_INVALID"],
    ]);
    expect(errorsOf(para({ type: "inlineFormula", tex: "x".repeat(1001) }))).toEqual([
      ["$.nodes[0].children[0].tex", "FORMULA_TEX_INVALID"],
    ]);
    expect(errorsOf(para({ type: "inlineFormula", tex: "x", marks: [] }))).toEqual([
      ["$.nodes[0].children[0].marks", "UNKNOWN_FIELD"],
    ]);
  });

  it("refuses an inline formula in a heading", () => {
    expect(
      errorsOf(
        doc({ type: "heading", id: P, level: 2, children: [{ type: "inlineFormula", tex: "x" }] }),
      ),
    ).toEqual([["$.nodes[0].children[0]", "INLINE_FORMULA_NOT_ALLOWED"]]);
  });
});

describe("code block (§4.2, class 53)", () => {
  it("accepts text with line breaks, an empty block, a language and a caption", () => {
    accepts(
      doc({
        type: "codeBlock",
        id: P,
        children: [text("def prosjek(xs):\n    return sum(xs) / len(xs)")],
        language: "python",
        caption: "Funkcija za izračun prosjeka",
      }),
    );
    accepts(doc({ type: "codeBlock", id: P, children: [] }));
  });

  it("keeps the provenance marks paste and imported on code (§3.1, B-7)", () => {
    accepts(
      doc({
        type: "codeBlock",
        id: P,
        children: [
          text("x = 1\n", [{ pasteId: A, type: "paste" }]),
          text("y = 2", ["imported"]),
          text("\nz = 3", [{ pasteId: A, type: "paste" }, "imported"]),
        ],
      }),
    );
  });

  it("refuses a formatting mark, an atom, an unknown language and a long caption", () => {
    for (const marks of [
      ["bold"],
      ["sup"],
      [{ lang: "en", type: "lang" }],
      ["italic", "imported"],
    ]) {
      expect(errorsOf(doc({ type: "codeBlock", id: P, children: [text("x", marks)] }))).toEqual([
        ["$.nodes[0].children[0].marks", "CODE_CONTENT_INVALID"],
      ]);
    }
    expect(
      errorsOf(
        doc({ type: "codeBlock", id: P, children: [{ type: "footnote", text: "Bilješka." }] }),
      ),
    ).toEqual([["$.nodes[0].children[0]", "CODE_CONTENT_INVALID"]]);
    expect(errorsOf(doc({ type: "codeBlock", id: P, children: [], language: "cpp" }))).toEqual([
      ["$.nodes[0].language", "CODE_LANGUAGE_INVALID"],
    ]);
    expect(
      errorsOf(doc({ type: "codeBlock", id: P, children: [], caption: "x".repeat(301) })),
    ).toEqual([["$.nodes[0].caption", "CODE_CAPTION_INVALID"]]);
  });
});

describe("box (§4.3, class 54)", () => {
  const inner = (id: string) => ({
    type: "paragraph",
    id,
    children: [text("Izmišljena tvrdnja.")],
  });

  it("accepts every kind and two boxes of one kind in a row", () => {
    for (const kind of [
      "definition",
      "theorem",
      "lemma",
      "corollary",
      "example",
      "remark",
      "proof",
    ]) {
      accepts(doc({ type: "box", id: P, kind, children: [inner(Q)] }));
    }
    accepts(
      doc(
        { type: "box", id: P, kind: "theorem", children: [inner(Q)] },
        { type: "box", id: R, kind: "theorem", children: [inner(B)] },
      ),
    );
  });

  it("refuses an empty box, a non-paragraph child and an unknown kind", () => {
    expect(errorsOf(doc({ type: "box", id: P, kind: "theorem", children: [] }))).toEqual([
      ["$.nodes[0].children", "BOX_CHILDREN_INVALID"],
    ]);
    for (const child of [
      { type: "heading", id: Q, level: 1, children: [] },
      { type: "box", id: Q, kind: "proof", children: [inner(R)] },
      { type: "formula", id: Q, tex: "x" },
    ]) {
      expect(errorsOf(doc({ type: "box", id: P, kind: "proof", children: [child] }))).toEqual([
        ["$.nodes[0].children[0]", "BOX_CHILDREN_INVALID"],
      ]);
    }
    expect(errorsOf(doc({ type: "box", id: P, kind: "teorem", children: [inner(Q)] }))).toEqual([
      ["$.nodes[0].kind", "BOX_KIND_INVALID"],
    ]);
  });

  it("shares one id space with the blocks outside it", () => {
    expect(errorsOf(doc({ type: "box", id: P, kind: "proof", children: [inner(P)] }))).toEqual([
      ["$.nodes[0].children[0].id", "NODE_ID_DUPLICATE"],
    ]);
    expect(
      errorsOf(doc({ type: "box", id: P, kind: "proof", children: [inner(Q)] }, inner(Q))),
    ).toEqual([["$.nodes[1].id", "NODE_ID_DUPLICATE"]]);
  });
});

describe("page break (§4.4, class 55) and v3 atoms in v4", () => {
  it("takes no field besides type and id", () => {
    accepts(doc({ type: "pageBreak", id: P }));
    expect(errorsOf(doc({ type: "pageBreak", id: P, children: [] }))).toEqual([
      ["$.nodes[0].children", "UNKNOWN_FIELD"],
    ]);
  });

  it("keeps the v3 atoms and their rules", () => {
    accepts(
      para(
        { type: "citation", sourceId: A, locator: "str. 12", via: "Izmišljeni, 1973" },
        { type: "footnote", text: "Izmišljena bilješka." },
        { type: "crossReference", targetId: B },
      ),
    );
    expect(errorsOf(para({ type: "footnote", text: " x" }))).toEqual([
      ["$.nodes[0].children[0].text", "FOOTNOTE_TEXT_INVALID"],
    ]);
  });

  it("refuses a block type v4 does not have", () => {
    for (const type of ["orderedList", "prikaz", "tbox", "pagebreak"]) {
      expect(errorsOf(doc({ type, id: P }))).toEqual([["$.nodes[0].type", "NODE_TYPE_INVALID"]]);
    }
  });
});

describe("numbered list item (§2, P4)", () => {
  const item = (id: string, ...children: unknown[]) => ({ type: "orderedItem", id, children });

  it("accepts flat items with marks, atoms and an empty item", () => {
    accepts(
      doc(
        item(P, text("Prvi.", ["bold"]), { type: "footnote", text: "Izmišljena bilješka." }),
        item(Q),
        { type: "paragraph", id: R, children: [text("Prekid.")] },
        item(A, text("Novi popis.")),
      ),
    );
  });

  it("refuses nesting, an unknown field and a shared id", () => {
    expect(errorsOf(doc(item(P, item(Q))))).toEqual([
      ["$.nodes[0].children[0].type", "INLINE_TYPE_INVALID"],
    ]);
    expect(errorsOf(doc({ ...item(P), start: 3 }))).toEqual([
      ["$.nodes[0].start", "UNKNOWN_FIELD"],
    ]);
    expect(errorsOf(doc(item(P), item(P)))).toEqual([["$.nodes[1].id", "NODE_ID_DUPLICATE"]]);
  });

  it("is not a block of v1 to v3, which stay as they were", () => {
    for (const version of [1, 2, 3]) {
      const outcome = validateDocument({
        schemaVersion: version,
        nodes: [item(P, text("x"))],
        ...(version === 1 ? {} : { sources: [] }),
      });
      expect(outcome.ok).toBe(false);
    }
  });
});

describe("untrusted input", () => {
  it("returns errors, never throws, and does not share the input", () => {
    const junk: unknown[] = [
      null,
      [],
      { schemaVersion: 4, sources: [], nodes: [null, 1, "x", []] },
      doc({ type: "paragraph", id: P, children: new Array<unknown>(2).fill(text("a"), 1) }),
      doc({ type: "box", id: P, kind: "proof", children: "x" }),
      doc({ type: "codeBlock", id: P, children: [{ type: "text", text: "a", marks: "bold" }] }),
      para(text("a", [{ type: "lang", lang: { toString: () => "en" } }])),
    ];
    for (const value of junk) {
      expect(validateDocumentV4(value).ok).toBe(false);
    }
    const input = doc({
      type: "box",
      id: P,
      kind: "proof",
      children: [{ type: "paragraph", id: Q, children: [text("a")] }],
    });
    const outcome = validateDocumentV4(input);
    expect(outcome.ok && outcome.doc.nodes[0]).not.toBe(input.nodes[0]);
  });
});
