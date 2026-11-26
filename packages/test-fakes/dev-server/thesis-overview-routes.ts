import type { Handlers } from "./server.ts";

// SRV-V16-POPIS-FAKULTET: the theses of the faculty for the registrar's office,
// on invented data only. The dev server has no mentorship of a work, so every
// work is taken as a master thesis of its student under the first teacher, with
// no defence date, no topic and no committee (the real server reads those from
// the thesis records). Same shape, same order (by id here, as no work has a
// date), same paging by an opaque key as the real route.

const DEFAULT_LIMIT = 50;

const encode = (documentId: string) => Buffer.from(documentId, "utf8").toString("base64url");
const decode = (key: string) => Buffer.from(key, "base64url").toString("utf8");

export const THESIS_OVERVIEW_HANDLERS: Handlers = {
  "institution.thesis-overview.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    const stage = query?.stage ?? null;
    const limit = query?.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    const after = query?.after === undefined ? null : decode(query.after);
    const mentor = state.accounts.find((entry) => entry.roles.includes("teacher"));
    const name = (id: string) => {
      const person = state.accounts.find((entry) => entry.id === id);
      return person === undefined
        ? null
        : { givenName: person.givenName, familyName: person.familyName };
    };
    // Only the "none" stage exists here: nothing sets another one.
    const all =
      stage === null || stage === "none"
        ? [...state.works].sort((a, b) => a.documentId.localeCompare(b.documentId))
        : [];
    const rest = after === null ? all : all.filter((work) => work.documentId > after);
    const page = rest.slice(0, limit);
    return {
      status: 200,
      body: {
        works: page.map((work) => ({
          documentId: work.documentId,
          workType: "master_thesis" as const,
          mentorName: mentor === undefined ? null : name(mentor.id),
          studentName: name(work.studentId),
          stage: "none" as const,
          defenseAt: null,
          topicState: "none" as const,
          committeeSize: 0,
        })),
        next: rest.length > limit && page.length > 0 ? encode(page.at(-1)!.documentId) : null,
      },
    };
  },
};
