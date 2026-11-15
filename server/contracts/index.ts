import {
  authRoutes,
  evidenceRoutes,
  FALLBACK,
  INTERNAL,
  platformRoutes,
  profileRoutes,
} from "./routes/index.ts";
import type { RouteContract } from "./schema/index.ts";

export { breakingChanges } from "./breaking.ts";
export { API_VERSION } from "./version.ts";

export { FALLBACK, INTERNAL };
export { SHARED_ERRORS } from "./routes/index.ts";
export { MAX_COMMIT_BODY_BYTES } from "./routes/index.ts";
export { checkInventory } from "./check.ts";
export { INVENTORY, INVENTORY_SOURCE, PENDING } from "./inventory.ts";
export * from "./schema/index.ts";
export {
  checkVectors,
  VectorFileSchema,
  type SchemaCheck,
  type Vector,
  type VectorFile,
} from "./vectors.ts";
export { isWorkId, WORK_ID_MAX, workIdFromPath } from "./work-id.ts";

/** Every route of /api/v1 with a contract. */
export const ROUTES: readonly RouteContract[] = [
  ...platformRoutes,
  ...authRoutes,
  ...profileRoutes,
  ...evidenceRoutes,
];
