import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SHEET_REVISION_ZERO_SHA256,
  SLIDES_REVISION_ZERO_HASH,
} from "../../server/database/evidence-work-version.ts";
import { sheetRevisionZeroDocument } from "../../server/domain/sheet/index.ts";
import {
  SLIDES_REVISION_ZERO_JCS,
  SLIDES_REVISION_ZERO_SHA256,
  slidesRevisionZeroDocument,
} from "../../server/domain/slides/revision-zero.ts";
import { createEditStepsV1Replayer } from "../../server/external/storage/edit-steps-v1-replayer.ts";
import {
  REVISION_ZERO_JCS,
  revisionZeroDocument,
} from "../../server/domain/document/revision-zero.ts";
import { MAX_EVIDENCE_SEGMENT_BYTES } from "../../server/domain/forensics/evidence-chain-v2.ts";
import { EVIDENCE_PROFILE_ID } from "../../server/domain/forensics/evidence-profile.ts";
import { canonicalizeJcs } from "../../server/domain/forensics/jcs.ts";

// B-8 step 2 / DAN-83: app.open_student_work writes revision 0, the capture
// profile and the payload limit as SQL literals. pgTAP checks the stored
// bytes and hash against the same literals (db/tests/046-evidence-open-work.sql);
// this keeps the migration and the TypeScript constants from drifting apart.
const MIGRATION = "20261019150000_evidence_open_work.sql";
const TEXT = readFileSync(
  new URL(`../../db/main/migrations/${MIGRATION}`, import.meta.url),
  "utf8",
);
const UP = TEXT.slice(0, TEXT.indexOf("-- migrate:down"));

describe("open_student_work migration", () => {
  it("stores the revision 0 bytes of src/domain/document/revision-zero.ts", () => {
    expect(UP).toContain(`'${REVISION_ZERO_JCS}'::text`);
  });

  it("gives the package the shared capture profile and the D-96 payload limit", () => {
    expect(UP).toContain(
      `v_actor.user_id, '${EVIDENCE_PROFILE_ID}', ${MAX_EVIDENCE_SEGMENT_BYTES}`,
    );
  });
});

// F4-V13-R01: the slides revision 0 the database writes is the bytes and hash of the slides domain,
// and the hash the opener names a slides work by is the same one.
describe("open_student_work slides migration", () => {
  const SLIDES_MIGRATION = readFileSync(
    new URL("../../db/main/migrations/20261220590000_open_work_slides.sql", import.meta.url),
    "utf8",
  );

  it("stores the revision 0 bytes of server/domain/slides/revision-zero.ts", () => {
    expect(SLIDES_MIGRATION).toContain(`'${SLIDES_REVISION_ZERO_JCS}'::text`);
    expect(canonicalizeJcs(slidesRevisionZeroDocument())).toBe(SLIDES_REVISION_ZERO_JCS);
    expect(createHash("sha256").update(SLIDES_REVISION_ZERO_JCS, "utf8").digest("hex")).toBe(
      SLIDES_REVISION_ZERO_SHA256,
    );
  });

  it("stores the spreadsheet revision 0 bytes of server/domain/sheet, hash SHEET_REVISION_ZERO_SHA256", () => {
    const jcs = canonicalizeJcs(sheetRevisionZeroDocument());
    expect(SLIDES_MIGRATION).toContain(`'${jcs}'::text`);
    expect(createHash("sha256").update(jcs, "utf8").digest("hex")).toBe(SHEET_REVISION_ZERO_SHA256);
  });

  it("is the hash the opener names a slides work by", () => {
    expect(SLIDES_REVISION_ZERO_HASH).toBe(SLIDES_REVISION_ZERO_SHA256);
  });
});

describe("revision 0 through the editor's replayer", () => {
  it("loads and returns the same canonical bytes, so B-12 starts from them", () => {
    const replayer = createEditStepsV1Replayer();
    const loaded = replayer.load(revisionZeroDocument());
    expect(canonicalizeJcs(replayer.toCanonical(loaded))).toBe(REVISION_ZERO_JCS);
  });
});
