// LOK-SRV-V3: the dev fake server confirms the schema version of a work in
// evidence.open.post as the real server does (SRV-7F), and can start works of
// schema 3 for local checks of the v3 editor (DUCTURA_LAZNI_SHEMA=3).
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { REVISION_ZERO_V3_JCS, REVISION_ZERO_V3_SHA256 } from "../../../server/domain/index.ts";
import { createState, devWorkSchema, EMPTY_DOCUMENT, IDS, type State } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

const EVIDENCE = { "ductus-protocol": "1" };
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function open(state: State) {
  const headers = await signIn(state, "student");
  const opened = await send(state, "/api/v1/evidence/open", {
    body: { assignmentId: IDS.assignment },
    headers: { ...headers, ...EVIDENCE },
  });
  expect(contractProblems("evidence.open.post", opened)).toEqual([]);
  return opened.json as {
    schemaVersion?: number;
    revisionZeroHash?: string;
    document: string;
    documentHash: string;
  };
}

describe("dev fake server: schema version of a work (LOK-SRV-V3)", () => {
  it("confirms schema 1 and the hash of revision 0 by default", async () => {
    const opened = await open(createState());
    expect(opened.schemaVersion).toBe(1);
    expect(opened.revisionZeroHash).toBe(sha256(Buffer.from(EMPTY_DOCUMENT, "base64")));
    expect(opened.document).toBe(EMPTY_DOCUMENT);
  });

  it("starts a schema 3 work from the revision 0 the real server writes", async () => {
    const opened = await open(createState(undefined, 3));
    const bytes = Buffer.from(opened.document, "base64");
    expect(bytes.toString("utf8")).toBe(REVISION_ZERO_V3_JCS);
    expect(opened.schemaVersion).toBe(3);
    expect(opened.revisionZeroHash).toBe(REVISION_ZERO_V3_SHA256);
    expect(opened.documentHash).toBe(REVISION_ZERO_V3_SHA256);
  });

  it("keeps schema 3 after a reset and for a newly started work", async () => {
    const state = createState(undefined, 3);
    expect((await send(state, "/__lazni/ponovno", { method: "POST" })).status).toBe(200);
    state.works.length = 0;
    const headers = await signIn(state, "student");
    const started = await send(state, "/api/v1/evidence/open", {
      body: { assignmentId: IDS.assignment, start: true },
      headers: { ...headers, ...EVIDENCE },
    });
    expect(contractProblems("evidence.open.post", started)).toEqual([]);
    expect(started.json).toMatchObject({
      schemaVersion: 3,
      revisionZeroHash: REVISION_ZERO_V3_SHA256,
    });
    expect(state.works[0]?.revisionZero).toBe(Buffer.from(REVISION_ZERO_V3_JCS).toString("base64"));
  });

  it("reads DUCTURA_LAZNI_SHEMA as 1 or 3 and refuses anything else", () => {
    expect(devWorkSchema({})).toBe(1);
    expect(devWorkSchema({ DUCTURA_LAZNI_SHEMA: "" })).toBe(1);
    expect(devWorkSchema({ DUCTURA_LAZNI_SHEMA: "1" })).toBe(1);
    expect(devWorkSchema({ DUCTURA_LAZNI_SHEMA: "3" })).toBe(3);
    for (const bad of ["2", "4", "v3", " 3"])
      expect(devWorkSchema({ DUCTURA_LAZNI_SHEMA: bad })).toMatch(/only 1 or 3/u);
  });
});
