// Risk floor by path: a PR declares its Risk, and the changed paths set the
// lowest Risk it may declare. TypeScript port of Ductus
// scripts/engineering/pr-metadata-core.mjs (minimumRisk, evaluateMetadata) with
// the parts of protected-paths.mjs and metadata-parser.mjs it needs; the
// paths follow docs/server-map.md. Rules: Ductus docs/ENGINEERING_SYSTEM.md §5.

export type Risk = "low" | "standard" | "critical";
export type GateError = { code: string; messageKey: string };
export type Metadata = { agent: string; risk: Risk; task: string; minimumRisk: Risk };
export type MetadataResult =
  | { ok: true; value: Metadata }
  | { ok: false; error: GateError; statusText: string };

// No prototype: `"constructor" in RISK_RANK` must be false (Ductus F-041 b).
const RISK_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, { low: 0, standard: 1, critical: 2 }),
);
const RISKS: readonly Risk[] = ["low", "standard", "critical"];
const AGENT_RE =
  /^(claude|codex|chatgpt|grok):[A-Za-z0-9_-]+:(orchestrator|platforma|backend|frontend|reviewer|qa|bug-hunter|product-ux|short)$/;

// Globs: `**` is any number of segments, `*` stays within one segment.
// .github/CODEOWNERS covers every entry (server/risk-floor.test.ts).
export const CRITICAL_PATHS: readonly string[] = [
  "server/server.ts",
  "server/http/**",
  "server/traffic/ip-rules*",
  "server/session/**",
  "server/external/srce-auth/**",
  "server/contracts/authz-matrix*",
  "db/**/migrations/**",
  "db/**/tests/**",
  ".github/**",
  "CLAUDE.md",
  "AGENTS.md",
  // This list protects itself, as in Ductus.
  "scripts/engineering/**",
  // Transitional entry point, HTTP server and test access rules until
  // server.ts and server/http replace them (docs/server-map.md, "Prelazno stanje").
  "server/index.ts",
  "server/app.ts",
  "server/access.ts",
];

const STANDARD_RE =
  /^(?:(?:server|scripts|db|test-support)\/|(?:package\.json|pnpm-lock\.yaml|tsconfig\.json|vitest\.config\.ts|\.nvmrc)$)/;

// Files an agent loads as instructions (CLAUDE.md, AGENTS.md, GEMINI.md, Copilot
// instructions) and agent configuration, at any depth (Ductus F-039).
const AGENT_INSTRUCTIONS_RE =
  /(?:^|\/)(?:(?:claude|agents|gemini)[^/]*|copilot-instructions|[^/]*\.instructions)\.md$/;
const AGENT_CONTROL_SEGMENTS = new Set([".claude", ".agents", ".codex"]);

/** Separators, repeated slashes and a leading "./" or "/" do not matter. */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^(?:\.?\/)+/, "");
}

export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // "s": a file name may contain a newline and must not slip past `.*`.
  return new RegExp(`^${source}$`, "s");
}

const CRITICAL_RES = CRITICAL_PATHS.map((glob) => globToRegExp(glob.toLowerCase()));

export function isAgentControlPath(path: string): boolean {
  const segments = normalizePath(path).toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => AGENT_CONTROL_SEGMENTS.has(segment)) ||
    name === ".mcp.json" ||
    AGENT_INSTRUCTIONS_RE.test(name)
  );
}

function floorOf(path: string): { risk: Risk; label: string } {
  const file = normalizePath(path).toLowerCase();
  if (CRITICAL_RES.some((re) => re.test(file)) || isAgentControlPath(file)) {
    return { risk: "critical", label: "governance/trust-critical path" };
  }
  if (STANDARD_RE.test(file)) return { risk: "standard", label: "executable/runtime/config path" };
  return { risk: "low", label: "" };
}

/** Floor from the changed paths; a rename must pass both names (changedPaths). */
export function minimumRisk(paths: readonly string[]): { risk: Risk; labels: string[] } {
  let rank = 0;
  const labels = new Set<string>();
  for (const path of paths) {
    const floor = floorOf(path);
    if (!floor.label) continue;
    rank = Math.max(rank, RISK_RANK[floor.risk] ?? 0);
    labels.add(floor.label);
  }
  return { risk: RISKS[rank] ?? "critical", labels: [...labels] };
}

/** Paths of a REST pull-request files list; a rename counts under both names. */
export function changedPaths(
  files: readonly { filename: string; previous_filename?: string }[],
): string[] {
  const out = new Set<string>();
  for (const file of files) {
    for (const path of [file.filename, file.previous_filename]) if (path) out.add(normalizePath(path));
  }
  return [...out].sort();
}

/** Body lines outside fenced and indented code blocks (CommonMark). */
function metadataLines(body: string): string[] {
  const active: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (fence !== null) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    active.push(line.trim());
  }
  return active;
}

export function field(body: string, name: string): string | null {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of metadataLines(body)) {
    if (line.toLowerCase().startsWith(prefix)) return line.slice(prefix.length).trim() || null;
  }
  return null;
}

function fail(code: string, messageKey: string, statusText: string): MetadataResult {
  return { ok: false, error: { code, messageKey }, statusText };
}

/** Checks Agent, Risk and Task in a PR body against the floor of its changed paths. */
export function evaluateMetadata(body: string, paths: readonly string[]): MetadataResult {
  const agent = field(body, "Agent");
  const risk = field(body, "Risk")?.toLowerCase() ?? null;
  const task = field(body, "Task");
  if (!agent || !AGENT_RE.test(agent)) {
    return fail("AGENT_INVALID", "gate.agent_invalid", "Missing or invalid Agent metadata.");
  }
  if (!risk || !Object.hasOwn(RISK_RANK, risk)) {
    return fail("RISK_INVALID", "gate.risk_invalid", "Risk must be low, standard, or critical.");
  }
  if (!task) return fail("TASK_MISSING", "gate.task_missing", "Missing Task metadata.");

  const minimum = minimumRisk(paths);
  const declared = risk as Risk;
  if ((RISK_RANK[declared] ?? 0) < (RISK_RANK[minimum.risk] ?? 0)) {
    // Fixed labels only: the text becomes a commit status, so it carries no file name.
    return fail(
      "RISK_BELOW_FLOOR",
      "gate.risk_below_floor",
      `Declared Risk ${declared} is below minimum ${minimum.risk} (${minimum.labels.join("; ")}).`,
    );
  }
  return { ok: true, value: { agent, risk: declared, task, minimumRisk: minimum.risk } };
}
