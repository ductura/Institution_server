// SRV-NF6-SIFRA on the dev fake server: the sealed note to self
// (work.sealed-self-note.*) and the wrapped note key (profile.self-note-key.*,
// profile.self-note-key-checked.delete).
// Invented data only. The real rules are the RPCs of 20261217150000: the
// note is the owner's alone (anyone else reads 404), a note needs the key the
// owner keeps now (409 otherwise), a key is set once and rewrapped only under
// its current version and the same keyId (409 otherwise), and deleting the key
// deletes every sealed note of its owner, the reading places stay. The fake
// keeps the bytes as the strings it was given and never reads them.
import { keptOf, owned, type Sealed } from "./mentorship-follow-routes.ts";
import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

type Wrapped = { salt: string; iv: string; ct: string };
type Key = {
  v: 1;
  keyId: string;
  kdf: { alg: "PBKDF2-SHA-256"; iterations: number };
  phrase: Wrapped;
  recovery: Wrapped;
  version: number;
  updatedAt: string;
};

/** The wrapped key of each account, by fake state. */
const KEYS = new WeakMap<State, Map<string, Key>>();

function keysOf(state: State): Map<string, Key> {
  let all = KEYS.get(state);
  if (all === undefined) KEYS.set(state, (all = new Map()));
  return all;
}

const snapshot = (state: State, documentId: string) => {
  const kept = keptOf(state, documentId);
  return { note: kept.note, readingPlace: kept.readingPlace };
};

export const SELF_NOTE_SEALED_HANDLERS: Handlers = {
  "work.sealed-self-note.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: snapshot(state, params.documentId) };
  },
  "work.sealed-self-note.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    if (keysOf(state).get(account.id)?.keyId !== body.sealed.keyId) return { error: "conflict" };
    const sealed: Sealed = { ...body.sealed };
    keptOf(state, params.documentId).note = { sealed, updatedAt: now.toISOString() };
    return { status: 200, body: snapshot(state, params.documentId) };
  },
  "work.sealed-self-note.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    keptOf(state, params.documentId).note = null;
    return { status: 200, body: snapshot(state, params.documentId) };
  },
  "profile.self-note-key.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    return { status: 200, body: { key: keysOf(state).get(account.id) ?? null } };
  },
  "profile.self-note-key.put": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (body.phrase.salt === body.recovery.salt) return { error: "invalid_input" };
    const keys = keysOf(state);
    const kept = keys.get(account.id);
    const { ifVersion, ...wrapped } = body;
    if (
      ifVersion === null
        ? kept !== undefined
        : kept === undefined || kept.version !== ifVersion || kept.keyId !== body.keyId
    ) {
      return { error: "conflict" };
    }
    const key: Key = {
      ...wrapped,
      version: kept === undefined ? 1 : kept.version + 1,
      updatedAt: now.toISOString(),
    };
    keys.set(account.id, key);
    return { status: 200, body: { key } };
  },
  "profile.self-note-key.delete": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    startOver(state, account.id);
    return { status: 200, body: { key: null } };
  },
  // SRV-NF6-SIFRA-2 (20261217160000): only under the key and version named.
  "profile.self-note-key-checked.delete": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const kept = keysOf(state).get(account.id);
    if (
      kept === undefined ||
      kept.keyId !== params.keyId ||
      (query.ifVersion !== undefined && kept.version !== Number(query.ifVersion))
    ) {
      return { error: "conflict" };
    }
    startOver(state, account.id);
    return { status: 200, body: { key: null } };
  },
};

/** The key of the account and every sealed note of its works go; the reading places stay. */
function startOver(state: State, accountId: string): void {
  if (!keysOf(state).delete(accountId)) return;
  for (const work of state.works) {
    if (work.studentId === accountId) keptOf(state, work.documentId).note = null;
  }
}
