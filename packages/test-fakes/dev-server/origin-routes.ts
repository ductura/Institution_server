// The composition of a work by kind of origin on the dev fake server
// (work.origin-composition.get, SRV-0910): the owner and the readers of the
// work (readerOf) read the same invented shares, anyone else reads 404. The
// real rules are app.work_origin_composition; the fake records nothing.
// work.origin-segments.get (SRV-KARTA-RASPON) answers invented ranges of one
// invented revision in the same way: the revision asked below it is none.
// work.origin-segments.post (SRV-KARTA-RASPON-RUTA) lets only the owner record
// the ranges of a revision, once (a second time is 409, an empty range 422);
// the read then answers the latest recorded revision at or below the one asked,
// the invented ranges while nothing is recorded.
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

/** The invented shares the fake answers, in the order of the closed list. */
export const FAKE_ORIGIN_SHARES = [
  { kind: "typed", percent: 70 },
  { kind: "assistant_inserted", percent: 10 },
  { kind: "assistant_match", percent: 0 },
  { kind: "imported_file", percent: 10 },
  { kind: "pasted_known", percent: 5 },
  { kind: "pasted_unknown", percent: 5 },
] as const;

/** The invented revision the fake's ranges belong to. */
export const FAKE_ORIGIN_SEGMENTS_REVISION = 3;
const BLOCK_A = "1b0c2d3e-4f50-4a61-8b72-0c1d2e3f4a51";
const BLOCK_B = "2c1d0e9f-8a7b-4c6d-9e5f-1a2b3c4d5e62";

/** Invented ranges of two blocks; the assistant match carries its segmentRef. */
export const FAKE_ORIGIN_SEGMENTS = [
  { blockId: BLOCK_A, start: 0, end: 64, kind: "typed", segmentRef: null },
  { blockId: BLOCK_A, start: 64, end: 140, kind: "assistant_match", segmentRef: "odlomak-1" },
  { blockId: BLOCK_B, start: 0, end: 30, kind: "pasted_known", segmentRef: null },
  { blockId: BLOCK_B, start: 30, end: 90, kind: "imported_file", segmentRef: null },
  { blockId: BLOCK_B, start: 90, end: 120, kind: "assistant_inserted", segmentRef: null },
  { blockId: BLOCK_B, start: 120, end: 132, kind: "pasted_unknown", segmentRef: null },
] as const;

type Recorded = { documentId: string; revision: number; segments: Segment[] };
type Segment = {
  blockId: string;
  start: number;
  end: number;
  kind: (typeof FAKE_ORIGIN_SHARES)[number]["kind"];
  segmentRef: string | null;
};
const RECORDED = new WeakMap<object, Recorded[]>();

export const ORIGIN_HANDLERS: Handlers = {
  "work.origin-composition.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    return {
      status: 200,
      body: {
        parts: FAKE_ORIGIN_SHARES.map((share) => ({ ...share })),
      },
    };
  },
  "work.origin-segments.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const asked = query.revision === undefined ? null : Number(query.revision);
    if (asked !== null && !Number.isSafeInteger(asked)) return { error: "invalid_input" };
    const recorded = (RECORDED.get(state) ?? [])
      .filter((r) => r.documentId === work.documentId && (asked === null || r.revision <= asked))
      .sort((a, b) => b.revision - a.revision)[0];
    if (recorded !== undefined) {
      return {
        status: 200,
        body: { revision: recorded.revision, segments: recorded.segments.map((s) => ({ ...s })) },
      };
    }
    if (asked !== null && asked < FAKE_ORIGIN_SEGMENTS_REVISION) {
      return { status: 200, body: { revision: null, segments: [] } };
    }
    return {
      status: 200,
      body: {
        revision: FAKE_ORIGIN_SEGMENTS_REVISION,
        segments: FAKE_ORIGIN_SEGMENTS.map((segment) => ({ ...segment })),
      },
    };
  },
  "work.origin-segments.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "owner") {
      return { error: "not_found" };
    }
    const input = body as {
      revision: number;
      segments: (Omit<Segment, "segmentRef"> & { segmentRef?: string })[];
    };
    if (input.segments.some((s) => s.end <= s.start)) return { error: "invalid_input" };
    const all = RECORDED.get(state) ?? [];
    if (all.some((r) => r.documentId === work.documentId && r.revision === input.revision)) {
      return { error: "conflict" };
    }
    all.push({
      documentId: work.documentId,
      revision: input.revision,
      segments: input.segments.map((s) => ({
        blockId: s.blockId,
        start: s.start,
        end: s.end,
        kind: s.kind,
        segmentRef: s.segmentRef ?? null,
      })),
    });
    RECORDED.set(state, all);
    return { status: 201, body: { revision: input.revision, recorded: input.segments.length } };
  },
};
