// node spikes/b0.2-reconstruction/run.ts <machine-label> [--out results.json]
// Prints one line per scenario and, with --out, writes the measurements.
import { writeFileSync } from "node:fs";
import os from "node:os";

import { DOCTORAL_WORDS, measure, PILOT_WORDS, type Scenario } from "./measure.ts";

const label = process.argv[2];
if (label === undefined || label.startsWith("--")) {
console.error("usage: node spikes/b0.2-reconstruction/run.ts <machine-label> [--out file]");
process.exit(2);
}
const outAt = process.argv.indexOf("--out");
const out = outAt > 0 ? process.argv[outAt + 1] : undefined;

const scenarios: Scenario[] = [PILOT_WORDS, DOCTORAL_WORDS].flatMap((words) =>
[50, 200].map((checkpointEvery) => ({ words, wordsPerSegment: 20, checkpointEvery })),
);
const results = [];
for (const scenario of scenarios) {
const result = await measure(scenario);
results.push(result);
console.log(
`${scenario.words} words, ${result.segments} segments, checkpoint every ${scenario.checkpointEvery}: ` +
`full ${result.fullReplayMs} ms, resumed ${result.resumedReplayMs} ms (${result.resumedSegments} segments), ` +
`checkpoints ${result.checkpointCount} / ${(result.checkpointVolumeBytes / 1024 / 1024).toFixed(1)} MiB, ` +
`heap stage max ${(result.heapStageMaxBytes / 1024 / 1024).toFixed(0)} MiB`,
);
}
if (out !== undefined) {
writeFileSync(
out,
JSON.stringify(
{
label,
node: process.version,
cpu: os.cpus()[0]?.model ?? "unknown",
cpus: os.cpus().length,
memoryBytes: os.totalmem(),
results,
},
null,
2,
) + "\n",
);
}
