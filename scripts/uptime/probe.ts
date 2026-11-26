// DAN-1567, part 3: one look at /api/v1/ready from outside, and what to do
// with the one issue that says the server does not answer. Pure apart from
// the fetch it is given. Nothing of an answer is kept but its status code:
// no body, no header, no message of an error.

/** The readiness address: https, no credentials, no query, the path of the contract. */
export function isProbeUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === "/api/v1/ready"
  );
}

export type ProbeResult =
  | { up: true }
  | { up: false; reason: "status"; status: number }
  | { up: false; reason: "timeout" | "unreachable" };

export type Fetcher = (
  url: string,
  init: { signal: AbortSignal; redirect: "manual"; cache: "no-store" },
) => Promise<{ status: number }>;

export const PROBE_TIMEOUT_MS = 10_000;

/** Up is exactly 200. A redirect is not followed and is not up. Never throws. */
export async function probeReady(
  url: string,
  fetcher: Fetcher,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const { status } = await fetcher(url, { signal, redirect: "manual", cache: "no-store" });
    return status === 200 ? { up: true } : { up: false, reason: "status", status };
  } catch {
    return { up: false, reason: signal.aborted ? "timeout" : "unreachable" };
  }
}

/** The one issue of the probe is found by this exact title. */
export const ISSUE_TITLE = "Poslužitelj ne odgovara na provjeru spremnosti";

const REASONS = {
  timeout: "nema odgovora u roku",
  unreachable: "veza nije uspostavljena",
} as const;
const reasonText = (result: Exclude<ProbeResult, { up: true }>): string =>
  result.reason === "status" ? `HTTP ${result.status}` : REASONS[result.reason];

const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const FIRST = new RegExp(`^Prvi pad: (${ISO})$`, "m");
const COUNT = /^Uzastopnih padova: ([1-9]\d{0,8})$/m;

/** The body of the issue: when it began, the last look and how many looks failed in a row. */
export function issueBody(first: string, last: string, count: number, reason: string): string {
  return [
    "Periodična provjera `/api/v1/ready` ne dobiva odgovor 200.",
    "",
    `Prvi pad: ${first}`,
    `Zadnja provjera: ${last}`,
    `Uzastopnih padova: ${count}`,
    `Zadnji ishod: ${reason}`,
    "",
    "Issue otvara i zatvara workflow `Provjera dostupnosti` (`scripts/uptime`). Tijelo se prepisuje pri svakoj provjeri; zatvara se sam kad provjera opet dobije 200.",
  ].join("\n");
}

export type OpenIssue = { number: number; body: string };

export type ProbeAction =
  | { kind: "none" }
  | { kind: "open"; title: string; body: string }
  | { kind: "refresh"; number: number; body: string }
  | { kind: "close"; number: number; comment: string };

/**
 * What one look does to the issue: a failure opens it or rewrites its body
 * (never a new issue and never a comment per look), a success closes it.
 * A body that does not read as ours starts the count again.
 */
export function nextAction(result: ProbeResult, open: OpenIssue | null, now: string): ProbeAction {
  if (result.up) {
    if (open === null) return { kind: "none" };
    return {
      kind: "close",
      number: open.number,
      comment: `Provjera spremnosti opet dobiva 200 (${now}).`,
    };
  }
  const reason = reasonText(result);
  if (open === null) {
    return { kind: "open", title: ISSUE_TITLE, body: issueBody(now, now, 1, reason) };
  }
  const first = FIRST.exec(open.body)?.[1];
  const count = Number(COUNT.exec(open.body)?.[1]);
  const known = first !== undefined && Number.isSafeInteger(count);
  return {
    kind: "refresh",
    number: open.number,
    body: issueBody(known ? first : now, now, known ? count + 1 : 1, reason),
  };
}
