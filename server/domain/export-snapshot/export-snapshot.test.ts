import { describe, expect, it } from "vitest";
import type { InlineNodeV4, NodeId } from "../document/index.ts";
import { freezeExportSnapshot, type ExportSnapshotInput } from "./index.ts";

const PARAGRAPH_ID = "00000000-0000-4000-8000-000000000001" as NodeId;
const GOLDEN_JSON =
  '{"capabilityMap":{"box":"degraded","bulletItem":"degraded","citation":"omitted",' +
  '"codeBlock":"degraded","crossReference":"omitted","footnote":"omitted","formula":"degraded",' +
  '"heading":"exported","image":"omitted","inlineFormula":"degraded","pageBreak":"exported",' +
  '"paragraph":"exported","quote":"exported","table":"omitted","text":"exported"},' +
  '"cover":{"institution":"Demo učilište Oblak","mentor":"demo-mentor","student":"demo-student",' +
  '"unit":"Demo odjel","workType":"Seminar"},' +
  '"document":{"nodes":[{"children":[{"marks":["bold"],"text":"Čaj.","type":"text"},' +
  '{"text":"Izmišljena fusnota.","type":"footnote"}],' +
  '"id":"00000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":4,"sources":[]},' +
  '"expiresAt":"2030-01-02T00:00:00.000Z","kind":"saved",' +
  '"pageSetup":{"heightTwips":16838,"marginTwips":1418,"widthTwips":11906},"versionId":"demo-v1"}';

function revision(text = "Čaj.", extraNodes: InlineNodeV4[] = []) {
  return {
    document: {
      schemaVersion: 4,
      nodes: [
        {
          type: "paragraph",
          id: PARAGRAPH_ID,
          children: [
            { type: "text", text, marks: ["bold"] },
            { type: "footnote", text: "Izmišljena fusnota." },
            ...extraNodes,
          ],
        },
      ],
      sources: [],
    },
    versionId: "demo-v1",
    kind: "saved",
    pageSetup: { widthTwips: 11906, heightTwips: 16838, marginTwips: 1418 },
    cover: {
      institution: "Demo učilište Oblak",
      unit: "Demo odjel",
      workType: "Seminar",
      student: "demo-student",
      mentor: "demo-mentor",
    },
    expiresAt: "2030-01-02T00:00:00.000Z",
  } satisfies ExportSnapshotInput;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("freezeExportSnapshot", () => {
  it("matches the golden UTF-8 JSON and SHA-256 regardless of object key order", () => {
    const input = revision();
    const snapshot = freezeExportSnapshot(input);
    expect(snapshot.canonicalJson).toBe(GOLDEN_JSON);
    expect(snapshot.sha256).toBe(
      "89a7e17c9b2bc073f8ad321376e827d03527067462ceda6412a5c54a8982a1bf",
    );
    expect(freezeExportSnapshot(revision())).toEqual(snapshot);
    expect(
      freezeExportSnapshot({
        ...input,
        pageSetup: { marginTwips: 1418, widthTwips: 11906, heightTwips: 16838 },
        document: { sources: [], nodes: input.document.nodes, schemaVersion: 4 },
      }),
    ).toEqual(snapshot);
  });

  it("lists orderedItem in the capability map only for a document with a numbered list", () => {
    const withList = revision();
    const snapshot = freezeExportSnapshot({
      ...withList,
      document: {
        ...withList.document,
        nodes: [
          ...withList.document.nodes,
          {
            type: "orderedItem",
            id: "00000000-0000-4000-8000-000000000002" as NodeId,
            children: [{ type: "text", text: "Prvi.", marks: [] }],
          },
        ],
      },
    });
    expect(snapshot.capabilityMap.orderedItem).toBe("degraded");
    expect(freezeExportSnapshot(revision()).capabilityMap).not.toHaveProperty("orderedItem");
  });

  it("changes the fingerprint with a single character edit", () => {
    expect(freezeExportSnapshot(revision("Čaj!")).sha256).not.toBe(
      freezeExportSnapshot(revision()).sha256,
    );
  });

  it("binds the revision identity, kind, layout, cover and caller-supplied expiry", () => {
    const input = revision();
    const saved = freezeExportSnapshot(input);
    const submitted = freezeExportSnapshot({ ...input, kind: "submitted" });
    expect(submitted.kind).toBe("submitted");
    expect(submitted.sha256).not.toBe(saved.sha256);
    expect(saved.expiresAt).toBe(input.expiresAt);
    for (const other of [
      { ...input, versionId: "demo-v2" },
      { ...input, pageSetup: { ...input.pageSetup, marginTwips: 1500 } },
      { ...input, cover: { ...input.cover, place: "Demo Grad" } },
      { ...input, expiresAt: "2030-01-03T00:00:00.000Z" },
    ]) {
      expect(freezeExportSnapshot(other).sha256).not.toBe(saved.sha256);
    }
  });

  it("freezes every object and array in a detached copy", () => {
    const input = revision();
    const snapshot = freezeExportSnapshot(input);
    expectDeepFrozen(snapshot);

    input.document.nodes[0]!.children.length = 0;
    input.document.nodes.length = 0;
    input.cover.institution = "Demo učilište Drugo";
    input.pageSetup.marginTwips = 2000;
    expect(snapshot.document).toEqual(revision().document);
    expect(snapshot.cover).toEqual(revision().cover);
    expect(snapshot.pageSetup).toEqual(revision().pageSetup);
  });

  it.each(["futureInline", "__proto__"])("records an unknown node type %s as omitted", (type) => {
    // Exercise version skew at runtime despite the closed CanonicalDocumentV4 union.
    const futureNode = {
      type,
      children: [null, { type: "futureLeaf", children: "Demo tekst budućeg čvora." }],
    } as unknown as InlineNodeV4;
    const input = revision("Čaj.", [futureNode]);
    const snapshot = freezeExportSnapshot(input);
    expect(Object.hasOwn(snapshot.capabilityMap, type)).toBe(true);
    expect(snapshot.capabilityMap[type]).toBe("omitted");
    expect(snapshot.capabilityMap.futureLeaf).toBe("omitted");
    expect(snapshot.capabilityMap.footnote).toBe("omitted");
    expect(snapshot.capabilityMap.inlineFormula).toBe("degraded");
    expect(snapshot.capabilityMap.paragraph).toBe("exported");
    expect(snapshot.document).toEqual(input.document);
  });
});
