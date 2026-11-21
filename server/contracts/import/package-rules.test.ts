import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  checkDocxContentType,
  checkDocxMainContentType,
  checkDocxRelationship,
  DOCX_HYPERLINK_RELATIONSHIP,
  DOCX_MAIN_CONTENT_TYPE,
  IMPORT_READ_REJECT_CODES,
  ImportReadRejectV1,
} from "./package-rules.ts";

// SRV-1801 (ADR docs/adr/import-contract.md §8, attack classes K1 to K8):
// macros, embedded objects and external resources. All inputs are invented.

const T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships/";
const MS = "http://schemas.microsoft.com/office/2006/relationships/";

describe("import package rules", () => {
  it("allows the parts a plain document is made of", () => {
    for (const type of [
      "styles",
      "numbering",
      "footnotes",
      "comments",
      "image",
      "settings",
      "theme",
    ]) {
      expect(checkDocxRelationship(T + type, undefined)).toEqual({ ok: true });
      expect(checkDocxRelationship(T + type, "Internal")).toEqual({ ok: true });
    }
  });

  it("K1: a macro project rejects the import, by relationship or content type, in any namespace", () => {
    expect(checkDocxRelationship(`${MS}vbaProject`, undefined)).toEqual({
      ok: false,
      code: "MACRO_PRESENT",
    });
    expect(checkDocxRelationship(`${MS}wordVbaData`, "Internal")).toEqual({
      ok: false,
      code: "MACRO_PRESENT",
    });
    expect(checkDocxRelationship(`${STRICT}vbaProject`, "External")).toEqual({
      ok: false,
      code: "MACRO_PRESENT",
    });
    for (const type of [
      "application/vnd.ms-office.vbaProject",
      "application/vnd.ms-office.vbaProjectSignature",
      "application/vnd.ms-word.document.macroEnabled.main+xml",
      " APPLICATION/VND.MS-WORD.TEMPLATE.MACROENABLEDTEMPLATE.MAIN+XML ",
    ]) {
      expect(checkDocxContentType(type)).toEqual({ ok: false, code: "MACRO_PRESENT" });
    }
  });

  it("K2: a macro-enabled or template main part is never read as the document", () => {
    expect(checkDocxMainContentType(DOCX_MAIN_CONTENT_TYPE)).toEqual({ ok: true });
    expect(
      checkDocxMainContentType("application/vnd.ms-word.document.macroEnabled.main+xml"),
    ).toEqual({
      ok: false,
      code: "MACRO_PRESENT",
    });
    expect(
      checkDocxMainContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
      ),
    ).toEqual({ ok: false, code: "CONTENT_TYPE_NOT_ALLOWED" });
    expect(checkDocxMainContentType("text/html")).toEqual({
      ok: false,
      code: "CONTENT_TYPE_NOT_ALLOWED",
    });
  });

  it("K3: embedded objects, ActiveX and altChunk reject the import", () => {
    for (const type of ["oleObject", "package", "aFChunk", "control", "subDocument"]) {
      expect(checkDocxRelationship(T + type, undefined)).toEqual({
        ok: false,
        code: "EMBEDDED_CONTENT",
      });
    }
    expect(checkDocxContentType("application/vnd.ms-office.activeX+xml")).toEqual({
      ok: false,
      code: "EMBEDDED_CONTENT",
    });
    expect(checkDocxContentType("application/vnd.openxmlformats-officedocument.oleObject")).toEqual(
      {
        ok: false,
        code: "EMBEDDED_CONTENT",
      },
    );
  });

  it("K4: an external hyperlink is allowed; every other external target is refused", () => {
    expect(checkDocxRelationship(DOCX_HYPERLINK_RELATIONSHIP, "External")).toEqual({ ok: true });
    for (const type of [
      "image",
      "attachedTemplate",
      "frame",
      "subDocument",
      "oleObject",
      "styles",
    ]) {
      expect(checkDocxRelationship(T + type, "External")).toEqual({
        ok: false,
        code: "EXTERNAL_RESOURCE",
      });
    }
    // The Strict namespace of a hyperlink is not the allowed one (Strict OOXML is deferred, M8.1).
    expect(checkDocxRelationship(`${STRICT}hyperlink`, "External")).toEqual({
      ok: false,
      code: "EXTERNAL_RESOURCE",
    });
  });

  it("K5: a malformed relationship or content type is a broken package", () => {
    for (const mode of ["external", "", "None", 1, null]) {
      expect(checkDocxRelationship(`${T}styles`, mode)).toEqual({
        ok: false,
        code: "PACKAGE_INVALID",
      });
    }
    for (const bad of [undefined, null, "", 5]) {
      expect(checkDocxRelationship(bad, undefined)).toEqual({ ok: false, code: "PACKAGE_INVALID" });
      expect(checkDocxContentType(bad)).toEqual({ ok: false, code: "PACKAGE_INVALID" });
    }
  });

  it("L4: a refused read is a closed object with one code from the list", () => {
    expect(new Set(IMPORT_READ_REJECT_CODES).size).toBe(IMPORT_READ_REJECT_CODES.length);
    for (const code of IMPORT_READ_REJECT_CODES)
      expect(Value.Check(ImportReadRejectV1, { code })).toBe(true);
    expect(
      Value.Check(ImportReadRejectV1, { code: "MACRO_PRESENT", fileName: "Seminar o vodi.docx" }),
    ).toBe(false);
    expect(Value.Check(ImportReadRejectV1, { code: "SOMETHING_ELSE" })).toBe(false);
  });
});
