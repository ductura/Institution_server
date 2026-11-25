import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  confirmGradeBatch,
  createSyntheticIsvu,
  GRADE_BATCH_MAX_ROWS,
  gradeBatchSha256,
  isGradeConfirmation,
  ISVU_SETTING_FORMAT,
  ISVU_SETTING_OFF,
  isvuPortFor,
  PRODUCTION_ISVU_SETTING,
  readIsvuSetting,
  readIsvuSettingFile,
  SYNTHETIC_INSTITUTION_KEY,
  type GradeConfirmation,
  type IsvuGradeRow,
} from "./index.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const LANA = "demo-student-3@demo.ductus.test";
const NIKO = "demo-student-4@demo.ductus.test";

function confirmed(key: string, batch: readonly IsvuGradeRow[]): GradeConfirmation {
  return confirmGradeBatch({ sourceCourseKey: key, batchSha256: gradeBatchSha256(batch) });
}

describe("synthetic adapter: courses and rosters", () => {
  it("lists the invented courses of one academic year, with counts", async () => {
    const isvu = createSyntheticIsvu();
    const courses = await isvu.listCourses({
      institutionKey: SYNTHETIC_INSTITUTION_KEY,
      academicYear: "2026/2027",
    });
    expect(courses.map((c) => [c.sourceCourseKey, c.enrolledCount])).toEqual([
      ["SYN-101", 3],
      ["SYN-102", 2],
    ]);
  });

  it("knows no other institution and no other year", async () => {
    const isvu = createSyntheticIsvu();
    expect(
      await isvu.listCourses({ institutionKey: "drugi-fakultet", academicYear: "2026/2027" }),
    ).toEqual([]);
    expect(
      await isvu.listCourses({
        institutionKey: SYNTHETIC_INSTITUTION_KEY,
        academicYear: "1999/2000",
      }),
    ).toEqual([]);
  });

  it("gives rows in the shape of the roster import, with the invented accounts", async () => {
    const rows = await createSyntheticIsvu().listEnrolled("SYN-101");
    expect(rows).toEqual([
      { identifier: LANA, givenName: "Lana", familyName: "Brezik" },
      { identifier: NIKO, givenName: "Niko", familyName: "Rastović" },
      { identifier: "demo-izvor-1@demo.ductus.test", givenName: "Ela", familyName: "Probić" },
    ]);
    const accounts = JSON.parse(
      readFileSync(join(ROOT, "db/main/local/lazni-oidc-racuni.json"), "utf8"),
    ) as { racuni: { korisnik: string; domena: string }[] };
    const known = new Set(accounts.racuni.map((r) => `${r.korisnik}@${r.domena}`));
    expect(known.has(LANA) && known.has(NIKO)).toBe(true);
    expect(rows?.filter((r) => !known.has(r.identifier))).toHaveLength(1);
  });

  it("returns a copy, so a caller cannot change the source", async () => {
    const isvu = createSyntheticIsvu();
    const rows = (await isvu.listEnrolled("SYN-101")) as unknown as { givenName: string }[];
    rows[0]!.givenName = "Izmijenjeno";
    expect((await isvu.listEnrolled("SYN-101"))?.[0]?.givenName).toBe("Lana");
  });

  it("answers null for an unknown or malformed course key", async () => {
    const isvu = createSyntheticIsvu();
    expect(await isvu.listEnrolled("SYN-999")).toBeNull();
    expect(await isvu.listEnrolled("")).toBeNull();
    expect(await isvu.listEnrolled(undefined as unknown as string)).toBeNull();
  });
});

