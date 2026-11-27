// NAC-F1-SRV dry run: node scripts/load/nac/sat-pisanja-proba.ts
// One synthetic user, no stack, nothing is sent. Prints the counts as JSON and
// the sentence for docs/nalazi/nacionalni-opseg/sat-pisanja.md.

import { REVISION_ZERO_JCS, REVISION_ZERO_SHA256 } from "../../../server/domain/index.ts";
import type { OpenedWork } from "../index.ts";

import { simulateHour, summarize } from "./sat-pisanja.ts";

const work: OpenedWork = {
  documentId: "11111111-1111-4111-8111-111111111111",
  document: Buffer.from(REVISION_ZERO_JCS, "utf8").toString("base64"),
  documentHash: REVISION_ZERO_SHA256,
  evidenceProfileId: "22222222-2222-4222-8222-222222222222",
};

const counts = simulateHour(work, "2026-11-26T10:00:00.000Z", 1);
console.log(JSON.stringify(counts, null, 2));
console.log(summarize(counts));
