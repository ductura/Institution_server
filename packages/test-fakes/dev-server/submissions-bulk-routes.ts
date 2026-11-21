// The ZIP of all submissions of an assignment on the dev fake server
// (SRV-1902, P-D2): the 24 hour link of teacher.submissions-bulk-link.post and
// the download of teacher.submissions-bulk.get. Only a teacher of the
// assignment's course gets a link or a download; anyone else, an unknown and a
// malformed id the same 404. The token carries its expiry as the real one
// does (<epoch ms>.<43 characters>); the download answers the headers of the
// ZIP without bytes. The real ZIP is built by server/http/teacher-submissions-bulk.
import { createHash } from "node:crypto";

import type { Handlers } from "./server.ts";
import { teachesCourse, type Account, type State } from "./state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^(\d{1,15})\.[A-Za-z0-9_-]{43}$/u;

export const bulkTokenFor = (assignmentId: string, format: string, expiresMs: number) =>
  `${expiresMs}.${createHash("sha256")
    .update(`predaje\n${assignmentId}\n${format}\n${expiresMs}`)
    .digest("base64url")}`;

function taught(state: State, account: Account | null, assignmentId: string): string | null {
  const id = assignmentId.toLowerCase();
  const assignment = state.assignments.find((a) => a.id === id);
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return course !== undefined && account !== null && teachesCourse(course, account) ? id : null;
}

export const SUBMISSIONS_BULK_HANDLERS: Handlers = {
  "teacher.submissions-bulk-link.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    const expiresMs = now.getTime() + DAY_MS;
    return {
      status: 201,
      headers: { "cache-control": "no-store" },
      body: {
        format: body.format,
        downloadPath: `/api/v1/teacher/assignments/${assignmentId}/submissions-bulk/${body.format}?token=${bulkTokenFor(assignmentId, body.format, expiresMs)}`,
        expiresAt: new Date(expiresMs).toISOString(),
      },
    };
  },
  "teacher.submissions-bulk.get": ({ state, account, params, query, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    const match = TOKEN.exec(query.token);
    if (assignmentId === null || match === null) return { error: "not_found" };
    const expiresMs = Number(match[1]);
    if (query.token !== bulkTokenFor(assignmentId, params.format, expiresMs)) {
      return { error: "not_found" };
    }
    if (now.getTime() >= expiresMs) return { error: "not_allowed" };
    return {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="predaje.zip"',
        "cache-control": "private, no-store",
        "x-content-sha256": createHash("sha256")
          .update(`predaje-${params.format}-${assignmentId}`)
          .digest("hex"),
      },
    };
  },
};
