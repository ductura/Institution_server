// DAN-1569: what an open pull request says about its own gate, read from the
// pull request and its comments (Ductus docs/ENGINEERING_SYSTEM.md: Risk,
// Review-Head / Review-Verdict, QA-Head / QA-Verdict). A reading for the
// owner's eye, not the gate: the gate's own status check decides.

export type Verdict = "PASS" | "FAIL" | "BLOCK";

export type PullInput = {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  headSha: string;
  updatedAt: string;
  body: string;
  /** Bodies of the pull request's comments and reviews, oldest first. */
  comments: string[];
  /** Conclusions of the head commit's check runs; null for one still running. */
  checks: (string | null)[];
};

export type PullRow = {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updatedAt: string;
  risk: "low" | "standard" | "critical" | null;
  /** The newest verdict written for the current head; null when there is none for it. */
  review: Verdict | null;
  qa: Verdict | null;
  ci: "passed" | "failed" | "running" | "none";
  /** Derived here: critical, not a draft, review and QA PASS on this head, CI passed. */
  awaitsOwner: boolean;
};

const RISK = /^Risk:[ \t]*(low|standard|critical)[ \t]*$/m;

/** The newest `<prefix>-Verdict` among comments whose `<prefix>-Head` is `headSha`. */
export function verdictOn(
  comments: readonly string[],
  prefix: "Review" | "QA",
  headSha: string,
): Verdict | null {
  const head = new RegExp(`^${prefix}-Head:[ \\t]*([0-9a-f]{40})[ \\t]*$`, "m");
  const verdict = new RegExp(`^${prefix}-Verdict:[ \\t]*(PASS|FAIL|BLOCK)[ \\t]*$`, "m");
  for (const comment of [...comments].reverse()) {
    const found = verdict.exec(comment);
    if (found && head.exec(comment)?.[1] === headSha) return found[1] as Verdict;
  }
  return null;
}

export function ciOf(checks: readonly (string | null)[]): PullRow["ci"] {
  if (checks.length === 0) return "none";
  if (
    checks.some((check) => check !== null && !["success", "skipped", "neutral"].includes(check))
  ) {
    return "failed";
  }
  return checks.includes(null) ? "running" : "passed";
}

export function pullRow(pull: PullInput): PullRow {
  const risk = (RISK.exec(pull.body)?.[1] ?? null) as PullRow["risk"];
  const review = verdictOn(pull.comments, "Review", pull.headSha);
  const qa = verdictOn(pull.comments, "QA", pull.headSha);
  const ci = ciOf(pull.checks);
  const { repo, number, title, url, draft, updatedAt } = pull;
  const awaitsOwner =
    risk === "critical" && !draft && review === "PASS" && qa === "PASS" && ci === "passed";
  return { repo, number, title, url, draft, updatedAt, risk, review, qa, ci, awaitsOwner };
}

export type GetJson = (url: string) => Promise<unknown>;

// GitHub's own field names are read by key, as its JSON writes them.
type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");
/**
 * The non-empty bodies of issue comments and reviews in the order they were
 * written, so the latest verdict wins wherever it was posted.
 */
const bodies = (...lists: unknown[]) =>
  lists
    .flatMap((list) => list as Json[])
    .map((entry) => ({
      body: text(entry["body"]),
      at: text(entry["created_at"]) || text(entry["submitted_at"]),
    }))
    .filter((entry) => entry.body !== "")
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((entry) => entry.body);

/** The open pull requests of `repo` (`owner/name`), read with GET requests only. */
export async function readPulls(repo: string, get: GetJson): Promise<PullInput[]> {
  const api = `https://api.github.com/repos/${repo}`;
  const pulls = (await get(`${api}/pulls?state=open&per_page=100`)) as Json[];
  return Promise.all(
    pulls.map(async (pull) => {
      const number = Number(pull["number"]);
      const headSha = text((pull["head"] as Json | undefined)?.["sha"]);
      const [comments, reviews, checks] = await Promise.all([
        get(`${api}/issues/${number}/comments?per_page=100`),
        get(`${api}/pulls/${number}/reviews?per_page=100`),
        get(`${api}/commits/${headSha}/check-runs?per_page=100`),
      ]);
      return {
        repo,
        number,
        title: text(pull["title"]),
        url: text(pull["html_url"]),
        draft: pull["draft"] === true,
        headSha,
        updatedAt: text(pull["updated_at"]),
        body: text(pull["body"]),
        comments: bodies(comments, reviews),
        checks: ((checks as Json)["check_runs"] as Json[]).map((run) =>
          typeof run["conclusion"] === "string" ? run["conclusion"] : null,
        ),
      };
    }),
  );
}
