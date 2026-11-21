// Docker tests of the spike: `node --test spikes/pdf-a/pdf-a.integration.test.ts`.
// They need Docker and both pinned images; without them they fail, not skip.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCorpus,
  buildDocx,
  convertDocx,
  declarePdfA2u,
  inspectPdf,
  isolatedRunArgs,
  LIBREOFFICE_IMAGE,
  validatePdfA2u,
  VERAPDF_IMAGE,
} from "./index.ts";
import { runDocker } from "./docker.ts";

const DOCX = buildDocx(buildCorpus(15_000)).bytes;

test("both images are present locally under their pinned digest", async () => {
  for (const image of [LIBREOFFICE_IMAGE, VERAPDF_IMAGE]) {
    const result = await runDocker([
      "image",
      "inspect",
      "--format",
      "{{json .RepoDigests}}",
      image,
    ]);
    assert.equal(result.code, 0, `${image}: ${result.stderr}`);
    assert.ok(result.stdout.toString("utf8").includes(image), result.stdout.toString("utf8"));
  }
});

test("the conversion container has only loopback and cannot reach out", async () => {
  const probe = `set -u
interfaces=$(awk -F: 'NR > 2 { gsub(/ /, "", $1); print $1 }' /proc/net/dev | sort | tr '\\n' ' ')
echo "interfaces=$interfaces"
if bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then echo "tcp=open"; else echo "tcp=refused"; fi
if getent hosts example.org >/dev/null 2>&1; then echo "dns=resolved"; else echo "dns=failed"; fi
if curl -sS --max-time 5 -o /dev/null https://example.org 2>/dev/null; then echo "https=ok"; else echo "https=failed"; fi`;
  const result = await runDocker(isolatedRunArgs(probe));
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.toString("utf8").trim().split("\n");
  assert.deepEqual(lines, ["interfaces=lo ", "tcp=refused", "dns=failed", "https=failed"]);
});

test("15,000 words become PDF/A-2u that veraPDF accepts, with only the OFL font embedded", async () => {
  const { pdf, metrics } = await convertDocx(DOCX);
  const verdict = await validatePdfA2u(declarePdfA2u(pdf));
  assert.equal(verdict.profile, "PDF/A-2u validation profile");
  assert.equal(verdict.compliant, true, verdict.failedClauses.join(", "));
  assert.equal(verdict.failedRules, 0);
  const facts = await inspectPdf(pdf);
  assert.ok(facts.pages > 20, `${facts.pages} pages`);
  assert.deepEqual(facts.unembeddedFonts, []);
  assert.ok(facts.embeddedFonts.length > 0);
  for (const font of facts.embeddedFonts)
    assert.match(font, /^LiberationSerif(?:-Bold|-Italic|-BoldItalic)?$/u);
  assert.ok(metrics.cpuMs > 0 && metrics.memPeakMiB > 0);
});

test("LibreOffice's own PDF/A-2b fails the 2u profile only on the identification", async () => {
  const { pdf } = await convertDocx(DOCX);
  const verdict = await validatePdfA2u(pdf);
  assert.equal(verdict.compliant, false);
  assert.deepEqual(verdict.failedClauses, ["6.6.4 t3"]);
});

test("a plain PDF export is not PDF/A and cannot be declared one", async () => {
  const { pdf } = await convertDocx(DOCX, "plain");
  assert.equal((await validatePdfA2u(pdf)).compliant, false);
  assert.throws(() => declarePdfA2u(pdf), /PDF\/A part 2/u);
});
