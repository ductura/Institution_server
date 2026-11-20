import { describe, expect, it } from "vitest";

import {
  EDIT_STEP_FORMAT_V1,
  EDIT_STEP_FORMAT_V2,
  EDIT_STEP_FORMAT_V3,
  parseEditSteps,
} from "./edit-step.ts";

/**
 * Parser of `ductus-edit-steps-v3`, docs/contracts/document-schema-v3.md §5
 * and §10 classes 41 to 43 as far as the step alone can tell (SRV-7A). What
 * needs the document (a hash that does not match, a range inside an atom) is
 * tested on the replayer. Synthetic data only.
 */

const SRC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HEAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RQ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const cite = (over: object = {}) => ({ type: "citation", sourceId: SRC, ...over });
const note = (text = "Objašnjenje.") => ({ type: "footnote", text });
const ref = (targetId: unknown = HEAD) => ({ type: "crossReference", targetId });
const text = (value: string) => ({ type: "text", text: value });
const insert = (content: unknown[], at = 1) => ({
  stepType: "replace",
  from: at,
  to: at,
  slice: { content },
});
/** `setNodeMarkup` on a leaf: its one position replaced by the new atom. */
const swap = (atom: unknown, at = 1) => ({
  stepType: "replace",
  from: at,
  to: at + 1,
  removedSha256: HASH,
  slice: { content: [atom] },
});

const v3 = (...steps: unknown[]) => parseEditSteps(EDIT_STEP_FORMAT_V3, steps);
const refused = (code: string, path: string) => ({ ok: false, code, path });

describe("atoms in a slice of ductus-edit-steps-v3 (class 41)", () => {
  it("reads every atom in its document form, keys sorted, nothing added", () => {
    const result = v3(
      insert([
        text("a"),
        cite({ via: "Izmišljeni, 1973", rq: RQ, locator: "str. 12" }),
        note(),
        ref(),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = (result.steps[0] as { slice: { content: unknown[] } }).slice.content;
    expect(JSON.stringify(content)).toBe(
      `[{"text":"a","type":"text"},{"locator":"str. 12","rq":"${RQ}","sourceId":"${SRC}","type":"citation","via":"Izmišljeni, 1973"},{"text":"Objašnjenje.","type":"footnote"},{"targetId":"${HEAD}","type":"crossReference"}]`,
    );
  });

  it("reads atoms inside blocks, never in a heading", () => {
    const block = (type: string, content: unknown[], attrs: object = {}) => ({
      type,
      attrs: { nodeId: null, ...attrs },
      content,
    });
    expect(v3(insert([block("paragraph", [note(), ref()])], 0)).ok).toBe(true);
    for (const [i, atom] of [cite(), note(), ref()].entries()) {
      const heading = block("heading", [text("Naslov"), atom], { level: 2 });
      expect(v3(insert([heading], 0)), String(i)).toEqual(
        refused("invalid_node", "$[0].slice.content[0].content[1].type"),
      );
    }
  });

  it("refuses an invalid field of an atom with invalid_value at that field", () => {
    const cases: [unknown, string][] = [
      [cite({ via: "" }), ".via"],
      [cite({ via: " Izmišljeni" }), ".via"],
      [cite({ via: "v".repeat(201) }), ".via"],
      [cite({ rq: "rqabc123" }), ".rq"],
      [cite({ rq: RQ.toUpperCase() }), ".rq"],
      [note(""), ".text"],
      [note("a\nb"), ".text"],
      [note("f".repeat(2001)), ".text"],
      [ref("00000000-0000-0000-0000-000000000000"), ".targetId"],
      [ref(HEAD.toUpperCase()), ".targetId"],
    ];
    for (const [atom, field] of cases) {
      expect(v3(insert([atom])), JSON.stringify(atom).slice(0, 60)).toEqual(
        refused("invalid_value", `$[0].slice.content[0]${field}`),
      );
    }
    expect(v3(insert([cite({ via: "v".repeat(200) })])).ok).toBe(true);
    expect(v3(insert([note("f".repeat(2000))])).ok).toBe(true);
  });

  it("refuses an unknown field of an atom", () => {
    expect(v3(insert([{ ...note(), marks: [] }]))).toEqual(
      refused("unknown_field", "$[0].slice.content[0].marks"),
    );
    expect(v3(insert([{ ...ref(), kind: "h" }]))).toEqual(
      refused("unknown_field", "$[0].slice.content[0].kind"),
    );
  });

  it("does not take text with the same marks on both sides of an atom as neighbours", () => {
    expect(v3(insert([text("a"), note(), text("b")])).ok).toBe(true);
  });

  it("asks removedSha256 of a step that removes a range, as v2 does", () => {
    expect(v3({ stepType: "replace", from: 1, to: 2 })).toEqual(
      refused("missing_field", "$[0].removedSha256"),
    );
  });
});

describe("a change of an atom's attributes is a replace (class 42)", () => {
  it.each([
    ["footnote text", note("Drugo objašnjenje.")],
    ["via", cite({ via: "Druga, 1980" })],
    ["rq set", cite({ rq: RQ })],
    ["locator", cite({ locator: "str. 13" })],
    ["target", ref("dddddddd-dddd-4ddd-8ddd-dddddddddddd")],
  ])("%s: one position replaced with the hash of the old atom", (_, atom) => {
    expect(v3(swap(atom)).ok).toBe(true);
    const withoutHash: Record<string, unknown> = { ...swap(atom) };
    delete withoutHash.removedSha256;
    expect(v3(withoutHash)).toEqual(refused("missing_field", "$[0].removedSha256"));
  });

  it("attr still sets only a block's nodeId", () => {
    expect(v3({ stepType: "attr", pos: 1, attr: "text", value: "x" })).toEqual(
      refused("invalid_value", "$[0].attr"),
    );
  });
});

describe("earlier formats do not read what v3 adds (class 43)", () => {
  it("v1 refuses every atom, v2 the footnote and the cross reference", () => {
    for (const atom of [cite(), note(), ref()]) {
      expect(parseEditSteps(EDIT_STEP_FORMAT_V1, [insert([atom])])).toEqual(
        refused("invalid_node", "$[0].slice.content[0].type"),
      );
    }
    for (const atom of [note(), ref()]) {
      expect(parseEditSteps(EDIT_STEP_FORMAT_V2, [insert([atom])])).toEqual(
        refused("invalid_node", "$[0].slice.content[0].type"),
      );
    }
  });

  it("v2 refuses via and rq on a citation as unknown fields", () => {
    expect(parseEditSteps(EDIT_STEP_FORMAT_V2, [insert([cite({ via: "Izmišljeni" })])])).toEqual(
      refused("unknown_field", "$[0].slice.content[0].via"),
    );
    expect(parseEditSteps(EDIT_STEP_FORMAT_V2, [insert([cite({ rq: RQ })])])).toEqual(
      refused("unknown_field", "$[0].slice.content[0].rq"),
    );
  });

  it("v3 keeps the source steps of v2", () => {
    expect(v3({ stepType: "sourceRemove", sourceId: SRC, removedSha256: HASH }).ok).toBe(true);
  });
});
