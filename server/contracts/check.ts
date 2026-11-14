// Checks a set of contracts against the format and the route inventory. The
// generator refuses to write while any problem is reported.
import { ACCESS, API_PREFIX, type Method, type RouteContract } from "./schema/index.ts";

/** app/api/a/[b]/route.ts -> /api/v1/a/{b} */
export function pathOf(inventoryFile: string): string {
  const inner = inventoryFile.replace(/^app\/api\//, "").replace(/\/?route\.ts$/, "");
  return `${API_PREFIX}/${inner.replace(/\[([A-Za-z]+)\]/g, "{$1}")}`;
}

export function checkRoute(route: RouteContract): string[] {
  const problems: string[] = [];
  const at = (text: string) => problems.push(`${route.id}: ${text}`);
  if (!/^[a-z][a-z-]*(\.[a-z][a-z-]*)+\.(get|post|put|patch|delete)$/.test(route.id))
    at("id format");
  if (!route.id.endsWith(`.${route.method.toLowerCase()}`)) at("id does not end with the method");
  if (!(ACCESS as readonly string[]).includes(route.access)) at("access outside the closed set");
  if (!route.path.startsWith(`${API_PREFIX}/`)) at(`path outside ${API_PREFIX}`);
  if (route.path !== pathOf(route.inventory)) at(`path is not ${pathOf(route.inventory)}`);
  const names = [...route.path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();
  const declared = Object.keys(route.request.params?.properties ?? {}).sort();
  if (names.join() !== declared.join()) at("path parameters and request.params differ");
  if (route.request.body && (!route.request.contentType || !route.request.maxBodyBytes))
    at("body without type or limit");
  if (!route.responses.some((r) => r.status >= 200 && r.status < 400)) at("no success response");
  const seen = new Set<string>();
  for (const e of route.errors) {
    if (e.status < 400 || e.status > 599) at(`error status ${e.status}`);
    if (!/^[a-z][a-z_]*$/.test(e.code)) at(`error code ${e.code}`);
    if (e.key !== `errors.${e.code}`) at(`error key ${e.key}`);
    if (seen.has(`${e.status} ${e.code}`)) at(`duplicate error ${e.status} ${e.code}`);
    seen.add(`${e.status} ${e.code}`);
  }
  return problems;
}

export function checkInventory(
  routes: readonly RouteContract[],
  inventory: Readonly<Record<string, readonly Method[]>>,
  pending: readonly string[],
  fallbackFile: string,
): string[] {
  const problems = routes.flatMap(checkRoute);
  const ids = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) problems.push(`${route.id}: duplicate id`);
    ids.add(route.id);
    if (!inventory[route.inventory])
      problems.push(`${route.id}: ${route.inventory} is not in the inventory`);
    if (pending.includes(route.inventory))
      problems.push(`${route.id}: ${route.inventory} is also pending`);
  }
  for (const [file, methods] of Object.entries(inventory)) {
    if (file === fallbackFile || pending.includes(file)) continue;
    const have = routes
      .filter((r) => r.inventory === file)
      .map((r) => r.method)
      .sort();
    if (have.join() !== [...methods].sort().join())
      problems.push(`${file}: methods ${have.join() || "none"}, inventory ${methods.join()}`);
  }
  for (const file of pending)
    if (!inventory[file]) problems.push(`${file}: pending but not in the inventory`);
  if (!inventory[fallbackFile]) problems.push(`${fallbackFile}: fallback not in the inventory`);
  return problems;
}
