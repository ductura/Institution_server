// The image of the web process (DAN-893), read as text: what the CI smoke test
// (.github/workflows/ci.yml, job checks) cannot see without building. Each rule
// is checked on the real Dockerfile and on mutations of it that must fail.
// Since DAN-938-2 the stages are build, test-server and the final one; the
// rules of a runtime stage hold for both, and a mutation hits each of them.
import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_NODE_FLAGS } from "../../scripts/build/index.ts";
import { ROUTES } from "../../server/contracts/index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DOCKERFILE = readFileSync(resolve(import.meta.dirname, "Dockerfile"), "utf8");
const IGNORE = readFileSync(resolve(import.meta.dirname, "Dockerfile.dockerignore"), "utf8");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const HEALTH = ROUTES.find((route) => route.id === "platform.health.get")!.path;
const CMD = ["node", ...SERVER_NODE_FLAGS, "dist/server.js"];
const PDF_WORKER_COPY = "--from=build /src/dist/pdf-import-worker.js dist/pdf-import-worker.js";
const RUNTIME_COPIES = ["--from=build /src/dist/server.js dist/server.js", PDF_WORKER_COPY];
/** Instructions this Dockerfile may use; any other (SHELL, a misspelling) is refused. */
const KNOWN = new Set(
  "FROM WORKDIR RUN COPY ADD ENV EXPOSE USER HEALTHCHECK CMD ENTRYPOINT ARG ONBUILD LABEL".split(
    " ",
  ),
);
const NODE_MAJOR = readFileSync(resolve(ROOT, ".nvmrc"), "utf8").trim();
const ENV_ALLOWED = new Set(["HOST", "PORT"]);
/** The test server's mode (S-1H.7): only in its stage, and only these exact values. */
const TEST_MODE = new Map([
  ["NODE_ENV", "test"],
  ["DUCTURA_MODE", "test"],
]);
const STAGES = ["build", "test-server", undefined];

