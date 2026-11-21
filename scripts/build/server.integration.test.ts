// The build run as a script, as `pnpm build` runs it (S-1B-a, DAN-775).
// Review on 900779b: started through a symlinked path, the main check once
// compared the link with the real path of the module and exited 0 without
// building anything, while every test that calls buildServer() stayed green.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS } from "../../server/contracts/index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ductura-build-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function buildThrough(script: string, outfile: string): number | null {
  const result = spawnSync(process.execPath, [script, outfile], { cwd: dir, encoding: "utf8" });
  return result.status;
}

describe("node scripts/build/server.ts", () => {
  it.each([
    ["the real path", (): string => join(ROOT, "scripts/build/server.ts")],
    [
      "a symlinked repository",
      (): string => {
        const link = join(dir, "repo-link");
        symlinkSync(ROOT, link, "dir");
        return join(link, "scripts/build/server.ts");
      },
    ],
  ])(
    "builds one file when started through %s",
    (name, script) => {
      const outfile = join(dir, `${name.replaceAll(" ", "-")}.js`);
      expect(buildThrough(script(), outfile)).toBe(0);
      expect(existsSync(outfile)).toBe(true);
      // SRV-1804B: the PDF reader's thread is built next to the server file.
      expect(existsSync(join(dirname(outfile), "pdf-import-worker.js"))).toBe(true);
    },
    60_000,
  );
});

describe("dist/pdf-import-worker.js (SRV-1804B)", () => {
  it("is a self-contained file that reads a PDF and posts the result", async () => {
    const outfile = join(dir, "worker-run", "server.js");
    expect(buildThrough(join(ROOT, "scripts/build/server.ts"), outfile)).toBe(0);
    const built = join(dirname(outfile), "pdf-import-worker.js");
    // The thread reads no other file of the build: no import of ./server.js or node_modules.
    expect(readFileSync(built, "utf8")).not.toMatch(/from\s*["']\.\.?\//u);
    // An invented one-page PDF, written out here: no import across folders.
    const content = "BT /F1 12 Tf 72 720 Td (Izmisljeni tekst za izgradnju.) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let text = "%PDF-1.4\n";
    const offsets = objects.map((body, i) => {
      const at = text.length;
      text += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return at;
    });
    const xref = text.length;
    text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(Buffer.from(text, "latin1"));
    const result = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(built, { workerData: { bytes, limits: IMPORT_READ_LIMITS } });
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain("Izmisljeni tekst za izgradnju.");
  }, 60_000);
});
