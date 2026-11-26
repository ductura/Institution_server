// SRV-ED42-PRIJEDLOZI (Ductus#2058, PITANJE ED-42; D-34, C-9, D-266 t. 1):
// the database port of a teacher's text suggestions (20261220190000). Each
// call is one withActor transaction over the RPCs of schema collaboration,
// which decide who may: a teacher of the work creates, the student owner and
// the teachers list the same rows, only the student owner decides, once.
// The answer is a closed status, never a database message or SQLSTATE.
//
// create reads the live state the teacher sees (read_live_state, which writes
// the teacher's access log), stores the suggestion bound to its hash and then
// checks that the anchor still selects exactly its quote there; a mismatch
// rolls the whole transaction back (conflict). decide("accept") hands the live
// state it was decided on to the caller's `apply` inside the same transaction
// and rolls the decision back when the suggestion no longer applies, so an
// accepted suggestion always came with its text. Nothing here writes the
// evidence or the live state. The text of the work never reaches a log or an
// error.
import {
  applySuggestion,
  verifyDocumentSnapshot,
  type CanonicalDocument,
  type SuggestionChange,
  type TextAnchor,
} from "../../domain/index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

export type SuggestionState = "pending" | "accepted" | "rejected";

/** The anchor a teacher's client sends, the six fields of a TextAnchor. */
export type SuggestionAnchorInput = {
  readonly nodeId: string;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly startHint: number;
  readonly endHint: number;
};

export type SuggestionRow = {
  readonly suggestionId: string;
  readonly anchor: TextAnchor;
  readonly text: string;
  readonly state: SuggestionState;
  readonly isOwn: boolean;
  readonly baseHash: string;
  readonly createdWindow: string;
  readonly decidedWindow: string | null;
};

/** The suggestion a student accepts, as the store keeps it, with the live state it was decided on. */
export type SuggestionToApply = {
  readonly suggestionId: string;
  readonly documentId: string;
  readonly anchor: TextAnchor;
  readonly text: string;
  readonly baseHash: string;
  readonly document: CanonicalDocument;
};

export type SuggestionRefusal = {
  readonly status:
    "unauthenticated" | "forbidden" | "not_found" | "invalid" | "conflict" | "unavailable";
};

export type Suggestions = {
  list(
    token: string,
    documentId: string,
  ): Promise<{ readonly status: "ok"; readonly suggestions: SuggestionRow[] } | SuggestionRefusal>;
  create(
    token: string,
    documentId: string,
    anchor: SuggestionAnchorInput,
    text: string,
  ): Promise<
    | { readonly status: "ok"; readonly suggestionId: string; readonly baseHash: string }
    | SuggestionRefusal
  >;
  /** `apply` answers undefined when the suggestion no longer applies; the decision is then rolled back. */
  accept<T>(
    token: string,
    suggestionId: string,
    apply: (suggestion: SuggestionToApply) => T | undefined,
  ): Promise<
    { readonly status: "ok"; readonly baseHash: string; readonly applied: T } | SuggestionRefusal
  >;
  reject(
    token: string,
    suggestionId: string,
  ): Promise<{ readonly status: "ok" } | SuggestionRefusal>;
};

/**
 * The domain's applySuggestion over the state accept hands over: the exact
 * JCS text for the student's live.document.put and the recorded change, or
 * undefined when the quote no longer stands in one place.
 */
export function applySuggestionToLive(
  suggestion: SuggestionToApply,
): { readonly text: string; readonly change: SuggestionChange } | undefined {
  const outcome = applySuggestion(suggestion.document, {
    suggestionId: suggestion.suggestionId,
    documentId: suggestion.documentId,
    anchor: suggestion.anchor,
    text: suggestion.text,
    state: "pending",
  });
  return outcome.ok ? { text: outcome.text, change: outcome.change } : undefined;
}

const SQL = {
  read: "SELECT outcome, content_hash, body FROM collaboration.read_live_state($1, NULL)",
  create: "SELECT collaboration.create_suggestion($1, $2::jsonb, $3, $4)::text AS id",
  list: `SELECT suggestion_id::text AS "suggestionId", anchor, text, state, is_own AS "isOwn",
    base_hash AS "baseHash", created_window AS "createdWindow", decided_window AS "decidedWindow"
    FROM collaboration.list_suggestions($1)`,
  decide: `SELECT document_id AS "documentId", anchor, text, live_hash AS "liveHash", live_body AS "liveBody"
    FROM collaboration.decide_suggestion($1::uuid, $2)`,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATES: readonly string[] = ["pending", "accepted", "rejected"];

/** Thrown inside the transaction to roll it back with a closed status. */
class Refused extends Error {
  readonly status: SuggestionRefusal["status"];
  constructor(status: SuggestionRefusal["status"]) {
    super(status);
    this.status = status;
  }
}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

const CODES = new Map<unknown, SuggestionRefusal["status"]>([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
]);

function refusal(thrown: unknown): SuggestionRefusal {
  if (thrown instanceof Refused) return { status: thrown.status };
  return { status: CODES.get(codeOf(thrown)) ?? "unavailable" };
}

const instant = (value: unknown): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Refused("unavailable");
  return value.toISOString();
};

function isAnchor(value: unknown): value is TextAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.nodeId === "string" &&
    typeof a.quote === "string" &&
    typeof a.prefix === "string" &&
    typeof a.suffix === "string" &&
    Number.isInteger(a.startHint) &&
    Number.isInteger(a.endHint)
  );
}

