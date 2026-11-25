// SRV-V19-GRUPA-RUTE: the contribution of a team as one answer (docs/contracts/
// work-team-v1.md, "Doprinos"). It only assembles what the records of the members
// already hold: it computes nothing new, compares no member with another and
// has no share, rank, average, threshold or colour (C-6 (a), P-B, OP-V19-2).
import { compareByName } from "./members.ts";

/** The kinds of origin, in the one fixed order of every answer (provenance-share-v1 §1.2). */
export const CONTRIBUTION_CATEGORIES = [
  "written",
  "ai_transferred",
  "pasted",
  "imported",
  "unattributed",
] as const;
export type ContributionCategory = (typeof CONTRIBUTION_CATEGORIES)[number];
export const CONTRIBUTION_NOTICE = "not_authorship_evidence" as const;

/** What the record of one member's part says; `ready` carries the counts of code points. */
export type MemberPart =
  | { readonly state: "pending" | "failed" }
  | {
      readonly state: "ready";
      readonly codePoints: Readonly<Partial<Record<ContributionCategory, number>>>;
    };

export type TeamMemberPart = {
  readonly id: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly part: MemberPart;
};

export type Contribution =
  | { state: "disabled" | "none" | "pending" | "failed" }
  | {
      state: "ready";
      members: {
        givenName: string;
        familyName: string;
        categories: { category: ContributionCategory; codePoints: number }[];
        totalCodePoints: number;
      }[];
      notice: typeof CONTRIBUTION_NOTICE;
    };

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The contribution of a team. `disabled`: teams are off (or records are not kept);
 * `none`: no team or no member; `failed` as soon as one member's part failed (never
 * with a reason), else `pending` while one is not computed, else `ready`. A count
 * that is not a safe integer makes the whole answer `failed`, never a made-up number.
 */
export function assembleContribution(input: {
  enabled: boolean;
  members: readonly TeamMemberPart[] | null;
}): Contribution {
  if (!input.enabled) return { state: "disabled" };
  const members = input.members;
  if (members === null || members.length === 0) return { state: "none" };
  if (members.some((member) => member.part.state === "failed")) return { state: "failed" };
  if (members.some((member) => member.part.state === "pending")) return { state: "pending" };
  const rows: Extract<Contribution, { state: "ready" }>["members"] = [];
  for (const member of [...members].sort(compareByName)) {
    if (member.part.state !== "ready") return { state: "failed" };
    const counts = member.part.codePoints;
    const categories = CONTRIBUTION_CATEGORIES.map((category) => ({
      category,
      codePoints: counts[category] ?? 0,
    }));
    if (!categories.every((entry) => isCount(entry.codePoints))) return { state: "failed" };
    rows.push({
      givenName: member.givenName,
      familyName: member.familyName,
      categories,
      totalCodePoints: categories.reduce((sum, entry) => sum + entry.codePoints, 0),
    });
  }
  return { state: "ready", members: rows, notice: CONTRIBUTION_NOTICE };
}
