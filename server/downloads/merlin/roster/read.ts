// The read behind both Merlin roster routes (SRV-1109). Three reads, each
// under withActor with the caller's session, so the database decides access
// (C-23): the deadline extensions of the assignment (SRV-1108), which refuse
// anyone but its teacher with not_found and so answer for the whole roster,
// then the submissions and the documents. The extension reasons leave only
// through the projection of N-13 and C-16: the reason, the student it was
// recorded for (null for all students) and the new deadline, only on the
// records the caller wrote (the port already hides another teacher's reason).
import type {
  AssignmentSubmissionsReader,
  DeadlineExtensionList,
  SubmittedWorksReader,
} from "../../../database/index.ts";

import type { MerlinLabels } from "./csv.ts";
import { buildMerlinRoster, type MerlinRoster } from "./roster.ts";

export type MerlinExtensionReason = {
  /** Null: the extension was recorded for every student of the assignment. */
  readonly studentId: string | null;
  readonly dueAt: string;
  readonly reasonId: "justified" | "technical" | "agreement" | "all";
};

export type MerlinRosterRead =
  | {
      readonly status: "read";
      readonly roster: MerlinRoster;
      readonly extensionReasons: readonly MerlinExtensionReason[];
    }
  | { readonly status: "unauthorized" | "not_found" };

export type MerlinRosterDeps = {
  readonly extensions: (token: string, assignmentId: string) => Promise<DeadlineExtensionList>;
  readonly submissions: AssignmentSubmissionsReader;
  readonly works: SubmittedWorksReader;
  /** The words of the files, from the message catalogue (locales/merlin.ts). */
  readonly labels: MerlinLabels;
};

export type MerlinRosterReader = (token: string, assignmentId: string) => Promise<MerlinRosterRead>;

/** `assignmentId` is a lowercase UUID; anything that is not an answer throws. */
export function createMerlinRosterReader(deps: MerlinRosterDeps): MerlinRosterReader {
  return async (token, assignmentId) => {
    const extensions = await deps.extensions(token, assignmentId);
    if (extensions.status !== "read") return { status: extensions.status };
    const submissions = await deps.submissions(token, [assignmentId]);
    if (submissions.status === "unauthenticated") return { status: "unauthorized" };
    if (submissions.status !== "ok") throw new Error("submissions unavailable");
    const works = await deps.works(token, assignmentId);
    if (works.status !== "read") return { status: "unauthorized" };
    const roster = await buildMerlinRoster(
      submissions.submissions.get(assignmentId) ?? [],
      works.students,
      deps.labels.exportLabels,
    );
    const extensionReasons = extensions.extensions.flatMap((e) =>
      e.reasonId === null ? [] : [{ studentId: e.studentId, dueAt: e.dueAt, reasonId: e.reasonId }],
    );
    return { status: "read", roster, extensionReasons };
  };
}
