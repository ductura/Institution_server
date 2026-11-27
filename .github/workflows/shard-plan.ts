// Command of the shard plan, see index.ts. Prints the files of one project on one leg.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { plan } from "./index.ts";

// Both projects are planned together, so the legs balance over the whole of
// unit plus integration (they run one after the other on the same leg).
const PROJECTS = ["unit", "integration"];

function main() {
  const [project, leg, ...rest] = process.argv.slice(2);
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(leg ?? "");
  if (!PROJECTS.includes(project) || !match || Number(match[1]) > Number(match[2])) {
    throw new Error("usage: node shard-plan.mjs <unit|integration> <i/n> [--reserve 3,4]");
  }
  const reserveAt = rest.indexOf("--reserve");
  const reserved =
    reserveAt < 0 ? [] : (rest[reserveAt + 1] ?? "").split(",").filter(Boolean).map(Number);
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  const table = JSON.parse(readFileSync(join(here, "shard-timings.json"), "utf8"));
  const timings = {};
  const files = [];
  for (const name of PROJECTS) {
    const listed = JSON.parse(
      execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly", "--json", "--project", name], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    if (listed.length === 0) throw new Error(`no test files in project ${name}`);
    for (const entry of listed) {
      const key = `${name}:${relative(root, entry.file).split("\\").join("/")}`;
      files.push(key);
      const ms = table[name]?.[key.slice(name.length + 1)];
      if (ms !== undefined) timings[key] = ms;
    }
  }
  const legs = plan(files, timings, Number(match[2]), reserved);
  const prefix = `${project}:`;
  const mine = legs[Number(match[1]) - 1]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  process.stdout.write(mine.map((file) => `${file}\n`).join(""));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
