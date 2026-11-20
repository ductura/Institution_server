/**
 * The image and the cover of document v4 (docs/contracts/document-schema-v4.md
 * §5.2 and §7), for `validateDocumentV4`. Same rules as the table: nothing
 * is repaired, and a valid value is copied from known fields only.
 */

import { isPlainObject } from "../json/index.ts";
import {
  COVER_FIELD_MAX,
  IMAGE_ALIGNS,
  isSourceId,
  type DocumentCover,
  type ImageCrop,
  type ImageNode,
  type NodeId,
} from "./schema.ts";
import { checkUnknownFields } from "./validate-sources.ts";
import type { ValidationError } from "./validate.ts";
import { figureTexts, flag, isInteger, tidy, type Raw } from "./validate-table-v4.ts";

export const IMAGE_FIELDS = new Set([
  "type",
  "id",
  "attachmentId",
  "attachmentSha256",
  "crop",
  "widthPercent",
  "align",
  "landscape",
  "title",
  "source",
]);
const COVER_FIELDS = new Set(Object.keys(COVER_FIELD_MAX));
const CROP_SIDES = ["bottom", "left", "right", "top"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** §5.2: the attachment fields come together, a crop only with them. */
export function validateImage(
  raw: Raw,
  path: string,
  id: NodeId | null,
  errors: ValidationError[],
): ImageNode | null {
  const before = errors.length;
  const hasId = Object.hasOwn(raw, "attachmentId");
  const hasHash = Object.hasOwn(raw, "attachmentSha256");
  if ((hasId || hasHash) && !(hasId && isSourceId(raw.attachmentId))) {
    errors.push({ path: `${path}.attachmentId`, code: "IMAGE_ATTACHMENT_INVALID" });
  }
  const hash = raw.attachmentSha256;
  if ((hasId || hasHash) && !(typeof hash === "string" && SHA256_HEX.test(hash))) {
    errors.push({ path: `${path}.attachmentSha256`, code: "IMAGE_ATTACHMENT_INVALID" });
  }
  const crop = Object.hasOwn(raw, "crop") ? validateCrop(raw.crop, `${path}.crop`, errors) : null;
  if (crop && !hasId) {
    errors.push({ path: `${path}.crop`, code: "IMAGE_CROP_INVALID" });
  }
  if (!isInteger(raw.widthPercent, 20, 100)) {
    errors.push({ path: `${path}.widthPercent`, code: "IMAGE_LAYOUT_INVALID" });
  }
  if (!(IMAGE_ALIGNS as readonly unknown[]).includes(raw.align)) {
    errors.push({ path: `${path}.align`, code: "IMAGE_LAYOUT_INVALID" });
  }
  const landscape = flag(raw, "landscape", path, errors);
  const texts = figureTexts(raw, path, errors);
  if (id === null || errors.length > before) return null;
  return {
    type: "image",
    id,
    ...(hasId
      ? { attachmentId: raw.attachmentId as string, attachmentSha256: hash as string }
      : {}),
    ...(crop ? { crop } : {}),
    widthPercent: raw.widthPercent as number,
    align: raw.align as ImageNode["align"],
    landscape,
    ...texts,
  };
}

function validateCrop(value: unknown, path: string, errors: ValidationError[]): ImageCrop | null {
  if (!isPlainObject(value)) {
    errors.push({ path, code: "IMAGE_CROP_INVALID" });
    return null;
  }
  checkUnknownFields(value, new Set(CROP_SIDES), path, errors);
  const sides = CROP_SIDES.map((side) => value[side]);
  if (!sides.every((side) => isInteger(side, 0, 45)) || sides.every((side) => side === 0)) {
    errors.push({ path, code: "IMAGE_CROP_INVALID" });
    return null;
  }
  const [bottom, left, right, top] = sides as number[];
  return { bottom: bottom!, left: left!, right: right!, top: top! };
}

/** §7: an object with at least one of the student's cover fields. */
export function validateCover(value: unknown, errors: ValidationError[]): DocumentCover | null {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    errors.push({ path: "$.cover", code: "COVER_INVALID" });
    return null;
  }
  checkUnknownFields(value, COVER_FIELDS, "$.cover", errors);
  const before = errors.length;
  const cover: DocumentCover = {};
  for (const [key, max] of Object.entries(COVER_FIELD_MAX)) {
    Object.assign(cover, tidy(value, key, "$.cover", max, "COVER_FIELD_INVALID", errors));
  }
  return errors.length > before ? null : cover;
}
