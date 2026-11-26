// @ductura/test-fakes (U9, DAN-741): test fakes, local and CI only (D-09).
// Importing it with NODE_ENV outside unset, development and test throws.
import "./guard/index.ts";

export * from "./clock/index.ts";
export * from "./dev-server/index.ts";
export * from "./fake-server/index.ts";
export * from "./fido2/index.ts";
export * from "./hostile-inputs/index.ts";
export * from "./invented-works/index.ts";
export * from "./oidc/index.ts";
export * from "./pglite/index.ts";
export * from "./services/index.ts";