/** True when `args` is the JSON (exec) form of exactly `expected`. */
function sameJson(args: string, expected: readonly string[]): boolean {
  try {
    return JSON.stringify(JSON.parse(args)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

type Instruction = { op: string; args: string };

/** Instructions in order: CRLF and `\` continuations joined, comments dropped, op upper case.
 * Only space and tab separate the op, as for Docker; any other blank makes it unknown. */
function instructions(text: string): Instruction[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\[ \t]*\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [op = "", args = ""] = line.split(/[ \t]+(.*)/s);
      return { op: op.toUpperCase(), args: args.trim() };
    });
}

type Stage = { name: string | undefined; body: Instruction[] };

/** The stages in order: the FROM name after AS (exact case) and the instructions after it. */
function stages(all: Instruction[]): Stage[] {
  const out: Stage[] = [];
  for (const instruction of all) {
    if (instruction.op === "FROM")
      out.push({ name: /\sAS\s+(\S+)$/i.exec(instruction.args)?.[1], body: [] });
    else out.at(-1)?.body.push(instruction);
  }
  return out;
}

/** Every NAME=value of the ENV instructions, in order. */
function assignments(body: Instruction[]): [string, string][] {
  return body
    .filter((i) => i.op === "ENV")
    .flatMap((i) =>
      [...i.args.matchAll(/(?:^|\s)([^\s=]+)=(\S*)/g)].map((m): [string, string] => [m[1]!, m[2]!]),
    );
}

/** The rules of a stage that runs the server (test-server and the final one). */
function runtimeProblems(body: Instruction[]): string[] {
  const out: string[] = [];
  const user = body
    .filter((i) => i.op === "USER")
    .at(-1)
    ?.args.split(":")[0];
  if (user === undefined || user === "root" || /^0+$/.test(user)) out.push("root");
  const copies = body.filter((i) => i.op === "COPY" || i.op === "ADD");
  if (
    copies.length !== RUNTIME_COPIES.length ||
    copies.some(
      (i, index) => i.op !== "COPY" || i.args.replace(/\s+/g, " ") !== RUNTIME_COPIES[index],
    )
  ) {
    out.push("final copies more than the bundle");
  }
  if (body.some((i) => i.op === "RUN")) out.push("final runs a command");
  const health = body.filter((i) => i.op === "HEALTHCHECK");
  if (health.length !== 1 || !health[0]!.args.includes(`'${HEALTH}'`)) out.push("healthcheck");
  const cmd = body.filter((i) => i.op === "CMD" || i.op === "ENTRYPOINT");
  if (cmd.length !== 1 || cmd[0]!.op !== "CMD" || !sameJson(cmd[0]!.args, CMD)) out.push("cmd");
  return out;
}

/** Every rule the Dockerfile breaks; empty for a good one. */
function problems(text: string): string[] {
  const all = instructions(text);
  const out: string[] = [];
  const froms = all.filter((i) => i.op === "FROM");
  const staged = stages(all);
  // The final stage must stay last: it is the default target of `docker build`.
  if (JSON.stringify(staged.map((stage) => stage.name)) !== JSON.stringify(STAGES))
    out.push("stages");
  if (froms.some((i) => !/^\S+@sha256:[0-9a-f]{64}(\s+AS\s+\S+)?$/i.test(i.args)))
    out.push("digest");
  for (const stage of staged.slice(1)) out.push(...runtimeProblems(stage.body));
  if (all.some((i) => !KNOWN.has(i.op))) out.push("unknown instruction");
  // A parser directive (escape=) changes the continuation; a heredoc hides lines.
  if (/^#\s*\w+\s*=/m.test(text) || text.includes("<<")) out.push("unknown instruction");
  const major = new RegExp(`^\\S+/node:${NODE_MAJOR}\\.[0-9.]+-\\S+@`);
  if (froms.some((i) => !major.test(i.args))) out.push("node version");
  if (all.some((i) => i.op === "ARG" || i.op === "ONBUILD")) out.push("build argument");
  if (all.some((i) => i.op === "ENV" && !i.args.includes("="))) out.push("environment");
  for (const stage of staged) {
    const test = stage.name === "test-server";
    const pairs = assignments(stage.body);
    const allowed = (name: string): boolean =>
      ENV_ALLOWED.has(name) || (test && TEST_MODE.has(name));
    if (pairs.some(([name]) => !allowed(name))) out.push("environment");
    if (test) {
      const wrong = pairs.some(
        ([name, value]) => TEST_MODE.has(name) && value !== TEST_MODE.get(name),
      );
      const missing = [...TEST_MODE.keys()].some((key) => !pairs.some(([name]) => name === key));
      if (wrong || missing) out.push("test mode");
    }
  }
  if (all.some((i) => i.op === "COPY" && /\.env\b/.test(i.args))) out.push("environment file");
  return [...new Set(out)];
}

describe("infra/web/Dockerfile", () => {
  const swap = (from: string, to: string): string => {
    expect(DOCKERFILE, from).toContain(from);
    return DOCKERFILE.replace(from, to);
  };
  const lastFrom = DOCKERFILE.lastIndexOf("\nFROM ");
  const testFrom = DOCKERFILE.indexOf("\nFROM ", DOCKERFILE.indexOf(" AS build"));
  /** The Dockerfile with `change` applied to one runtime stage only. */
  const inStage = (stage: "test-server" | "final", change: (body: string) => string): string => {
    const [start, end] = stage === "final" ? [lastFrom, DOCKERFILE.length] : [testFrom, lastFrom];
    const body = DOCKERFILE.slice(start, end);
    const changed = change(body);
    expect(changed, stage).not.toBe(body);
    return DOCKERFILE.slice(0, start) + changed + DOCKERFILE.slice(end);
  };
  const before = (line: string) => (body: string) =>
    body.replace("\nUSER node", `\n${line}\nUSER node`);
  const replace = (from: string, to: string) => (body: string) => body.replace(from, to);
  const inFinal = (line: string): string => inStage("final", before(line));
  /** A mutation of a runtime stage, checked on both. */
  const runtime: [string, (body: string) => string, string][] = [
    ["USER root", replace("USER node", "USER root"), "root"],
    ["user root, lower case", replace("USER node", "user root"), "root"],
    ["USER 0:0", replace("USER node", "USER 0:0"), "root"],
    ["USER 00", replace("USER node", "USER 00"), "root"],
    ["USER root:root after a tab", replace("USER node", "USER\troot:root"), "root"],
    ["no USER", replace("USER node\n", ""), "root"],
    ["root after node", (body) => `${body}USER root\n`, "root"],
    [
      "node_modules",
      before("COPY --from=build /src/node_modules node_modules"),
      "final copies more than the bundle",
    ],
    ["the whole context", before("COPY . ."), "final copies more than the bundle"],
    ["no PDF worker", replace(`COPY ${PDF_WORKER_COPY}`, ""), "final copies more than the bundle"],
    [
      "ADD of the bundle",
      replace("COPY --from=build /src/dist", "ADD --from=build /src/dist"),
      "final copies more than the bundle",
    ],
    [
      "a copy from another stage",
      replace("COPY --from=build /src/dist", "COPY --from=test-server /src/dist"),
      "final copies more than the bundle",
    ],
    ["an install", before("RUN npm install --omit=dev"), "final runs a command"],
    ["another path", replace(`'${HEALTH}'`, "'/api/v1/live'"), "healthcheck"],
    ["HEALTHCHECK NONE", before("HEALTHCHECK NONE"), "healthcheck"],
    ["no node flags", replace('"--disallow-code-generation-from-strings", ', ""), "cmd"],
    ["ARG TOKEN", before("ARG TOKEN"), "build argument"],
    [
      "ENV SECRET",
      replace("ENV HOST=0.0.0.0", "ENV HOST=0.0.0.0 OIDC_CLIENT_SECRET=x"),
      "environment",
    ],
    ["legacy ENV form", before("ENV APP_DATABASE_URL postgres://x"), "environment"],
    ["an NBSP for the space", before("USER\u00A0root"), "unknown instruction"],
    ["a misspelt instruction", before("UZER root"), "unknown instruction"],
    ["COPY .env", before("COPY .env .env"), "environment file"],
  ];

  it.each(
    runtime.flatMap(([name, change, problem]) =>
      (["test-server", "final"] as const).map(
        (stage): [string, "test-server" | "final", (body: string) => string, string] => [
          name,
          stage,
          change,
          problem,
        ],
      ),
    ),
  )("refuses %s in the %s stage", (_name, stage, change, problem) => {
    expect(problems(inStage(stage, change))).toContain(problem);
  });

  // S-1H.7 (DAN-938-2): the test mode only in its own stage, which is never the default target.
  it.each<[string, () => string, string]>([
    ["DUCTURA_MODE in the final stage", () => inFinal("ENV DUCTURA_MODE=test"), "environment"],
    ["NODE_ENV in the final stage", () => inFinal("ENV NODE_ENV=test"), "environment"],
    [
      "DUCTURA_MODE among other keys of the final stage",
      () =>
        inStage(
          "final",
          replace("ENV HOST=0.0.0.0 PORT=4000", "ENV HOST=0.0.0.0 DUCTURA_MODE=test PORT=4000"),
        ),
      "environment",
    ],
    [
      "the mode in the build stage",
      () => swap("RUN pnpm build", "ENV DUCTURA_MODE=test\nRUN pnpm build"),
      "environment",
    ],
    [
      "test-server as the last stage",
      () =>
        DOCKERFILE.slice(0, testFrom) +
        DOCKERFILE.slice(lastFrom) +
        DOCKERFILE.slice(testFrom, lastFrom),
      "stages",
    ],
    [
      "no test-server stage",
      () => DOCKERFILE.slice(0, testFrom) + DOCKERFILE.slice(lastFrom),
      "stages",
    ],
    ["another name", () => swap(" AS test-server", " AS Test-Server"), "stages"],
    [
      "a name on the final stage",
      () =>
        `${DOCKERFILE.slice(0, lastFrom)}${DOCKERFILE.slice(lastFrom).replace("trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0\n", "trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS web\n")}`,
      "stages",
    ],
    ["four stages", () => `${DOCKERFILE}${DOCKERFILE.slice(lastFrom)}`, "stages"],
    ["DUCTURA_MODE Test", () => swap("DUCTURA_MODE=test", "DUCTURA_MODE=Test"), "test mode"],
    ["DUCTURA_MODE quoted", () => swap("DUCTURA_MODE=test", 'DUCTURA_MODE="test"'), "test mode"],
    ["NODE_ENV production", () => swap("NODE_ENV=test", "NODE_ENV=production"), "test mode"],
    ["no DUCTURA_MODE", () => swap(" DUCTURA_MODE=test", ""), "test mode"],
    ["no NODE_ENV", () => swap(" NODE_ENV=test", ""), "test mode"],
    [
      "NODE_ENV test, then production",
      () => inStage("test-server", before("ENV NODE_ENV=production")),
      "test mode",
    ],
    [
      "legacy ENV DUCTURA_MODE test",
      () => inStage("test-server", before("ENV DUCTURA_MODE test")),
      "environment",
    ],
    [
      "test-server without digest",
      () => swap(/@sha256:af02\w+ AS test-server/.exec(DOCKERFILE)![0], " AS test-server"),
      "digest",
    ],
  ])("refuses %s", (_name, mutate, problem) => {
    expect(problems(mutate())).toContain(problem);
  });

  it.each<[string, () => string, string]>([
    ["a stage without digest", () => swap("-slim@sha256:af02", "-slim@sha256:af0"), "digest"],
    ["a tag only", () => DOCKERFILE.replace(/@sha256:[0-9a-f]+ AS build/, " AS build"), "digest"],
    ["one stage", () => DOCKERFILE.slice(lastFrom), "stages"],
    [
      "a CRLF continued ENV",
      () => inFinal("ENV PORT=1 \\\n  APP_DATABASE_URL=x").replace(/\n/g, "\r\n"),
      "environment",
    ],
    ["an escape directive", () => `# escape=\`\n${DOCKERFILE}`, "unknown instruction"],
    ["a heredoc", () => inFinal("RUN <<EOF\nEOF"), "unknown instruction"],
    ["another Node major", () => DOCKERFILE.replaceAll("node:24.", "node:22."), "node version"],
  ])("refuses %s", (_name, mutate, problem) => {
    expect(problems(mutate())).toContain(problem);
  });

  it("the real Dockerfile keeps every rule, also with CRLF line ends", () => {
    expect(problems(DOCKERFILE)).toEqual([]);
    expect(problems(DOCKERFILE.replace(/\n/g, "\r\n"))).toEqual([]);
  });

  it("the build context leaves out local state and every .env", () => {
    const lines = IGNORE.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines).toEqual(expect.arrayContaining([".git", "**/node_modules", "dist", ".stack"]));
    expect(lines.some((line) => line.startsWith("!"))).toBe(false);
    // QA of ecdf88c: every name that starts with .env, at any depth, not only .env and .env.*.
    const ignored = (path: string): boolean => lines.some((line) => matchesGlob(path, line));
    for (const path of [
      ".env",
      ".envrc",
      ".env-secrets",
      ".env.local",
      "server/.env",
      "a/b/.envrc",
    ]) {
      expect(ignored(path), path).toBe(true);
    }
    for (const path of ["server/config/environment.ts", "package.json", "server/server.ts"]) {
      expect(ignored(path), path).toBe(false);
    }
  });

  // A separate step: its own container, port and trap, so the image of the
  // web process is checked exactly as before (DAN-938-2).
  it("CI builds the test server image in the job checks and checks its environment", () => {
    const checks = CI.slice(CI.indexOf("\n  checks:\n"), CI.indexOf("\n  database:\n"));
    const web = checks.slice(
      checks.indexOf("- name: Slika web procesa (DAN-893)"),
      checks.indexOf("- name: Slika testnog servera (DAN-938)"),
    );
    const step = checks.slice(checks.indexOf("- name: Slika testnog servera (DAN-938)"));
    expect(web).toContain("docker build -f infra/web/Dockerfile -t ductura-web:ci .");
    expect(web).not.toContain("--target");
    expect(step).toContain("docker build -f infra/web/Dockerfile --target test-server");
    expect(step).toContain('"DUCTURA_MODE=test", "HOST=0.0.0.0", "NODE_ENV=test", "PORT=4000"');
    expect(step).toContain("= healthy ]");
    expect(step).toContain("docker inspect -f '{{.State.ExitCode}}' ductura-test-server)\" = 0 ]");
    // ZEL-CI-SRV: once per run, on the leg provjere of checks; no other condition.
    expect(step).toContain("\n        if: matrix.leg == 'provjere'\n");
    expect(step.replaceAll("\n        if: matrix.leg == 'provjere'\n", "\n")).not.toMatch(
      /\n {8}if:|continue-on-error|\|\| true|set \+e/,
    );
  });

  it("CI builds the image and smoke tests it in the job checks, which ci-ok requires", () => {
    const checks = CI.slice(CI.indexOf("\n  checks:\n"), CI.indexOf("\n  database:\n"));
    const step = checks.slice(checks.indexOf("- name: Slika web procesa (DAN-893)"));
    expect(step).toContain("docker build -f infra/web/Dockerfile");
    expect(step).toContain("docker run -d");
    expect(step).toContain("= healthy ]");
    expect(step).toContain(`curl -fsS "http://127.0.0.1:4000${HEALTH}"`);
    // ZEL-CI-SRV: once per run, on the leg provjere of checks; no other condition.
    expect(step).toContain("\n        if: matrix.leg == 'provjere'\n");
    expect(step.replaceAll("\n        if: matrix.leg == 'provjere'\n", "\n")).not.toMatch(
      /\n {8}if:|continue-on-error|\|\| true|set \+e/,
    );
  });
});
