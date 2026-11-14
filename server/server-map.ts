// Reads the area and import tables of docs/server-map.md and checks them
// against the folders that exist under server/.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const AREA_STATUSES = ["postoji", "planirano"] as const;
export type AreaStatus = (typeof AREA_STATUSES)[number];
export type MapArea = { key: string; dir: string; status: AreaStatus };

/** Cell rows of the first table after the heading line that starts with `heading`, header excluded. */
export function readTable(markdown: string, heading: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return [];
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const inner = line.trimEnd().replace(/^\|/, "").replace(/\|$/, "");
    rows.push(inner.split("|").map((cell) => cell.trim()));
  }
  // rows[0] is the header, rows[1] the --- separator.
  return rows.slice(2);
}

function isStatus(value: string): value is AreaStatus {
  return (AREA_STATUSES as readonly string[]).includes(value);
}

/** Areas from section 1; every malformed row is reported in `problems`. */
export function readAreas(markdown: string): { areas: MapArea[]; problems: string[] } {
  const areas: MapArea[] = [];
  const problems: string[] = [];
  for (const cells of readTable(markdown, "## 1. Područja")) {
    const key = cells[0] ?? "";
    const dir = cells[1]?.match(/^`(server\/[a-z0-9/-]+)`$/)?.[1];
    const status = cells.at(-1) ?? "";
    if (dir !== `server/${key}`) problems.push(`${key}: folder must be \`server/${key}\``);
    else if (!isStatus(status)) problems.push(`${key}: unknown status "${status}"`);
    else areas.push({ key, dir, status });
  }
  const keys = areas.map((a) => a.key);
  for (const key of new Set(keys)) {
    if (keys.indexOf(key) !== keys.lastIndexOf(key)) problems.push(`${key}: listed twice`);
  }
  return { areas, problems };
}

/** Allowed imports from section 2: area key to the area keys it may import. */
export function readImports(markdown: string): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  for (const cells of readTable(markdown, "## 2. Dopušteni uvozi")) {
    const targets = [...(cells[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    imports.set(cells[0] ?? "", targets);
  }
  return imports;
}

/** Folders directly in server/ and server/external/, as area keys (`external/x`). */
export function listAreaFolders(root: string): string[] {
  const dirsIn = (path: string): string[] =>
    existsSync(path) ? readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory()) : [];
  const top = dirsIn(join(root, "server"));
  const external = dirsIn(join(root, "server", "external")).map((name) => `external/${name}`);
  return [...top.filter((name) => name !== "external"), ...external].sort();
}

/** Disagreements between the map and the folders on disk. */
export function checkFolders(areas: MapArea[], folders: string[]): string[] {
  const problems: string[] = [];
  for (const area of areas) {
    const exists = folders.includes(area.key);
    if (area.status === "postoji" && !exists) problems.push(`${area.dir} is marked postoji but is missing`);
    if (area.status === "planirano" && exists) problems.push(`${area.dir} exists: mark it postoji`);
  }
  for (const folder of folders) {
    if (!areas.some((a) => a.key === folder)) problems.push(`server/${folder} is not in docs/server-map.md`);
  }
  return problems;
}
