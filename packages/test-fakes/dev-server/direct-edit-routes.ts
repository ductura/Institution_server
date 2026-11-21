// The direct-edit setting of a work on the dev fake server (work.direct-edit.get
// and work.direct-edit.put, SRV-1702; D-21, D-34, D-244): suggestions by
// default, only the student owner turns direct edits on or revokes them, and
// the student and the teachers of the course read the same answer, with times
// in the 5-minute window of P-03. The real setting, its lock, the teacher's
// edit through the live put and its record are the RPCs of 20261129100100;
// this fake records no teacher edit.
import type { Handlers } from "./server.ts";
import { readerOf, type State } from "./state.ts";

type Mode = "suggestions" | "direct";
type Entry = {
  readonly kind: "mode";
  readonly source: "student";
  readonly mode: Mode;
  readonly at: string;
};
type Setting = { mode: Mode; changedAt: string | null; readonly record: Entry[] };

/** The settings of each fake state, by work. */
const SETTINGS = new WeakMap<State, Map<string, Setting>>();

function settingOf(state: State, documentId: string): Setting {
  let all = SETTINGS.get(state);
  if (all === undefined) SETTINGS.set(state, (all = new Map()));
  let one = all.get(documentId);
  if (one === undefined)
    all.set(documentId, (one = { mode: "suggestions", changedAt: null, record: [] }));
  return one;
}

/** The 5-minute window of P-03. */
const windowOf = (now: Date) =>
  new Date(Math.floor(now.getTime() / 300_000) * 300_000).toISOString();

export const DIRECT_EDIT_HANDLERS: Handlers = {
  "work.direct-edit.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    const setting = settingOf(state, work.documentId);
    return {
      status: 200,
      body: { mode: setting.mode, changedAt: setting.changedAt, record: [...setting.record] },
    };
  },
  "work.direct-edit.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (
      work === undefined ||
      readerOf(state, work, account) !== "owner" ||
      work.state === "submitted"
    )
      return { error: "not_found" };
    const setting = settingOf(state, work.documentId);
    if (setting.mode === body.mode) {
      return {
        status: 200,
        body: { outcome: "unchanged", mode: setting.mode, changedAt: setting.changedAt },
      };
    }
    const at = windowOf(now);
    setting.mode = body.mode;
    setting.changedAt = at;
    setting.record.push({ kind: "mode", source: "student", mode: body.mode, at });
    return { status: 200, body: { outcome: "applied", mode: setting.mode, changedAt: at } };
  },
};
