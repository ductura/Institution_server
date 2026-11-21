// The portable record of a submission on the dev fake server
// (student.portable-record.get, SRV-1312): only the student whose work holds
// the receipt with that submission id gets 200; anyone else, an unknown and a
// malformed id the same 404. The fake's submission receipt is not signed
// (UNSIGNED_SUBMISSION), so it answers the headers of the ZIP without its
// bytes, as the fake Merlin download does; the real ZIP is built and checked
// by server/downloads/portable-record.
import { createHash } from "node:crypto";

import type { Handlers } from "./server.ts";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const PORTABLE_RECORD_HANDLERS: Handlers = {
  "student.portable-record.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const submissionId = params.submissionId.toLowerCase();
    const work = LOWER_UUID.test(submissionId)
      ? state.works.find(
          (item) =>
            item.studentId === account.id &&
            item.submissionReceipt?.payload.submissionId === submissionId,
        )
      : undefined;
    if (work === undefined) return { error: "not_found" };
    return {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="prenosivi-zapis.zip"',
        "cache-control": "private, no-store",
        "x-content-sha256": createHash("sha256")
          .update(`prenosivi-zapis-${submissionId}`)
          .digest("hex"),
      },
    };
  },
};
