import type { NextRequest } from "next/server";

import { expectedOrigin } from "../external/srce-auth/config.ts";
// As the mounted node:http writes (server/http/student-writes.ts): a session this
// browser has ended reads as no cookie (DAN-99).
import { liveSessionTokenFromCookie } from "../session/index.ts";
import { withActor } from "../database/index.ts";
import type { WithActor } from "../database/with-actor.ts";
import { createAssignmentResponse } from "./create-assignment.ts";

type AssignmentPostDependencies = {
  withActor?: WithActor;
  getRedirectUri?: () => string | undefined;
};

export function createAssignmentPostHandler(
  dependencies: AssignmentPostDependencies = {},
): (request: NextRequest, context: { params: Promise<{ courseId: string }> }) => Promise<Response> {
  const actor = dependencies.withActor ?? withActor;
  const getRedirectUri = dependencies.getRedirectUri ?? (() => process.env.OIDC_REDIRECT_URI);

  return async (request, context) => {
    const origin = expectedOrigin({
      NODE_ENV: process.env.NODE_ENV,
      OIDC_REDIRECT_URI: getRedirectUri(),
    });
    if (!origin) {
      console.error("assignment creation unavailable", "origin_config");
      return new Response(JSON.stringify({ error: "assignment_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const { courseId } = await context.params;
    const token = liveSessionTokenFromCookie(request.headers.get("cookie") ?? undefined) ?? null;
    return createAssignmentResponse(request, token, actor, origin, courseId);
  };
}
