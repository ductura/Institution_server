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
  // Sections are found by number: their Croatian titles are text, which
  // server code does not write (S-1L.2, DAN-780).
  for (const cells of readTable(markdown, "## 1. ")) {
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
export function readImports(markdown: string): {
  imports: Map<string, string[]>;
  problems: string[];
} {
  const imports = new Map<string, string[]>();
  const problems: string[] = [];
  for (const cells of readTable(markdown, "## 2. ")) {
    const area = cells[0] ?? "";
    const cell = cells[1] ?? "";
    const targets = backticked(cell);
    if (imports.has(area)) problems.push(`${area}: listed twice`);
    else if (targets.length === 0 && cell !== "—")
      problems.push(`${area}: write targets in backticks or —`);
    else imports.set(area, targets);
  }
  return { imports, problems };
}

/** Area keys named in backticks in the "Tko ga zove" column of section 1. */
export function readCallers(markdown: string): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const cells of readTable(markdown, "## 1. "))
    callers.set(cells[0] ?? "", backticked(cells[3] ?? ""));
  return callers;
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** Folders directly in server/ and server/external/, as area keys (`external/x`). */
export function listAreaFolders(root: string): string[] {
  const dirsIn = (path: string): string[] =>
    existsSync(path)
      ? readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory())
      : [];
  const top = dirsIn(join(root, "server"));
  const external = dirsIn(join(root, "server", "external")).map((name) => `external/${name}`);
  return [...top.filter((name) => name !== "external"), ...external].sort();
}

/** The copied folders the map lists as not yet areas ("Kopirane mape bez područja"). */
export const COPIED_HEADING = "### Kopirane mape izvan karte";

/** The folders (without `server/`) of the copied-folder table, in its order. */
export function readCopiedFolders(markdown: string): string[] {
  return readTable(markdown, COPIED_HEADING).map((cells) =>
    (cells[0] ?? "").replace(/^`server\/(.*)`$/u, "$1"),
  );
}

/**
 * Disagreements between the map and the folders on disk. A copied folder
 * (`copied`) may exist outside the map, but only while it is no area and is
 * still on disk.
 */
export function checkFolders(areas: MapArea[], folders: string[], copied: string[] = []): string[] {
  const problems: string[] = [];
  for (const folder of copied) {
    if (areas.some((a) => a.key === folder))
      problems.push(`server/${folder} is an area: take it off the copied folders`);
    if (!folders.includes(folder))
      problems.push(`server/${folder} is listed as copied but is missing`);
  }
  for (const area of areas) {
    const exists = folders.includes(area.key);
    if (area.status === "postoji" && !exists)
      problems.push(`${area.dir} is marked postoji but is missing`);
    if (area.status === "planirano" && exists) problems.push(`${area.dir} exists: mark it postoji`);
  }
  for (const folder of folders) {
    if (!areas.some((a) => a.key === folder) && !copied.includes(folder))
      problems.push(`server/${folder} is not in docs/server-map.md`);
  }
  return problems;
}
