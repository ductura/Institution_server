// Spike S-PDF measurement:
// `node spikes/pdf-a/run.ts [--words 15000] [--runs 5] [--cpus 1] [--memory 1024] [--parallel 1]`.
// Needs Docker and the two pinned images (README). Prints a Markdown table.
import assert from "node:assert/strict";
import os from "node:os";
import { parseArgs } from "node:util";

import {
  buildCorpus,
  buildDocx,
  convertDocx,
  declarePdfA2u,
  inspectPdf,
  validatePdfA2u,
} from "./index.ts";
import type { ConversionMetrics } from "./index.ts";

const { values } = parseArgs({
  options: {
    words: { type: "string", default: "15000" },
    runs: { type: "string", default: "5" },
    cpus: { type: "string", default: "1" },
    memory: { type: "string", default: "1024" },
    parallel: { type: "string", default: "1" },
  },
});
const words = Number(values.words);
const runs = Number(values.runs);
const parallel = Number(values.parallel);
const limits = { cpus: Number(values.cpus), memoryMiB: Number(values.memory) };

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const value = sorted[Math.floor((sorted.length - 1) / 2)];
  assert(value !== undefined);
  return value;
}

const corpus = buildCorpus(words);
const docx = buildDocx(corpus);
console.log(
  `Host: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? "?"} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, Node ${process.version}`,
);
console.log(
  `Document: ${corpus.wordCount} words, ${docx.footnotes} footnotes, DOCX ${docx.bytes.length} B; limits ${limits.cpus} CPU, ${limits.memoryMiB} MiB`,
);

await convertDocx(docx.bytes, "pdf-a-2b", limits); // warm-up: page cache and image layers
const samples: ConversionMetrics[] = [];
for (let run = 1; run <= runs; run += 1) {
  const { pdf, metrics } = await convertDocx(docx.bytes, "pdf-a-2b", limits);
  const verdict = await validatePdfA2u(declarePdfA2u(pdf));
  const facts = await inspectPdf(pdf);
  assert.equal(verdict.compliant, true, `run ${run}: ${verdict.failedClauses.join(", ")}`);
  samples.push(metrics);
  console.log(
    `run ${run}: wall ${metrics.wallMs.toFixed(0)} ms, soffice ${metrics.convertMs.toFixed(0)} ms, CPU ${metrics.cpuMs.toFixed(0)} ms, ` +
      `peak ${metrics.memPeakMiB.toFixed(1)} MiB, ${facts.pages} pages, PDF ${pdf.length} B, ` +
      `veraPDF ${verdict.profile} isCompliant=${verdict.compliant} (${verdict.wallMs.toFixed(0)} ms), fonts ${facts.embeddedFonts.join(" ")}`,
  );
}

const row = (key: keyof ConversionMetrics, digits = 0) => {
  const list = samples.map((sample) => sample[key]);
  return `${median(list).toFixed(digits)} / ${Math.max(...list).toFixed(digits)}`;
};
console.log(
  "\n| Words | Limits | docker run wall ms (median / max) | soffice ms | CPU ms | Peak memory MiB |",
);
console.log("| ---: | --- | --- | --- | --- | --- |");
console.log(
  `| ${corpus.wordCount} | ${limits.cpus} CPU, ${limits.memoryMiB} MiB | ${row("wallMs")} | ${row("convertMs")} | ${row("cpuMs")} | ${row("memPeakMiB", 1)} |`,
);

if (parallel > 1) {
  // Simultaneous containers, as at a submission deadline; each is still checked.
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: parallel }, () => convertDocx(docx.bytes, "pdf-a-2b", limits)),
  );
  const totalMs = performance.now() - started;
  for (const { pdf } of results)
    assert.equal((await validatePdfA2u(declarePdfA2u(pdf))).compliant, true);
  const peaks = results.map(({ metrics }) => metrics.memPeakMiB);
  const walls = results.map(({ metrics }) => metrics.wallMs);
  console.log(
    `\n${parallel} at once: all done in ${totalMs.toFixed(0)} ms, slowest container ${Math.max(...walls).toFixed(0)} ms, ` +
      `peak memory per container max ${Math.max(...peaks).toFixed(1)} MiB, sum ${peaks.reduce((a, b) => a + b, 0).toFixed(1)} MiB`,
  );
}
