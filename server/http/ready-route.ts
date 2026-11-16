// Readiness route (S-1E-d, DAN-839-2): GET /api/v1/ready over the core of
// ready.ts. Public, so the answer carries only closed words of its contract:
// never a code, a message, an address or a version. 200 only when the core
// says ready; every other case, a throw included, is a 503 of the contract.
// Wiring with the real probes into server.ts is 839-3.
import { ROUTES } from "../contracts/index.ts";
import { sendRouteRefusal } from "./problem.ts";
import type { ReadyCapabilityName, ReadyReport, ReadyStatus } from "./ready.ts";
import { type Route, sendJson } from "./router.ts";

const READY_ID = "platform.ready.get";
const found = ROUTES.find((route) => route.id === READY_ID);
if (found === undefined) throw new Error(`no contract ${READY_ID}`);
const contract = found;

const NAMES: readonly ReadyCapabilityName[] = ["database", "storage", "signing", "queue"];
const WORDS: ReadonlySet<unknown> = new Set(["ok", "nedostupno", "nije_konfigurirano"]);
/** Seconds a client waits before asking again (as the evidence routes and draining in start.ts). */
const RETRY_UNAVAILABLE = "5";
const RETRY_DRAINING = "1";

export type ReadyRouteOptions = {
  /** The readiness core (createReadyCheck); it holds the time limit. */
  readonly check: () => Promise<ReadyReport>;
  /** True once the server drains; checked before and after the probes. */
  readonly draining: () => boolean;
};

type Body =
  | { status: "ready" | "unavailable"; capabilities: Partial<Record<string, ReadyStatus>> }
  | { status: "draining" };

/** Own data properties of the closed names only; a word outside the list is nedostupno. */
function wordsOf(capabilities: object): {
  words: Partial<Record<string, ReadyStatus>>;
  all: boolean;
} {
  const words: Partial<Record<string, ReadyStatus>> = {};
  let all = true;
  for (const name of NAMES) {
    const own = Object.getOwnPropertyDescriptor(capabilities, name);
    if (own === undefined || !("value" in own)) continue;
    const word: unknown = own.value;
    if (WORDS.has(word)) words[name] = word as ReadyStatus;
    else [words[name], all] = ["nedostupno", false];
  }
  return { words, all };
}

async function answerOf(options: ReadyRouteOptions): Promise<Body> {
  if (options.draining()) return { status: "draining" };
  const report: unknown = await options.check();
  if (options.draining()) return { status: "draining" };
  const capabilities: unknown =
    typeof report === "object" && report !== null
      ? Object.getOwnPropertyDescriptor(report, "capabilities")?.value
      : undefined;
  if (typeof capabilities !== "object" || capabilities === null)
    return { status: "unavailable", capabilities: {} };
  const { words, all } = wordsOf(capabilities);
  const ready = Object.getOwnPropertyDescriptor(report as object, "ready")?.value === true && all;
  return { status: ready ? "ready" : "unavailable", capabilities: words };
}

/** The readiness route over `check`; nothing of a failure reaches the answer or the log. */
export function createReadyRoute(options: ReadyRouteOptions): Route {
  return {
    contract,
    handle: async (_request, response) => {
      let body: Body;
      try {
        body = await answerOf(options);
      } catch {
        body = { status: "unavailable", capabilities: {} };
      }
      if (body.status === "ready") {
        // A Retry-After set before belongs to no 200.
        response.removeHeader("retry-after");
        return sendJson(response, 200, body);
      }
      const retry = body.status === "draining" ? RETRY_DRAINING : RETRY_UNAVAILABLE;
      sendRouteRefusal(response, contract, 503, body, { "retry-after": retry });
    },
  };
}
