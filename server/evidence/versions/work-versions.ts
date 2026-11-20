// The answer of work.versions.get (SRV-9A, Ductus#2028): the cursor of the
// query checked here, the page read through the database port, and every
// outcome turned into the one status and body of the contract. Who asks comes
// only from the session token; access, the submission cut and the teacher's
// access log row are the database's (app.read_work_versions). A failure of the
// read is thrown to the route, which answers 503.
import type { WorkVersionsItem, WorkVersionsReader } from "../../database/index.ts";

/** The query's beforeRevision: digits with no leading zero, as the contract writes it. */
const BEFORE_REVISION = /^[1-9][0-9]{0,15}$/u;

export type WorkVersionsAnswer =
  | {
      readonly status: 200;
      readonly body: {
        readonly versions: readonly WorkVersionsItem[];
        readonly nextBeforeRevision: number | null;
      };
    }
  | { readonly status: 401; readonly code: "unauthorized" }
  | { readonly status: 404; readonly code: "not_found" }
  | { readonly status: 422; readonly code: "invalid_input" }
  /** The reason is a closed code for the server's record, never for the answer. */
  | { readonly status: 503; readonly code: "unavailable"; readonly reason: string };

const INVALID = { status: 422, code: "invalid_input" } as const;

/**
 * The cursor of the query: null when the query is empty, a safe integer of at
 * least 2 when it is exactly one beforeRevision in the contract's spelling,
 * undefined otherwise (another or a repeated parameter, another spelling, or a
 * cursor no version is below). The query is closed, as in the contract.
 */
export function beforeRevisionOf(query: URLSearchParams): number | null | undefined {
  const keys = [...query.keys()];
  if (keys.length === 0) return null;
  const value = query.get("beforeRevision");
  if (keys.length !== 1 || value === null || !BEFORE_REVISION.test(value)) return undefined;
  const before = Number(value);
  return Number.isSafeInteger(before) && before >= 2 ? before : undefined;
}

/** One page of the versions of `documentId` for the session `token`. */
export async function answerWorkVersions(
  read: WorkVersionsReader,
  token: string,
  documentId: string,
  query: URLSearchParams,
): Promise<WorkVersionsAnswer> {
  const before = beforeRevisionOf(query);
  if (before === undefined) return INVALID;
  const page = await read(token, documentId, before);
  switch (page.status) {
    case "found":
      return {
        status: 200,
        body: { versions: page.versions, nextBeforeRevision: page.nextBeforeRevision },
      };
    case "not_found":
      return { status: 404, code: "not_found" };
    case "unauthenticated":
      return { status: 401, code: "unauthorized" };
    case "invalid_input":
      return INVALID;
    default:
      return { status: 503, code: "unavailable", reason: page.reason };
  }
}
