import type { Handlers } from "./server.ts";
import type { Account, State } from "./state.ts";

// SRV-V17-TEMPLATE-ADMIN: the work template of the institution, one per work type, on the dev
// fake server. Only the administrator reads or adds a version, a version is only ever added.
// The real rules are 20261219110000_work_template.sql.
type Section = { title: string; hint: string };
type Version = {
  version: number;
  effectiveFrom: string;
  titlePage: ("title" | "author" | "mentor" | "course" | "date")[];
  sections: Section[];
  citationStyle: "fpzg";
};

// Keyed by a map that createState makes anew, so the reset (POST /__lazni/ponovno, which keeps the
// State object itself) starts the history again.
type Key = State["milestoneProgress"];
const versions = new WeakMap<Key, Map<string, Version[]>>();
const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;
const TYPES = new Set([
  "short_paper",
  "essay",
  "seminar_paper",
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
]);
const visible = (text: string): boolean => text.trim() !== "" && !/\p{Cc}/u.test(text);

export const WORK_TEMPLATE_HANDLERS: Handlers = {
  "institution.work-template.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (!TYPES.has(params.workType) || Object.keys(query).length > 0) {
      return { error: "invalid_input" };
    }
    const all = versions.get(state.milestoneProgress)?.get(params.workType) ?? [];
    return { status: 200, body: { current: all.at(-1) ?? null, versions: all } };
  },
  "institution.work-template.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (
      !TYPES.has(params.workType) ||
      new Set(body.titlePage).size !== body.titlePage.length ||
      body.sections.some((s) => !visible(s.title) || /\p{Cc}/u.test(s.hint))
    ) {
      return { error: "invalid_input" };
    }
    const byType = versions.get(state.milestoneProgress) ?? new Map<string, Version[]>();
    const all = byType.get(params.workType) ?? [];
    if (body.expectedVersion !== all.length) return { error: "conflict" };
    const made: Version = {
      version: all.length + 1,
      effectiveFrom: new Date(now).toISOString(),
      titlePage: body.titlePage,
      sections: body.sections,
      citationStyle: body.citationStyle,
    };
    byType.set(params.workType, [...all, made]);
    versions.set(state.milestoneProgress, byType);
    return { status: 200, body: made };
  },
};

/** The latest version of one work type's template on the fake, for the assignment pin (SRV-V17-TEMPLATE-ASSIGN). */
export function latestWorkTemplate(state: State, workType: string): Version | undefined {
  return versions.get(state.milestoneProgress)?.get(workType)?.at(-1);
}
