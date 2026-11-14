// Public interface of the in-memory AWS KMS stand-in (local runs and CI only,
// DAN-295). Production code never imports test-support (docs/server-map.md §2).
export { FakeKmsClient } from "./fake-kms-client.ts";
