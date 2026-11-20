import { createHash } from "node:crypto";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createAttachmentRoutes } from "./index.ts";
import { createAttachments } from "./service.ts";
import { attachmentStorage } from "./storage.ts";

const ORIGIN = "https://ductura.example.invalid";
const ASSIGNMENT = "00000000-0000-4000-8000-000000000020";
const ATTACHMENT = "00000000-0000-4000-8000-000000000010";
const OWNER = "A".repeat(43);
const READER = "B".repeat(43);
const UNRELATED = "C".repeat(43);
const ENDED = "D".repeat(43);
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY2BgYGAAAAAFAAGKM+MAAAAAAElFTkSuQmCC";
const JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==";
const cookie = (token: string) => `__Host-ductus_session=${token}`;

let running: Running | undefined;
let directory: string | undefined;

afterEach(async () => {
  await running?.close();
  if (directory !== undefined) {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});

type AttachmentRow = { id: string; storageRef: string; sha256: string };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ductura-attachments-"));
  directory = root;
  const env: NodeJS.ProcessEnv = {};
  env.DUCTURA_ATTACHMENT_DIRECTORY = root;
  const storage = attachmentStorage(env, root);
  const put = vi.fn(storage.put);
  const read = vi.fn(storage.read);
  let saved: AttachmentRow | undefined;
  const withActor: WithActor = async (token, run) => {
    let pending: AttachmentRow | undefined;
    const result = await run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const args = values ?? [];
        const add = sql.includes("institution.add_work_attachment(");
        if (token === ENDED) throw Object.assign(new Error("closed session"), { code: "ZD401" });
        if (
          add
            ? token !== OWNER || args[0] !== ASSIGNMENT
            : token === UNRELATED || args[0] !== saved?.id
        ) {
          throw Object.assign(new Error("no relation"), { code: "ZD403" });
        }
        const [assignmentId, mediaType, byteSize, sha256, storageRef, pixelWidth, pixelHeight] =
          args;
        if (add && sha256 !== saved?.sha256) {
          pending = {
            id: ATTACHMENT,
            assignmentId,
            studentId: ASSIGNMENT,
            mediaType,
            byteSize,
            sha256,
            storageRef,
            pixelWidth,
            pixelHeight,
            createdAt: new Date("2026-11-20T10:00:00.000Z"),
          } as AttachmentRow;
        }
        const row = { ...(pending ?? saved), created: pending !== undefined };
        return { rows: [row as Row], rowCount: 1 };
      },
    });
    saved = pending ?? saved;
    return result;
  };
  const currentActor = async (token: string) =>
    token === ENDED
      ? { userId: null, institutionId: null }
      : { userId: ASSIGNMENT, institutionId: ASSIGNMENT };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createAttachmentRoutes(createAttachments(withActor, { put, read }), {
      currentActor,
      currentActorWithInstitution: async (token) => ({
        ...(await currentActor(token)),
        institutionSlug: null,
      }),
    }),
  });
  const api = `http://127.0.0.1:${running.port}/api/v1`;
  return {
    upload: (imageBase64: string, token = OWNER, origin = ORIGIN) =>
      fetch(`${api}/student/assignments/${ASSIGNMENT}/attachments`, {
        method: "POST",
        headers: { origin, cookie: cookie(token), "content-type": "application/json" },
        body: JSON.stringify({ imageBase64 }),
      }),
    download: (token: string) =>
      fetch(`${api}/works/attachments/${ATTACHMENT}`, { headers: { cookie: cookie(token) } }),
    corrupt: () => writeFile(join(root, saved!.storageRef), "damaged bytes"),
    put,
    read,
  };
}

it.each([
  [PNG, "image/png"],
  [JPEG, "image/jpeg"],
])(
  "stores a verified %s once and reads it for the owner and reader",
  async (imageBase64, mediaType) => {
    const { upload, download, put } = await fixture();
    const answer = await upload(imageBase64);
    const bytes = Buffer.from(imageBase64, "base64");
    const metadata = {
      attachmentId: ATTACHMENT,
      attachmentSha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType,
      byteSize: bytes.length,
      pixelWidth: 1,
      pixelHeight: 1,
    };
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ...metadata, created: true });
    expect(await (await upload(imageBase64)).json()).toEqual({ ...metadata, created: false });
    expect(put).toHaveBeenCalledTimes(1);
    for (const token of [OWNER, READER]) {
      const answer = await download(token);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await answer.json()).toEqual({ ...metadata, imageBase64 });
    }
  },
);

it("enforces the session, write origin and work relationship before storage I/O", async () => {
  const { upload, download, put, read } = await fixture();
  expect((await upload(PNG, ENDED)).status).toBe(401);
  expect((await upload(PNG, OWNER, "https://other.example.invalid")).status).toBe(403);
  expect((await upload(PNG, READER)).status).toBe(404);
  expect(put).not.toHaveBeenCalled();
  expect((await upload(PNG)).status).toBe(200);
  expect((await download(UNRELATED)).status).toBe(404);
  expect((await download(ENDED)).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});

it("refuses non-images, an oversize decoded image and altered stored bytes", async () => {
  const { upload, download, corrupt, put } = await fixture();
  expect((await upload(Buffer.from("Izmišljeni tekst").toString("base64"))).status).toBe(422);
  expect((await upload(PNG.slice(0, -16))).status).toBe(422);
  expect((await upload(Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"))).status).toBe(413);
  expect(put).not.toHaveBeenCalled();
  put.mockRejectedValueOnce(new Error("disk unavailable"));
  expect((await upload(PNG)).status).toBe(503);
  expect((await download(OWNER)).status).toBe(404);
  expect((await upload(PNG)).status).toBe(200);
  await corrupt();
  expect((await download(OWNER)).status).toBe(503);
});
