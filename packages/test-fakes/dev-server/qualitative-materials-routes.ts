// SRV-V18-KODIRANJE-GRADIVO: the student's own material for qualitative coding
// in the fake dev server. Per fake state and per account, so another account
// reads the same 404 as for an unknown id (C-23). Made-up data only.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

export type FakeQualMaterial = {
  id: string;
  title: string;
  kind: "interview" | "note";
  text: string;
  createdOn: string;
  segmentCount: number;
};

const MATERIALS = new WeakMap<State, Map<string, FakeQualMaterial[]>>();
const MAX_MATERIALS = 200;
const MAX_TEXT = 100_000;

function ownOf(state: State, accountId: string): FakeQualMaterial[] {
  let all = MATERIALS.get(state);
  if (all === undefined) MATERIALS.set(state, (all = new Map()));
  let own = all.get(accountId);
  if (own === undefined) all.set(accountId, (own = []));
  return own;
}

/** For a scenario that needs a material before the request. */
export function seedQualMaterial(state: State, accountId: string, material: FakeQualMaterial) {
  ownOf(state, accountId).push(material);
}

const view = (m: FakeQualMaterial) => ({
  id: m.id,
  title: m.title,
  kind: m.kind,
  text: m.text,
  createdOn: m.createdOn,
  segmentCount: m.segmentCount,
  locked: m.segmentCount > 0,
});
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

export const QUALITATIVE_MATERIALS_HANDLERS = {
  "student.qual-materials.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const materials = ownOf(state, account.id)
      .toReversed()
      .map(({ text, ...rest }) => {
        const { locked } = view({ text, ...rest });
        return {
          id: rest.id,
          title: rest.title,
          kind: rest.kind,
          createdOn: rest.createdOn,
          charCount: [...text].length,
          segmentCount: rest.segmentCount,
          locked,
        };
      });
    return { status: 200, body: { materials } };
  },
  "student.qual-materials.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    const own = ownOf(state, account.id);
    if (own.length >= MAX_MATERIALS) return { error: "conflict" };
    const text = body.text.replace(/\r\n?/gu, "\n");
    if (
      [...text].length > MAX_TEXT ||
      text.trim() === "" ||
      CONTROL.test(text) ||
      [...body.title].length > 200 ||
      body.title.trim() === ""
    ) {
      return { error: "invalid_input" };
    }
    const created: FakeQualMaterial = {
      id: randomUUID(),
      title: body.title,
      kind: body.kind,
      text,
      createdOn: new Date().toISOString().slice(0, 10),
      segmentCount: 0,
    };
    own.push(created);
    return { status: 201, body: view(created) };
  },
  "student.qual-material.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = ownOf(state, account.id).find((m) => m.id === params.id);
    return found === undefined ? { error: "not_found" } : { status: 200, body: view(found) };
  },
  "student.qual-material.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const own = ownOf(state, account.id);
    const index = own.findIndex((m) => m.id === params.id);
    if (index === -1) return { error: "not_found" };
    own.splice(index, 1);
    return { status: 204 };
  },
} satisfies Partial<Handlers>;
