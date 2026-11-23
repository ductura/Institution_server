import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createFormReader } from "./form.ts";

it("uses the latest version for the session's institution and hashes the original file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ductura-statement-"));
  try {
    const slug = "demo-fakultet";
    const folder = join(root, slug, "declaration");
    await mkdir(folder, { recursive: true });
    const older =
      '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Prva izmišljena verzija."}';
    const active =
      '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":2,"text":"Druga izmišljena verzija."}\n';
    await writeFile(join(folder, "1.json"), older);
    await writeFile(join(folder, "2.json"), active);
    const read = createFormReader(root);
    expect(await read(slug)).toEqual({
      file: active,
      form: {
        formId: "test-izjava",
        formVersion: 2,
        text: "Druga izmišljena verzija.",
        formSha256: createHash("sha256").update(active).digest("hex"),
      },
    });
    expect(await read("drugi-fakultet")).toBeNull();
    await writeFile(join(folder, "3.json"), active);
    await expect(read(slug)).rejects.toThrow("Invalid declaration form file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads the invented demo form the local stack and CI use", async () => {
  const read = createFormReader(join(process.cwd(), "config", "faculties"));
  const active = await read("demo-fakultet");
  expect(active?.form.formId).toBe("demo-izjava");
  expect(active?.form.formVersion).toBe(1);
  expect(active?.form.text).toMatch(/^Izmišljeni obrazac/u);
});
