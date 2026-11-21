// Legal-hold routes of the dev fake server (SRV-1306, plan M10.3): the
// administrator lists, places and releases holds. As on the real server the
// administrator who placed a hold never releases it (403), a hold already
// released is 409 and a subject the institution does not hold is 404. All
// values are invented.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const LEGAL_HOLD_HANDLERS: Handlers = {
  "institution.legal-holds.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    return { status: 200, body: { holds: state.legalHolds.map((hold) => ({ ...hold })) } };
  },
  "institution.legal-holds.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    const known =
      body.subjectType === "work"
        ? state.works.some((work) => work.documentId === body.subjectId.toLowerCase())
        : body.subjectType === "student"
          ? state.accounts.some(
              (a) => a.id === body.subjectId.toLowerCase() && a.roles.includes("student"),
            )
          : state.assignments.some((a) => a.id === body.subjectId.toLowerCase());
    if (!known) return { error: "not_found" };
    const holdId = randomUUID();
    state.legalHolds.push({
      holdId,
      subjectType: body.subjectType,
      subjectId: body.subjectId.toLowerCase(),
      caseReference: body.caseReference,
      placedBy: account.id,
      placedAt: now.toISOString(),
      releasedBy: null,
      releasedAt: null,
    });
    return { status: 201, body: { holdId } };
  },
  "institution.legal-hold-release.post": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    if (!UUID.test(params.holdId)) return { error: "not_found" };
    const hold = state.legalHolds.find((h) => h.holdId === params.holdId.toLowerCase());
    if (hold === undefined) return { error: "not_found" };
    if (hold.placedBy === account.id) return { error: "forbidden" };
    if (hold.releasedAt !== null) return { error: "conflict" };
    hold.releasedBy = account.id;
    hold.releasedAt = now.toISOString();
    return { status: 200, body: { holdId: hold.holdId, releasedAt: hold.releasedAt } };
  },
};
