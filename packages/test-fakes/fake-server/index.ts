// The contract fake server (U8) as part of @ductura/test-fakes (U9). Re-exported,
// not copied: scripts/generate-contracts.ts keeps writing it next to the
// contracts, and generated = committed stays checked there.
import "../guard/index.ts";

export * from "../../../server/contracts/generated/fake-server/index.ts";
