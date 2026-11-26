// `node scripts/operations/restore-drill/cli.ts <dir>`: the drill on exports of
// a restored LOCAL or test stack. <dir> holds checkpoint.json, public-key.json,
// tombstones.json, copy.json and bucket.json (what was read from the restored
// database and bucket); RESTORE_DRILL_TARGET is the address of the restored
// stack. Exit 0: the restore may open and bucket and database agree. Exit 1:
// the drill closed the restore or found a difference. Exit 2: unusable setting.
// Only a closed code and counts are printed, never a value from the files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runInfrastructureDrill, type DrillReport } from "./drill.ts";

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
): Promise<number> {
  const dir = argv[0];
  const target = env["RESTORE_DRILL_TARGET"];
  const institutionId = env["RESTORE_DRILL_INSTITUTION"];
  if (dir === undefined || target === undefined || institutionId === undefined) {
    write("usage: RESTORE_DRILL_TARGET=<url> RESTORE_DRILL_INSTITUTION=<id> restore-drill <dir>");
    return 2;
  }
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));
  let report: DrillReport;
  try {
    report = await runInfrastructureDrill({
      target,
      institutionId,
      checkpoint: read("checkpoint.json"),
      publicKey: read("public-key.json"),
      tombstones: read("tombstones.json"),
      copy: read("copy.json"),
      bucket: read("bucket.json"),
    });
  } catch {
    write("restore drill: unusable input files");
    return 2;
  }
  write(JSON.stringify(report));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env, (line) =>
    process.stdout.write(`${line}\n`),
  );
}
