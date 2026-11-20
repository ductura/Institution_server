import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { validateInput } from "./generated/index.ts";
import { WorkSourceRecord } from "./routes/index.ts";

const WEB = {
  id: "00000000-0000-4000-8000-00000000c0a2",
  type: "web",
  authors: [{ kind: "organization", name: "Izmišljena udruga" }],
  year: 2024,
  title: "Izmišljena mrežna stranica",
  url: "https://izvor.example.invalid/kompost",
  accessed: "2026-11-02",
};
const BOOK = {
  id: "00000000-0000-4000-8000-00000000c0a1",
  type: "book",
  authors: [{ kind: "person", family: "Izmišljeni", given: "Autor" }],
  year: 2019,
  title: "Izmišljena knjiga",
  place: "Izmišljeni grad",
  publisher: "Izmišljena naklada",
};
const valid = (record: object) => Value.Check(WorkSourceRecord, record);

describe("the source record of a work", () => {
  it("accepts real calendar dates and refuses the others, leap years included", () => {
    for (const accessed of ["2026-11-02", "2024-02-29", "2000-02-29", "2026-04-30", "2026-12-31"]) {
      expect(valid({ ...WEB, accessed }), accessed).toBe(true);
    }
    for (const accessed of [
      "2026-02-31",
      "2026-02-29",
      "2100-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-11-00",
    ]) {
      expect(valid({ ...WEB, accessed }), accessed).toBe(false);
    }
  });

  it("refuses the FORBIDDEN code points and white space at either end, as the document does", () => {
    expect(valid(BOOK)).toBe(true);
    for (const title of ["a‮b", "a­b", "a​b", "a﻿b", "a\u0085b", " a", "a ", "a　"]) {
      expect(valid({ ...BOOK, title }), JSON.stringify(title)).toBe(false);
    }
    // U+2028 is not FORBIDDEN, but is white space: allowed inside, refused at an end.
    expect(valid({ ...BOOK, title: "a b" })).toBe(true);
    expect(valid({ ...BOOK, title: "a " })).toBe(false);
    expect(valid({ ...BOOK, title: "🌱 kompost" })).toBe(true);
  });

  it("takes a DOI in lowercase only", () => {
    const body = (doi: string) => ({ record: BOOK, doi });
    expect(validateInput("student.work-sources.put", "body", body("10.1234/izmisljeno.2019"))).toBe(
      true,
    );
    expect(validateInput("student.work-sources.put", "body", body("10.1234/Izmisljeno"))).toBe(
      false,
    );
  });
});