describe("submitGrades needs the teacher's confirmation", () => {
  const batch: IsvuGradeRow[] = [
    { identifier: NIKO, grade: 4 },
    { identifier: LANA, grade: 5 },
  ];

  it("passes a confirmed batch on once, whatever the order of rows", async () => {
    const isvu = createSyntheticIsvu();
    const out = await isvu.submitGrades(
      "SYN-101",
      batch,
      confirmed("SYN-101", [...batch].reverse()),
    );
    expect(out).toEqual({ ok: true, sent: 2, mode: "mock" });
    expect(isvu.submissions).toHaveLength(1);
  });

  it("refuses a literal that looks like a confirmation", async () => {
    const isvu = createSyntheticIsvu();
    const forged = {
      sourceCourseKey: "SYN-101",
      batchSha256: gradeBatchSha256(batch),
    } as unknown as GradeConfirmation;
    expect(isGradeConfirmation(forged)).toBe(false);
    expect(await isvu.submitGrades("SYN-101", batch, forged)).toEqual({
      ok: false,
      reason: "no_confirmation",
    });
    expect(
      await isvu.submitGrades("SYN-101", batch, undefined as unknown as GradeConfirmation),
    ).toEqual({ ok: false, reason: "no_confirmation" });
    expect(isvu.submissions).toEqual([]);
  });

  it("refuses a confirmation for another course or another batch", async () => {
    const isvu = createSyntheticIsvu();
    expect(await isvu.submitGrades("SYN-102", batch, confirmed("SYN-101", batch))).toEqual({
      ok: false,
      reason: "no_confirmation",
    });
    const changed = [{ identifier: NIKO, grade: 5 }, batch[1]!];
    expect(await isvu.submitGrades("SYN-101", changed, confirmed("SYN-101", batch))).toEqual({
      ok: false,
      reason: "batch_mismatch",
    });
    expect(isvu.submissions).toEqual([]);
  });

  it("refuses a student who is not on the roster and an unknown course", async () => {
    const isvu = createSyntheticIsvu();
    const outsider = [{ identifier: "netko@demo.ductus.test", grade: 3 }];
    expect(await isvu.submitGrades("SYN-101", outsider, confirmed("SYN-101", outsider))).toEqual({
      ok: false,
      reason: "not_enrolled",
    });
    expect(await isvu.submitGrades("SYN-999", batch, confirmed("SYN-999", batch))).toEqual({
      ok: false,
      reason: "unknown_course",
    });
    expect(isvu.submissions).toEqual([]);
  });

  it("refuses a bad batch: grade 0, 6, 2.5, text, a duplicate, empty, too long", async () => {
    const isvu = createSyntheticIsvu();
    const ok = confirmed("SYN-101", batch);
    const bad: unknown[] = [
      [{ identifier: LANA, grade: 0 }],
      [{ identifier: LANA, grade: 6 }],
      [{ identifier: LANA, grade: 2.5 }],
      [{ identifier: LANA, grade: "5" }],
      [
        { identifier: LANA, grade: 5 },
        { identifier: LANA, grade: 4 },
      ],
      [],
      Array.from({ length: GRADE_BATCH_MAX_ROWS + 1 }, (_, i) => ({
        identifier: `a${i}@x`,
        grade: 3,
      })),
      "nije popis",
    ];
    for (const rows of bad) {
      expect(await isvu.submitGrades("SYN-101", rows as IsvuGradeRow[], ok)).toEqual({
        ok: false,
        reason: "invalid_batch",
      });
      expect(() => gradeBatchSha256(rows as IsvuGradeRow[])).toThrow(TypeError);
    }
    expect(isvu.submissions).toEqual([]);
  });

  it("hashes the same batch to the same value in any order, and a changed grade differently", () => {
    expect(gradeBatchSha256(batch)).toBe(gradeBatchSha256([...batch].reverse()));
    expect(gradeBatchSha256(batch)).toMatch(/^[0-9a-f]{64}$/u);
    expect(gradeBatchSha256(batch)).not.toBe(
      gradeBatchSha256([{ identifier: NIKO, grade: 5 }, batch[1]!]),
    );
  });
});

describe("the setting", () => {
  it("is mock only for exactly the known format and mode", () => {
    expect(readIsvuSetting({ format: ISVU_SETTING_FORMAT, mode: "mock" }).mode).toBe("mock");
    expect(readIsvuSetting({ format: ISVU_SETTING_FORMAT, mode: "off" })).toBe(ISVU_SETTING_OFF);
  });

  it("is off for every wrong or incomplete value", () => {
    const wrong: unknown[] = [
      undefined,
      null,
      "mock",
      [],
      {},
      { mode: "mock" },
      { format: ISVU_SETTING_FORMAT },
      { format: "ductura-faculty-isvu-v2", mode: "mock" },
      { format: ISVU_SETTING_FORMAT, mode: "MOCK" },
      { format: ISVU_SETTING_FORMAT, mode: true },
      { format: ISVU_SETTING_FORMAT, mode: "real" },
      { format: ISVU_SETTING_FORMAT, mode: "mock", extra: 1 },
      { format: ISVU_SETTING_FORMAT, mode: "mock", [Symbol("x")]: 1 },
      Object.create({ format: ISVU_SETTING_FORMAT, mode: "mock" }),
    ];
    for (const value of wrong)
      expect(readIsvuSetting(value).mode, JSON.stringify(value)).toBe("off");
  });

  it("is off in production", () => {
    expect(PRODUCTION_ISVU_SETTING.mode).toBe("off");
    expect(Object.isFrozen(PRODUCTION_ISVU_SETTING)).toBe(true);
  });

  it("gives the adapter only when the mode is mock", () => {
    const adapter = createSyntheticIsvu();
    expect(
      isvuPortFor(readIsvuSetting({ format: ISVU_SETTING_FORMAT, mode: "mock" }), adapter),
    ).toBe(adapter);
    expect(isvuPortFor(PRODUCTION_ISVU_SETTING, adapter)).toBeNull();
    expect(isvuPortFor({ mode: "real" } as never, adapter)).toBeNull();
    expect(isvuPortFor(undefined as never, adapter)).toBeNull();
  });

  describe("the files", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("reads one faculty file and treats every problem as off", () => {
      dir = mkdtempSync(join(tmpdir(), "isvu-"));
      for (const slug of ["on", "typo", "big", "broken"]) mkdirSync(join(dir, slug));
      const valid = JSON.stringify({ format: ISVU_SETTING_FORMAT, mode: "mock" });
      writeFileSync(join(dir, "on", "isvu.json"), valid);
      writeFileSync(join(dir, "typo", "isvu.json"), valid.replace("mock", "mok"));
      writeFileSync(join(dir, "big", "isvu.json"), `${valid}${" ".repeat(5000)}`);
      writeFileSync(join(dir, "broken", "isvu.json"), "{");
      expect(readIsvuSettingFile(dir, "on").mode).toBe("mock");
      for (const slug of ["typo", "big", "broken", "missing", "../on", "", "On"]) {
        expect(readIsvuSettingFile(dir, slug).mode, slug).toBe("off");
      }
    });

    it("the repo's files: only the demo faculty is mock, fpzg is off", () => {
      const root = join(ROOT, "config", "faculties");
      expect(readIsvuSettingFile(root, "demo-fakultet").mode).toBe("mock");
      expect(readIsvuSettingFile(root, "fpzg").mode).toBe("off");
    });
  });
});
