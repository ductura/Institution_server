/**
 * The marks of document v4 (docs/contracts/document-schema-v4.md §3): a mark
 * without attributes is a string, one with attributes an object with a closed
 * set of keys. Each type appears once, in `MARK_V4_ORDER`, and `sup` never
 * with `sub`. Nothing is repaired; a valid mark is copied with sorted keys.
 */

import { isPlainObject } from "../json/index.ts";
import {
  MARK_V4_ORDER,
  MAX_LINK_HREF_LENGTH,
  isSourceId,
  markV4Type,
  type MarkV4,
} from "./schema.ts";
import { checkUnknownFields } from "./validate-sources.ts";
import type { ValidationError } from "./validate.ts";

type Raw = Record<string, unknown>;

const STRING_MARKS = new Set(["bold", "italic", "sup", "sub", "imported"]);
/** Each mark with attributes: its required and optional attributes (§3). */
const OBJECT_MARKS: ReadonlyMap<string, { required: string[]; optional: string[] }> = new Map([
  ["highlight", { required: ["color"], optional: [] }],
  ["lang", { required: ["lang"], optional: [] }],
  ["link", { required: ["href"], optional: [] }],
  ["paste", { required: ["pasteId"], optional: ["sourceId"] }],
]);
const COLOR = /^#[0-9a-f]{6}$/;
const LANG = /^[a-z]{2,3}$/;
const HREF = /^(?:https?:\/\/|mailto:)[\x21-\x7e]+$/;

const ATTRIBUTE_RULES: Readonly<Record<string, (value: unknown) => boolean>> = {
  color: (value) => typeof value === "string" && COLOR.test(value),
  lang: (value) => typeof value === "string" && LANG.test(value),
  href: (value) =>
    typeof value === "string" && value.length <= MAX_LINK_HREF_LENGTH && HREF.test(value),
  pasteId: isSourceId,
  sourceId: isSourceId,
};

/** §3: each type once, in `MARK_V4_ORDER`, and never `sup` with `sub`. */
export function validateMarksV4(
  rawMarks: unknown[],
  path: string,
  errors: ValidationError[],
): MarkV4[] | null {
  const marks: MarkV4[] = [];
  let ok = true;
  Array.from(rawMarks).forEach((raw, index) => {
    const markPath = `${path}[${index}]`;
    const mark = validateMark(raw, markPath, errors);
    if (!mark) {
      ok = false;
      return;
    }
    if (marks.some((seen) => markV4Type(seen) === markV4Type(mark))) {
      errors.push({ path: markPath, code: "MARKS_DUPLICATE" });
      ok = false;
      return;
    }
    marks.push(mark);
  });
  if (!ok) return null;
  const ranks = marks.map((mark) => MARK_V4_ORDER.indexOf(markV4Type(mark)));
  if (ranks.some((rank, i) => i > 0 && rank < ranks[i - 1]!)) {
    errors.push({ path, code: "MARKS_UNSORTED" });
    return null;
  }
  if (marks.includes("sup") && marks.includes("sub")) {
    errors.push({ path, code: "MARKS_EXCLUSIVE" });
    return null;
  }
  return marks;
}

function validateMark(raw: unknown, path: string, errors: ValidationError[]): MarkV4 | null {
  if (typeof raw === "string") {
    if (STRING_MARKS.has(raw)) return raw as MarkV4;
    errors.push({ path, code: "MARK_INVALID" });
    return null;
  }
  const rule =
    isPlainObject(raw) && typeof raw.type === "string" ? OBJECT_MARKS.get(raw.type) : undefined;
  if (!isPlainObject(raw) || rule === undefined) {
    errors.push({ path, code: "MARK_INVALID" });
    return null;
  }
  const allowed = ["type", ...rule.required, ...rule.optional];
  checkUnknownFields(raw, new Set(allowed), path, errors);
  let ok = Object.keys(raw).every((key) => allowed.includes(key));
  // Keys in sorted order, so equal marks serialise equally (marksKey, JCS).
  const mark: Raw = {};
  for (const key of [...allowed].sort()) {
    if (key === "type") {
      mark.type = raw.type;
    } else if (Object.hasOwn(raw, key) || rule.required.includes(key)) {
      if (!ATTRIBUTE_RULES[key]!(raw[key])) {
        errors.push({ path: `${path}.${key}`, code: "MARK_ATTRIBUTE_INVALID" });
        ok = false;
      }
      mark[key] = raw[key];
    }
  }
  return ok ? (mark as MarkV4) : null;
}

/** Equal for two mark arrays exactly when the marks and their attributes are equal. */
export function marksV4Key(marks: readonly MarkV4[]): string {
  return JSON.stringify(marks);
}
