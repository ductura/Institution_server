import type { Handlers } from "./server.ts";
import { readerOf, type Account, type State } from "./state.ts";

// SRV-MENTOR-2: the forms of the faculty for a thesis, the mentor's consent and
// the stage after the submission, on invented data only. Like SRV-1520, the
// dev server has no mentorship of a work, so every work is taken as a thesis of
// the type of the demo mentorship and "the mentor" is the teacher reader of the
// work; the server decides through the mentorship (C-23). The administrator of
// the demo faculty is the faculty part.

type WorkType = "bachelor_thesis" | "master_thesis" | "specialist_thesis" | "doctoral_thesis";
type Part = "student" | "mentor" | "faculty";
type Form = {
  code: string;
  version: number;
  title: string;
  workTypes: WorkType[];
  active: boolean;
  publishedAt: string;
};
type FormState = {
  state: "not_submitted" | "submitted" | "accepted";
  stateFormVersion: number;
  changedAt: string;
  changedBy: string;
  changedByPart: Part;
};
type ConsentChange = {
  given: boolean;
  changedBy: string;
  changedAt: string;
  comment: string | null;
};
type Stage = {
  stage: "none" | "submitted_to_office" | "defense_scheduled" | "defended";
  defenseAt: string | null;
  changedBy: string | null;
  changedAt: string | null;
  changedByPart: "mentor" | "faculty" | null;
};
type ThesisState = {
  /** Every published version, oldest first. */
  forms: Form[];
  setting: { mentorConsentRequired: boolean; changedAt: string | null };
  /** documentId -> code -> the state in force. */
  workForms: Map<string, Map<string, FormState>>;
  consent: Map<string, ConsentChange[]>;
  stage: Map<string, Stage>;
};

const BOTH: WorkType[] = ["bachelor_thesis", "master_thesis"];
const PUBLISHED = "2026-11-01T09:00:00.000Z";
const NO_STAGE: Stage = {
  stage: "none",
  defenseAt: null,
  changedBy: null,
  changedAt: null,
  changedByPart: null,
};

const STATES = new WeakMap<State, ThesisState>();
function thesisOf(state: State): ThesisState {
  let thesis = STATES.get(state);
  if (thesis === undefined) {
    thesis = {
      forms: [
        {
          code: "prijava-teme",
          version: 1,
          title: "Prijava teme završnog ili diplomskog rada",
          workTypes: BOTH,
          active: true,
          publishedAt: PUBLISHED,
        },
        {
          code: "izjava-izvornost",
          version: 1,
          title: "Izjava o izvornosti rada",
          workTypes: BOTH,
          active: true,
          publishedAt: PUBLISHED,
        },
        {
          code: "izjava-pohrana",
          version: 1,
          title: "Izjava o pohrani rada u repozitorij",
          workTypes: BOTH,
          active: true,
          publishedAt: PUBLISHED,
        },
      ],
      setting: { mentorConsentRequired: false, changedAt: null },
      workForms: new Map(),
      consent: new Map(),
      stage: new Map(),
    };
    STATES.set(state, thesis);
  }
  return thesis;
}

const isAdmin = (account: Account) => account.roles.includes("institution_admin");

/** The newest version of each code, by code; retired ones for the administrator only. */
function formsInForce(thesis: ThesisState, admin: boolean): Form[] {
  const newest = new Map<string, Form>();
  for (const form of thesis.forms) newest.set(form.code, form);
  return [...newest.values()]
    .filter((form) => form.active || admin)
    .sort((a, b) => a.code.localeCompare(b.code));
}

function partOf(state: State, account: Account, documentId: string) {
  const work = state.works.find((entry) => entry.documentId === documentId);
  const reader = readerOf(state, work, account);
  const part: Part | null =
    reader === "owner"
      ? "student"
      : reader === "teacher"
        ? "mentor"
        : work && isAdmin(account)
          ? "faculty"
          : null;
  if (work === undefined || part === null) return null;
  const workType: WorkType =
    state.mentorships.find((m) => m.assignmentId === work.assignmentId)?.workType ??
    state.mentorships[0]?.workType ??
    "bachelor_thesis";
  return { part, workType };
}

function workFormsOf(thesis: ThesisState, documentId: string, workType: WorkType) {
  const set = thesis.workForms.get(documentId) ?? new Map<string, FormState>();
  return formsInForce(thesis, true)
    .filter((form) => (form.active && form.workTypes.includes(workType)) || set.has(form.code))
    .map((form) => {
      const now = set.get(form.code);
      return {
        code: form.code,
        version: form.version,
        title: form.title,
        state: now?.state ?? ("not_submitted" as const),
        stateFormVersion: now?.stateFormVersion ?? null,
        changedAt: now?.changedAt ?? null,
        changedBy: now?.changedBy ?? null,
        changedByPart: now?.changedByPart ?? null,
      };
    });
}

