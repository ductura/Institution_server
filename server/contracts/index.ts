import { authRoutes } from "./routes/auth.ts";
import { FALLBACK, platformRoutes } from "./routes/platform.ts";
import { profileRoutes } from "./routes/profile.ts";
import type { RouteContract } from "./schema.ts";

export { breakingChanges } from "./breaking.ts";
export { API_VERSION } from "./version.ts";

export { FALLBACK };
export * from "./schema.ts";

/** Every route of /api/v1 with a contract. */
export const ROUTES: readonly RouteContract[] = [...platformRoutes, ...authRoutes, ...profileRoutes];
