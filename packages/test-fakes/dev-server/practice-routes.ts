// The practice journal on the dev fake server (SRV-V19-DNEVNIK-UGOVOR): one
// invented placement of the invented mentorship, entries only added, signoffs
// of the mentor. The real rules are the database's (a later task); the fake
// keeps its records in a WeakMap by state, so it adds nothing to State, and its
// entriesSha256 is a plain SHA-256 of the entries, not the JCS of the contract.
import { createHash, randomUUID } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";
import type { Account, State } from "./state.ts";

/** The invented placement the fake starts with, of the invented mentorship. */
export const FAKE_PLACEMENT_ID = "7a000000-0000-4000-8000-000000000001";
const FAKE_ENTRY_LIMIT = 400;

/** The closed list of hours of the contract. */
type Hours = Operations["practice.entries.post"]["body"]["hours"];
type Entry = {
  entryId: string;
  date: string;
  hours: Hours;
  text: string;
  correctsEntryId: string | null;
  createdAt: string;
};
type Signoff = {
  signoffId: string;
  throughDate: string;
  entryCount: number;
  entriesSha256: string;
  comment: string | null;
  signedAt: string;
  mentor: { id: string; givenName: string; familyName: string };
};
type Placement = {
  placementId: string;
  mentorshipId: string;
  organisationName: string;
  startsOn: string;
  endsOn: string;
  entries: Entry[];
  signoffs: Signoff[];
};

const PLACEMENTS = new WeakMap<object, Placement[]>();

function placementsOf(state: State): Placement[] {
  let list = PLACEMENTS.get(state);
  if (list === undefined) {
    const first = state.mentorships[0];
    list =
      first === undefined
        ? []
        : [
            {
              placementId: FAKE_PLACEMENT_ID,
              mentorshipId: first.id,
              organisationName: "Organizacija A",
              startsOn: "2026-03-02",
              endsOn: "2026-06-30",
              entries: [],
              signoffs: [],
            },
          ];
    PLACEMENTS.set(state, list);
  }
  return list;
}

function roleIn(state: State, account: Account, placement: Placement): "student" | "mentor" | null {
  const mentorship = state.mentorships.find((m) => m.id === placement.mentorshipId);
  if (mentorship === undefined) return null;
  if (mentorship.studentId === account.id) return "student";
  if (account.roles.includes("teacher") && mentorship.mentorId === account.id) return "mentor";
  return null;
}

/** The placement of an id the caller may read, with the caller's part in it; another's is none. */
function reach(state: State, account: Account, id: string) {
  const placement = placementsOf(state).find((p) => p.placementId === id.toLowerCase());
  if (placement === undefined) return undefined;
  const role = roleIn(state, account, placement);
  return role === null ? undefined : { placement, role };
}

const byDate = (a: Entry, b: Entry) =>
  a.date.localeCompare(b.date) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.entryId.localeCompare(b.entryId);
const latestFirst = (a: Signoff, b: Signoff) =>
  b.signedAt.localeCompare(a.signedAt) || a.signoffId.localeCompare(b.signoffId);
const signedThrough = (p: Placement) =>
  p.signoffs.map((s) => s.throughDate).sort((a, b) => b.localeCompare(a))[0] ?? null;

export const PRACTICE_HANDLERS: Handlers = {
  "practice.placements.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    const mentorship = state.mentorships.find(
      (m) =>
        m.id === body.mentorshipId.toLowerCase() &&
        m.mentorId === account.id &&
        account.roles.includes("teacher"),
    );
    if (mentorship === undefined) return { error: "not_found" };
    if (body.startsOn > body.endsOn) return { error: "invalid_input" };
    const placementId = randomUUID();
    placementsOf(state).push({
      placementId,
      mentorshipId: mentorship.id,
      organisationName: body.organisationName,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      entries: [],
      signoffs: [],
    });
    return { status: 201, body: { placementId } };
  },
  "practice.placements.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const placements = placementsOf(state)
      .filter((p) => roleIn(state, account, p) !== null)
      .sort(
        (a, b) =>
          b.startsOn.localeCompare(a.startsOn) || a.placementId.localeCompare(b.placementId),
      )
      .map((p) => ({
        placementId: p.placementId,
        mentorshipId: p.mentorshipId,
        organisationName: p.organisationName,
        startsOn: p.startsOn,
        endsOn: p.endsOn,
        entryCount: p.entries.length,
        signedThrough: signedThrough(p),
      }));
    return { status: 200, body: { placements } };
  },
  "practice.entries.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = reach(state, account, params.placementId);
    if (found === undefined) return { error: "not_found" };
    return {
      status: 200,
      body: {
        entries: [...found.placement.entries].sort(byDate).map((e) => ({ ...e })),
        signoffs: [...found.placement.signoffs].sort(latestFirst).map((s) => ({ ...s })),
      },
    };
  },
  "practice.entries.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = reach(state, account, params.placementId);
    if (found === undefined || found.role !== "student") return { error: "not_found" };
    const { placement } = found;
    if (body.date > now.toISOString().slice(0, 10)) return { error: "invalid_input" };
    if (body.date < placement.startsOn || body.date > placement.endsOn) {
      return { error: "placement_closed" };
    }
    if (placement.entries.length >= FAKE_ENTRY_LIMIT) return { error: "conflict" };
    const corrects = body.correctsEntryId?.toLowerCase() ?? null;
    if (corrects !== null && !placement.entries.some((e) => e.entryId === corrects)) {
      return { error: "invalid_input" };
    }
    const entryId = randomUUID();
    placement.entries.push({
      entryId,
      date: body.date,
      hours: body.hours,
      text: body.text,
      correctsEntryId: corrects,
      createdAt: now.toISOString(),
    });
    return { status: 201, body: { entryId } };
  },
  "practice.signoffs.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = reach(state, account, params.placementId);
    if (found === undefined || found.role !== "mentor") return { error: "not_found" };
    const covered = found.placement.entries.filter((e) => e.date <= body.throughDate).sort(byDate);
    if (covered.length === 0) return { error: "nothing_to_sign" };
    const signoff: Signoff = {
      signoffId: randomUUID(),
      throughDate: body.throughDate,
      entryCount: covered.length,
      entriesSha256: createHash("sha256").update(JSON.stringify(covered)).digest("hex"),
      comment: body.comment ?? null,
      signedAt: now.toISOString(),
      mentor: { id: account.id, givenName: account.givenName, familyName: account.familyName },
    };
    found.placement.signoffs.push(signoff);
    return {
      status: 201,
      body: {
        signoffId: signoff.signoffId,
        entryCount: signoff.entryCount,
        entriesSha256: signoff.entriesSha256,
      },
    };
  },
  "practice.signoffs.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = reach(state, account, params.placementId);
    if (found === undefined) return { error: "not_found" };
    return {
      status: 200,
      body: { signoffs: [...found.placement.signoffs].sort(latestFirst).map((s) => ({ ...s })) },
    };
  },
};
