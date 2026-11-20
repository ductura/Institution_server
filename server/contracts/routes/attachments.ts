import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error, REQUEST_ID_PATTERN } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const BASE64_OPTIONS = {
  minLength: 4,
  pattern: "^[A-Za-z0-9+/]+={0,2}(?![\\s\\S])",
};
const AttachmentFields = {
  attachmentId: Type.String({ pattern: REQUEST_ID_PATTERN }),
  attachmentSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
  byteSize: Type.Integer({ minimum: 1, maximum: MAX_IMAGE_BYTES }),
  pixelWidth: Type.Union([Type.Integer({ minimum: 1, maximum: 20_000 }), Type.Null()]),
  pixelHeight: Type.Union([Type.Integer({ minimum: 1, maximum: 20_000 }), Type.Null()]),
};
const ERRORS = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];

export const workAttachmentPost = defineRoute({
  id: "work.attachments.post",
  method: "POST",
  path: "/api/v1/student/assignments/{assignmentId}/attachments",
  inventory: "app/api/student/assignments/[assignmentId]/attachments/route.ts",
  access: "student_owner",
  summary:
    "Upload a PNG or JPEG of up to 5 MiB with standard Base64. The server derives the type and SHA-256 from the bytes. Repeating the same bytes in the same work returns the existing attachment.",
  request: {
    params: closed({
      assignmentId: Type.String({ pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$" }),
    }),
    body: closed({ imageBase64: Type.String(BASE64_OPTIONS) }),
    contentType: "application/json",
    maxBodyBytes: MAX_BASE64_LENGTH + 64,
  },
  responses: [
    {
      status: 200,
      description: "Attachment reference",
      headers: ["cache-control"],
      body: closed({ ...AttachmentFields, created: Type.Boolean() }),
    },
  ],
  errors: [
    ...ERRORS,
    ...MUTATION_GUARD,
    error(400, "invalid_json"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
  ],
});

export const workAttachmentGet = defineRoute({
  id: "work.attachments.get",
  method: "GET",
  path: "/api/v1/works/attachments/{attachmentId}",
  inventory: "app/api/works/attachments/[attachmentId]/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Read an attachment as standard Base64 after authorization against the work that owns the attachment and verification of the stored bytes. An unknown or inaccessible attachment returns 404.",
  request: { params: closed({ attachmentId: AttachmentFields.attachmentId }) },
  responses: [
    {
      status: 200,
      description: "Verified image bytes and attachment reference",
      headers: ["cache-control"],
      body: closed({
        ...AttachmentFields,
        imageBase64: Type.String({ ...BASE64_OPTIONS, maxLength: MAX_BASE64_LENGTH }),
      }),
    },
  ],
  errors: ERRORS,
});

export const attachmentRoutes = [workAttachmentPost, workAttachmentGet] as const;