function consentOf(thesis: ThesisState, documentId: string) {
  const history = thesis.consent.get(documentId) ?? [];
  const last = history.at(-1);
  return {
    state:
      last === undefined
        ? ("none" as const)
        : last.given
          ? ("given" as const)
          : ("withdrawn" as const),
    changedBy: last?.changedBy ?? null,
    changedAt: last?.changedAt ?? null,
    comment: last?.comment ?? null,
    requiredForSubmission: thesis.setting.mentorConsentRequired,
    history: history.map((change) => ({ ...change })),
  };
}

export const THESIS_HANDLERS: Handlers = {
  "institution.thesis-forms.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    return { status: 200, body: { forms: formsInForce(thesisOf(state), isAdmin(account)) } };
  },
  "institution.thesis-forms.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (new Set(body.workTypes).size !== body.workTypes.length) return { error: "invalid_input" };
    const thesis = thesisOf(state);
    const version = thesis.forms.filter((form) => form.code === body.code).length + 1;
    const form: Form = {
      code: body.code,
      version,
      title: body.title,
      workTypes: [...body.workTypes].sort(),
      active: body.active,
      publishedAt: new Date().toISOString(),
    };
    thesis.forms.push(form);
    return { status: 201, body: form };
  },
  "institution.thesis-settings.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    return { status: 200, body: { ...thesisOf(state).setting } };
  },
  "institution.thesis-settings.put": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    const thesis = thesisOf(state);
    if (thesis.setting.mentorConsentRequired !== body.mentorConsentRequired) {
      thesis.setting = {
        mentorConsentRequired: body.mentorConsentRequired,
        changedAt: new Date().toISOString(),
      };
    }
    return { status: 200, body: { ...thesis.setting } };
  },
  "work.thesis-forms.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const context = partOf(state, account, params.documentId);
    if (context === null) return { error: "not_found" };
    return {
      status: 200,
      body: { forms: workFormsOf(thesisOf(state), params.documentId, context.workType) },
    };
  },
  "work.thesis-form.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const context = partOf(state, account, params.documentId);
    if (context === null) return { error: "not_found" };
    if (context.part === "student" && body.state === "accepted") return { error: "forbidden" };
    const thesis = thesisOf(state);
    const form = formsInForce(thesis, true).find((entry) => entry.code === params.code);
    if (form === undefined || !form.active || !form.workTypes.includes(context.workType)) {
      return { error: "not_found" };
    }
    const set = thesis.workForms.get(params.documentId) ?? new Map<string, FormState>();
    thesis.workForms.set(params.documentId, set);
    const now = set.get(form.code)?.state ?? "not_submitted";
    if (context.part === "student" && now === "accepted") return { error: "conflict" };
    if (now !== body.state) {
      set.set(form.code, {
        state: body.state,
        stateFormVersion: form.version,
        changedAt: new Date().toISOString(),
        changedBy: account.id,
        changedByPart: context.part,
      });
    }
    const answer = workFormsOf(thesis, params.documentId, context.workType).find(
      (entry) => entry.code === form.code,
    );
    return answer === undefined ? { error: "not_found" } : { status: 200, body: answer };
  },
  "work.mentor-consent.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (partOf(state, account, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: consentOf(thesisOf(state), params.documentId) };
  },
  "work.mentor-consent.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const context = partOf(state, account, params.documentId);
    if (context === null) return { error: "not_found" };
    if (context.part !== "mentor") return { error: "forbidden" };
    const thesis = thesisOf(state);
    const history = thesis.consent.get(params.documentId) ?? [];
    if ((history.at(-1)?.given ?? false) === body.given) return { error: "conflict" };
    history.push({
      given: body.given,
      changedBy: account.id,
      changedAt: new Date().toISOString(),
      comment: body.comment ?? null,
    });
    thesis.consent.set(params.documentId, history);
    return { status: 200, body: consentOf(thesis, params.documentId) };
  },
  "work.thesis-stage.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (partOf(state, account, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: { ...(thesisOf(state).stage.get(params.documentId) ?? NO_STAGE) } };
  },
  "work.thesis-stage.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const context = partOf(state, account, params.documentId);
    if (context === null) return { error: "not_found" };
    if (context.part === "student") return { error: "forbidden" };
    const defenseAt = body.defenseAt === undefined ? null : new Date(body.defenseAt).toISOString();
    if (
      (body.stage === "defense_scheduled" && defenseAt === null) ||
      ((body.stage === "none" || body.stage === "submitted_to_office") && defenseAt !== null)
    ) {
      return { error: "invalid_input" };
    }
    const thesis = thesisOf(state);
    const now = thesis.stage.get(params.documentId) ?? NO_STAGE;
    if (now.stage !== body.stage || now.defenseAt !== defenseAt) {
      thesis.stage.set(params.documentId, {
        stage: body.stage,
        defenseAt,
        changedBy: account.id,
        changedAt: new Date().toISOString(),
        changedByPart: context.part,
      });
    }
    return { status: 200, body: { ...(thesis.stage.get(params.documentId) ?? NO_STAGE) } };
  },
};
