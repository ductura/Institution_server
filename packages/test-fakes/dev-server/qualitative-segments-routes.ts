// The marked passages and the export of qualitative coding on the dev fake
// server (SRV-V18-KODIRANJE-OZNAKE): a student's own passages in their own
// material, with their own codes. Another account reads the same 404 as for an
// unknown id (C-23). The real rules (the quote must be exactly the characters it
// points at, the 5000 limit) are the database's; the fake checks the quote
// against the text and keeps the passages in a WeakMap keyed by the state, so a
// reset of the state takes them with it. Nothing here suggests a code. Made-up
// data only.
import { createHash } from "node:crypto";

import { fakeQualCodebookOf } from "./qualitative-codes-routes.ts";
import { fakeQualMaterialsOf } from "./qualitative-materials-routes.ts";
import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

type Segment = {
  id: string;
  materialId: string;
  codeId: string;
  paragraph: number;
  start: number;
  end: number;
  quote: string;
  memo: string | null;
  createdOn: string;
};

/** The invented id of a passage: of its material, code and place, so a test can name it. */
export const fakeQualSegmentId = (
  materialId: string,
  codeId: string,
  paragraph: number,
  start: number,
  end: number,
): string =>
  `7c000002-0000-4000-8000-${createHash("sha256").update(`${materialId}:${codeId}:${paragraph}:${start}:${end}`).digest("hex").slice(0, 12)}`;

const SEGMENTS = new WeakMap<State, Map<string, Segment[]>>();
const MAX_SEGMENTS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function ownOf(state: State, accountId: string): Segment[] {
  let all = SEGMENTS.get(state);
  if (all === undefined) SEGMENTS.set(state, (all = new Map()));
  let own = all.get(accountId);
  if (own === undefined) all.set(accountId, (own = []));
  return own;
}

/** For a scenario that needs a marked passage before the request. */
export function seedQualSegment(
  state: State,
  accountId: string,
  segment: Omit<Segment, "id" | "createdOn">,
): void {
  ownOf(state, accountId).push({
    ...segment,
    id: fakeQualSegmentId(
      segment.materialId,
      segment.codeId,
      segment.paragraph,
      segment.start,
      segment.end,
    ),
    createdOn: "2026-11-25",
  });
  const material = fakeQualMaterialsOf(state, accountId).find((m) => m.id === segment.materialId);
  if (material !== undefined) material.segmentCount += 1;
}

const wire = ({ materialId: _materialId, ...segment }: Segment) => segment;
const byText = (a: Segment, b: Segment) =>
  a.paragraph - b.paragraph || a.start - b.start || a.end - b.end;

export const QUALITATIVE_SEGMENTS_HANDLERS = {
  "student.qual-segments.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const id = params.id.toLowerCase();
    if (!fakeQualMaterialsOf(state, account.id).some((m) => m.id === id)) {
      return { error: "not_found" };
    }
    const segments = ownOf(state, account.id)
      .filter((s) => s.materialId === id)
      .sort(byText)
      .map(wire);
    return { status: 200, body: { segments } };
  },
  "student.qual-segments.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const id = params.id.toLowerCase();
    const material = fakeQualMaterialsOf(state, account.id).find((m) => m.id === id);
    if (material === undefined) return { error: "not_found" };
    if (!fakeQualCodebookOf(state, account.id).some((c) => c.id === body.codeId)) {
      return { error: "not_found" };
    }
    const { paragraph, start, end, quote } = body.anchor;
    const line = material.text.split("\n")[paragraph];
    const characters = [...(line ?? "")];
    if (
      line === undefined ||
      end <= start ||
      end - start > 500 ||
      characters.slice(start, end).join("") !== quote ||
      quote.replace(/[ \t]/gu, "") === ""
    ) {
      return { error: "invalid_input" };
    }
    const own = ownOf(state, account.id);
    const mine = own.filter((s) => s.materialId === id);
    if (
      mine.length >= MAX_SEGMENTS ||
      mine.some(
        (s) =>
          s.codeId === body.codeId &&
          s.paragraph === paragraph &&
          s.start === start &&
          s.end === end,
      )
    ) {
      return { error: "conflict" };
    }
    const created: Segment = {
      id: fakeQualSegmentId(id, body.codeId, paragraph, start, end),
      materialId: id,
      codeId: body.codeId,
      paragraph,
      start,
      end,
      quote,
      memo: body.memo ?? null,
      createdOn: new Date().toISOString().slice(0, 10),
    };
    own.push(created);
    material.segmentCount += 1;
    return { status: 201, body: wire(created) };
  },
  "student.qual-segment.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const own = ownOf(state, account.id);
    const index = own.findIndex((s) => s.id === params.id.toLowerCase());
    if (index === -1) return { error: "not_found" };
    const [removed] = own.splice(index, 1);
    const material = fakeQualMaterialsOf(state, account.id).find(
      (m) => m.id === removed?.materialId,
    );
    if (material !== undefined && material.segmentCount > 0) material.segmentCount -= 1;
    return { status: 204 };
  },
  "student.qual-export.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    const materials = fakeQualMaterialsOf(state, account.id);
    const wanted = query.materialId;
    if (
      wanted !== undefined &&
      (!UUID.test(wanted) || !materials.some((m) => m.id === wanted.toLowerCase()))
    ) {
      return { error: "not_found" };
    }
    const codebook = fakeQualCodebookOf(state, account.id);
    const place = (s: Segment) => [
      codebook.findIndex((c) => c.id === s.codeId),
      materials.findIndex((m) => m.id === s.materialId),
    ];
    const segments = ownOf(state, account.id)
      .filter((s) => wanted === undefined || s.materialId === wanted.toLowerCase())
      .sort((a, b) => {
        const [ac, am] = place(a);
        const [bc, bm] = place(b);
        return ac! - bc! || am! - bm! || byText(a, b);
      });
    const counts: { code: string; material: string; n: number }[] = [];
    for (const s of segments) {
      const last = counts[counts.length - 1];
      if (last !== undefined && last.code === s.codeId && last.material === s.materialId)
        last.n += 1;
      else counts.push({ code: s.codeId, material: s.materialId, n: 1 });
    }
    return {
      status: 200,
      body: {
        schema: "qualitative-export-v1",
        codebook: codebook.map((c) => ({ code: c.id, name: c.name, description: c.description })),
        segments: segments.map((s) => ({
          material: s.materialId,
          code: s.codeId,
          paragraph: s.paragraph,
          start: s.start,
          end: s.end,
          quote: s.quote,
          memo: s.memo,
        })),
        counts,
      },
    };
  },
} satisfies Partial<Handlers>;
