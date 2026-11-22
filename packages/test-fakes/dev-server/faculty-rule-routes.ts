// The faculty rules on the dev fake server (institution.faculty-rules.get and
// .post, SRV-2001). Only the administrator reads or publishes; a version is
// only added, and the history is per fake state. The real rule is
// institution.publish_faculty_rule_version (DAN-315).
import type { Handlers } from "./server.ts";
import type { Account, State } from "./state.ts";

const WORK_TYPES = [
  "short_paper",
  "essay",
  "seminar_paper",
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
] as const;
type WorkType = (typeof WORK_TYPES)[number];
type Version = {
  versionNo: number;
  aiPolicy: "prohibited" | "partially_allowed" | "encouraged";
  aiPurposes: (
    "formatting" | "proofreading" | "literature_search" | "transcription" | "translation"
  )[];
  evidenceProfile: "basic" | "extended";
  importAllowed: boolean;
  origin: "operator" | "administrator";
  publishedAt: string;
};

const history = new WeakMap<State, Map<WorkType, Version[]>>();
const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;

export const FACULTY_RULE_HANDLERS: Handlers = {
  "institution.faculty-rules.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const kept = history.get(state);
    return {
      status: 200,
      body: {
        rules: WORK_TYPES.map((workType) => ({ workType, versions: kept?.get(workType) ?? [] })),
      },
    };
  },
  "institution.faculty-rules.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (new Set(body.aiPurposes).size !== body.aiPurposes.length) {
      return { error: "invalid_ai_purposes" };
    }
    if (body.aiPolicy === "prohibited" && body.aiPurposes.length > 0) {
      return { error: "invalid_ai_purposes" };
    }
    const kept = history.get(state) ?? new Map<WorkType, Version[]>();
    const versions = kept.get(body.workType as WorkType) ?? [];
    if ((body.basedOnVersionNo ?? 0) !== versions.length) return { error: "conflict" };
    const made: Version = {
      versionNo: versions.length + 1,
      aiPolicy: body.aiPolicy,
      aiPurposes: body.aiPurposes,
      evidenceProfile: body.evidenceProfile,
      importAllowed: body.importAllowed,
      origin: "administrator",
      publishedAt: new Date(now).toISOString(),
    };
    kept.set(body.workType as WorkType, [...versions, made]);
    history.set(state, kept);
    return { status: 201, body: { versionNo: made.versionNo, publishedAt: made.publishedAt } };
  },
};
