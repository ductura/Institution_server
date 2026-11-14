import { authRoutes, FALLBACK, platformRoutes, profileRoutes } from "./routes/index.ts";
import type { RouteContract } from "./schema/index.ts";

export { FALLBACK };
export { checkInventory } from "./check.ts";
export { INVENTORY, INVENTORY_SOURCE, PENDING } from "./inventory.ts";
export * from "./schema/index.ts";

/** Every route of /api/v1 with a contract. */
export const ROUTES: readonly RouteContract[] = [...platformRoutes, ...authRoutes, ...profileRoutes];