function toRow(row: Record<string, unknown>): SuggestionRow {
  if (
    typeof row.suggestionId !== "string" ||
    !UUID.test(row.suggestionId) ||
    !isAnchor(row.anchor) ||
    typeof row.text !== "string" ||
    typeof row.state !== "string" ||
    !STATES.includes(row.state) ||
    typeof row.isOwn !== "boolean" ||
    typeof row.baseHash !== "string" ||
    !HASH.test(row.baseHash)
  ) {
    throw new Refused("unavailable");
  }
  const decided = row.decidedWindow === null ? null : instant(row.decidedWindow);
  // Pending exactly when undecided, as the table's check.
  if ((row.state === "pending") !== (decided === null)) throw new Refused("unavailable");
  return {
    suggestionId: row.suggestionId,
    anchor: row.anchor,
    text: row.text,
    state: row.state as SuggestionState,
    isOwn: row.isOwn,
    baseHash: row.baseHash,
    createdWindow: instant(row.createdWindow),
    decidedWindow: decided,
  };
}

/** The live document behind `body`, only when it is the exact v1 snapshot whose hash is `hash`. */
async function liveDocument(hash: unknown, body: unknown): Promise<CanonicalDocument | undefined> {
  if (typeof hash !== "string" || !HASH.test(hash) || typeof body !== "string") return undefined;
  const snapshot = await verifyDocumentSnapshot(Buffer.from(body, "utf8"));
  return snapshot.ok && snapshot.sha256 === hash ? snapshot.document : undefined;
}

/** As the comment anchor check: the anchor must still select exactly its quote, with its context. */
function anchorStands(document: CanonicalDocument, anchor: SuggestionAnchorInput): boolean {
  const node = document.nodes.find(({ id }) => id === anchor.nodeId);
  if (node === undefined) return false;
  const text = node.children.map((child) => child.text).join("");
  const { startHint: start, endHint: end, quote, prefix, suffix } = anchor;
  return (
    end - start === quote.length &&
    text.slice(start, end) === quote &&
    text.slice(0, start).endsWith(prefix) &&
    text.startsWith(suffix, end)
  );
}

export function createSuggestions(withActor: WithActor): Suggestions {
  async function run<T>(
    token: string,
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | SuggestionRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return refusal(thrown);
    }
  }
  const rowsOf = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    (await tx.query<Record<string, unknown>>(sql, params)).rows;

  return {
    list: (token, documentId) =>
      run(token, async (tx) => ({
        status: "ok" as const,
        suggestions: (await rowsOf(tx, SQL.list, [documentId])).map(toRow),
      })),

    create: (token, documentId, anchor, text) =>
      run(token, async (tx) => {
        let read: Record<string, unknown>[];
        try {
          read = await rowsOf(tx, SQL.read, [documentId]);
        } catch (thrown) {
          // read_live_state answers "no relation" with ZD403: the same as a missing work.
          if (codeOf(thrown) === "ZD403") throw new Refused("not_found");
          throw thrown;
        }
        const live = read.length === 1 ? read[0]! : undefined;
        // Nothing published, or the submitted text: create_suggestion decides
        // (403 for the owner, 409 otherwise) on a hash no state has.
        const outcome = live?.outcome;
        if (outcome !== "state" && outcome !== "empty" && outcome !== "submitted") {
          throw new Refused("unavailable");
        }
        const hash =
          outcome === "state" && typeof live?.content_hash === "string"
            ? live.content_hash
            : "0".repeat(64);
        const created = await rowsOf(tx, SQL.create, [
          documentId,
          JSON.stringify(anchor),
          text,
          hash,
        ]);
        const id = created.length === 1 ? created[0]!.id : undefined;
        if (typeof id !== "string" || !UUID.test(id)) throw new Refused("unavailable");
        // Only a v1 document whose anchor still stands takes the suggestion.
        const document = await liveDocument(live?.content_hash, live?.body);
        if (document === undefined || !anchorStands(document, anchor)) {
          throw new Refused("conflict");
        }
        return { status: "ok" as const, suggestionId: id, baseHash: hash };
      }),

    accept: (token, suggestionId, apply) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.decide, [suggestionId, "accept"]);
        const row = rows.length === 1 ? rows[0]! : undefined;
        if (row === undefined || typeof row.documentId !== "string" || !isAnchor(row.anchor)) {
          throw new Refused("unavailable");
        }
        if (typeof row.text !== "string") throw new Refused("unavailable");
        const document = await liveDocument(row.liveHash, row.liveBody);
        // A live state that is not a v1 snapshot takes no suggestion.
        if (document === undefined) throw new Refused("conflict");
        const applied = apply({
          suggestionId,
          documentId: row.documentId,
          anchor: row.anchor,
          text: row.text,
          baseHash: row.liveHash as string,
          document,
        });
        if (applied === undefined) throw new Refused("conflict");
        return { status: "ok" as const, baseHash: row.liveHash as string, applied };
      }),

    reject: (token, suggestionId) =>
      run(token, async (tx) => {
        const rows = await rowsOf(tx, SQL.decide, [suggestionId, "reject"]);
        if (rows.length !== 1) throw new Refused("unavailable");
        return { status: "ok" as const };
      }),
  };
}
