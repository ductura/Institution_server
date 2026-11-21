import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ImportEventMentorViewV1,
  ImportEventRecordV1,
  isConsistentImportEvent,
  mentorViewOfImportEvent,
} from "./import-event.ts";

// SRV-1801 (ADR docs/adr/import-contract.md §1): the shape of the import_event
// row and the mentor's projection. All identifiers are invented.

const pending: ImportEventRecordV1 = {
  importId: "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c",
  ownerId: "student-izmisljeni-1",
  documentId: "dokument-izmisljeni-uvoz",
  baseRevision: 7,
  manifest: "{}",
  manifestSha256: "a".repeat(64),
  importKind: "file-upload",
  fileFormat: "docx",
  rawByteLength: 48213,
  fileName: "Seminar o vodi.docx",
  state: "pending",
  preparedAt: "2026-11-10T09:00:00.000Z",
  confirmedEventId: null,
};
const confirmed: ImportEventRecordV1 = {
  ...pending,
  state: "confirmed",
  confirmedEventId: "dogadaj-izmisljeni-1",
};

describe("import_event record", () => {
  it("accepts the three states and a missing file name", () => {
    expect(Value.Check(ImportEventRecordV1, pending)).toBe(true);
    expect(Value.Check(ImportEventRecordV1, confirmed)).toBe(true);
    expect(Value.Check(ImportEventRecordV1, { ...pending, state: "cancelled" })).toBe(true);
    expect(Value.Check(ImportEventRecordV1, { ...pending, fileName: null })).toBe(true);
  });

  it("is a closed set: no author, e-mail or extra hash", () => {
    for (const extra of ["author", "email", "lastModifiedBy", "contentSha256"]) {
      expect(Value.Check(ImportEventRecordV1, { ...pending, [extra]: "Lorem Autor" })).toBe(false);
    }
    for (const [key, bad] of [
      ["state", "done"],
      ["importId", "00000000-0000-0000-0000-000000000000"],
      ["manifestSha256", "A".repeat(64)],
      ["rawByteLength", 0],
      ["fileName", ""],
      ["preparedAt", "2026-11-10 09:00"],
      ["baseRevision", -1],
    ] as const) {
      expect(Value.Check(ImportEventRecordV1, { ...pending, [key]: bad })).toBe(false);
    }
  });

  it("E2: only a confirmed row names an event, and it always does", () => {
    expect(isConsistentImportEvent(pending)).toBe(true);
    expect(isConsistentImportEvent(confirmed)).toBe(true);
    expect(isConsistentImportEvent({ ...pending, confirmedEventId: "dogadaj-izmisljeni-1" })).toBe(
      false,
    );
    expect(isConsistentImportEvent({ ...confirmed, confirmedEventId: null })).toBe(false);
  });

  it("D-292: the mentor sees kind, format, size and file name of a confirmed import only", () => {
    const view = mentorViewOfImportEvent(confirmed);
    expect(view).toEqual({
      importId: confirmed.importId,
      importKind: "file-upload",
      fileFormat: "docx",
      rawByteLength: 48213,
      fileName: "Seminar o vodi.docx",
    });
    expect(Value.Check(ImportEventMentorViewV1, view)).toBe(true);
    expect(mentorViewOfImportEvent(pending)).toBeNull();
    expect(mentorViewOfImportEvent({ ...pending, state: "cancelled" })).toBeNull();
    expect(mentorViewOfImportEvent({ ...confirmed, confirmedEventId: null })).toBeNull();
  });

  it("the mentor view carries no hash, manifest, owner or preparation time", () => {
    const keys = Object.keys(ImportEventMentorViewV1.properties);
    for (const hidden of ["manifest", "manifestSha256", "ownerId", "preparedAt", "baseRevision"]) {
      expect(keys).not.toContain(hidden);
    }
  });
});
