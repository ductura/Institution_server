// The routes of every area with a routes.ts, by area name. The entry point
// (server/server.ts) names the areas it mounts; it may not import the areas
// itself (docs/server-map.md §2, ENTRY_IMPORTS), so http does. The Record
// type asks for exactly one key per name, and server/server.test.ts checks the
// names against the folders on disk. test-server is not here: it is its own
// composition root and nobody imports it.
import { BACKUP_ROUTES } from "../backup/index.ts";
import { DELETION_ROUTES } from "../deletion/index.ts";
import { DOWNLOADS_ROUTES } from "../downloads/index.ts";
import { EMAIL_ROUTES } from "../external/email/index.ts";
import { LEGAL_ROUTES } from "../legal/index.ts";
import { METRICS_ROUTES } from "../metrics/index.ts";
import { ROLES_ROUTES } from "../roles/index.ts";
import { SETTINGS_ROUTES } from "../settings/index.ts";
import { TRAFFIC_ROUTES } from "../traffic/index.ts";
import type { Route } from "./router.ts";

export const AREA_NAMES = [
  ...["traffic", "metrics", "settings", "roles", "legal", "backup", "deletion"],
  ...["downloads", "external/email"],
] as const;
export type AreaWithRoutes = (typeof AREA_NAMES)[number];

export const AREA_ROUTES: Readonly<Record<AreaWithRoutes, readonly Route[]>> = {
  traffic: TRAFFIC_ROUTES,
  metrics: METRICS_ROUTES,
  settings: SETTINGS_ROUTES,
  roles: ROLES_ROUTES,
  legal: LEGAL_ROUTES,
  backup: BACKUP_ROUTES,
  deletion: DELETION_ROUTES,
  downloads: DOWNLOADS_ROUTES,
  "external/email": EMAIL_ROUTES,
};

/** The routes of the named areas, in the order named. */
export function routesOf(areas: readonly AreaWithRoutes[]): Route[] {
  return areas.flatMap((area) => AREA_ROUTES[area]);
}
