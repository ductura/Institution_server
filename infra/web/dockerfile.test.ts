// The image of the web process (DAN-893), read as text: what the CI smoke test
// (.github/workflows/ci.yml, job checks) cannot see without building. Each rule
// is checked on the real Dockerfile and on mutations of it that must fail.
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
/** Instructions this Dockerfile may use; any other (SHELL, a misspelling) is refused. */
const KNOWN = new Set(
  "FROM WORKDIR RUN COPY ADD ENV EXPOSE USER HEALTHCHECK CMD ENTRYPOINT ARG ONBUILD LABEL".split(
    " ",
  ),
);
const NODE_MAJOR = readFileSync(resolve(ROOT, ".nvmrc"), "utf8").trim();
const ENV_ALLOWED = new Set(["HOST", "PORT"]);

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

/** Every rule the Dockerfile breaks; empty for a good one. */
function problems(text: string): string[] {
  const all = instructions(text);
  const out: string[] = [];
  const froms = all.filter((i) => i.op === "FROM");
  if (froms.length !== 2) out.push("stages");
  if (froms.some((i) => !/^\S+@sha256:[0-9a-f]{64}(\s+AS\s+\S+)?$/i.test(i.args)))
    out.push("digest");
  const final = all.slice(all.lastIndexOf(froms.at(-1)!) + 1);
  const user = final
    .filter((i) => i.op === "USER")
    .at(-1)
    ?.args.split(":")[0];
  if (user === undefined || user === "root" || /^0+$/.test(user)) out.push("root");
  const copies = final.filter((i) => i.op === "COPY" || i.op === "ADD");
  const onlyBundle = /^--from=build\s+\S+\/dist\/server\.js\s+dist\/server\.js$/;
  if (copies.length !== 1 || !copies.every((i) => i.op === "COPY" && onlyBundle.test(i.args))) {
    out.push("final copies more than the bundle");
  }
  if (final.some((i) => i.op === "RUN")) out.push("final runs a command");
  const health = final.filter((i) => i.op === "HEALTHCHECK");
  if (health.length !== 1 || !health[0]!.args.includes(`'${HEALTH}'`)) out.push("healthcheck");
  const cmd = final.filter((i) => i.op === "CMD" || i.op === "ENTRYPOINT");
  if (cmd.length !== 1 || cmd[0]!.op !== "CMD" || !sameJson(cmd[0]!.args, CMD)) out.push("cmd");
  if (all.some((i) => !KNOWN.has(i.op))) out.push("unknown instruction");
  // A parser directive (escape=) changes the continuation; a heredoc hides lines.
  if (/^#\s*\w+\s*=/m.test(text) || text.includes("<<")) out.push("unknown instruction");
  const major = new RegExp(`^\\S+/node:${NODE_MAJOR}\\.[0-9.]+-\\S+@`);
  if (froms.some((i) => !major.test(i.args))) out.push("node version");
  if (all.some((i) => i.op === "ARG" || i.op === "ONBUILD")) out.push("build argument");
  const envNames = all
    .filter((i) => i.op === "ENV")
    .flatMap((i) => [...i.args.matchAll(/(?:^|\s)([^\s=]+)=/g)].map((m) => m[1]!));
  if (all.some((i) => i.op === "ENV" && !i.args.includes("="))) out.push("environment");
  else if (envNames.some((name) => !ENV_ALLOWED.has(name))) out.push("environment");
  if (all.some((i) => i.op === "COPY" && /\.env\b/.test(i.args))) out.push("environment file");
  return out;
}

describe("infra/web/Dockerfile", () => {
  const swap = (from: string, to: string): string => {
    expect(DOCKERFILE, from).toContain(from);
    return DOCKERFILE.replace(from, to);
  };
  const lastFrom = DOCKERFILE.lastIndexOf("\nFROM ");
  const inFinal = (line: string): string =>
    `${DOCKERFILE.slice(0, lastFrom)}${DOCKERFILE.slice(lastFrom).replace("\nUSER node", `\n${line}\nUSER node`)}`;

  it.each<[string, () => string, string]>([
    ["a stage without digest", () => swap("-slim@sha256:af02", "-slim@sha256:af0"), "digest"],
    ["a tag only", () => DOCKERFILE.replace(/@sha256:[0-9a-f]+ AS build/, " AS build"), "digest"],
    ["one stage", () => DOCKERFILE.slice(lastFrom), "stages"],
    ["USER root", () => swap("USER node", "USER root"), "root"],
    ["user root, lower case", () => swap("USER node", "user root"), "root"],
    ["USER 0:0", () => swap("USER node", "USER 0:0"), "root"],
    ["USER 00", () => swap("USER node", "USER 00"), "root"],
    ["USER root:root after a tab", () => swap("USER node", "USER\troot:root"), "root"],
    ["no USER", () => swap("USER node\n", ""), "root"],
    ["root after node", () => `${DOCKERFILE}USER root\n`, "root"],
    [
      "node_modules",
      () => inFinal("COPY --from=build /src/node_modules node_modules"),
      "final copies more than the bundle",
    ],
    ["the whole context", () => inFinal("COPY . ."), "final copies more than the bundle"],
    [
      "ADD of the bundle",
      () => swap("COPY --from=build /src/dist", "ADD --from=build /src/dist"),
      "final copies more than the bundle",
    ],
    ["an install", () => inFinal("RUN npm install --omit=dev"), "final runs a command"],
    ["another path", () => swap(`'${HEALTH}'`, "'/api/v1/live'"), "healthcheck"],
    ["HEALTHCHECK NONE", () => inFinal("HEALTHCHECK NONE"), "healthcheck"],
    ["no node flags", () => swap('"--disallow-code-generation-from-strings", ', ""), "cmd"],
    ["ARG TOKEN", () => inFinal("ARG TOKEN"), "build argument"],
    [
      "ENV SECRET",
      () => swap("ENV HOST=0.0.0.0", "ENV HOST=0.0.0.0 OIDC_CLIENT_SECRET=x"),
      "environment",
    ],
    ["legacy ENV form", () => inFinal("ENV APP_DATABASE_URL postgres://x"), "environment"],
    [
      "a CRLF continued ENV",
      () => inFinal("ENV PORT=1 \\\n  APP_DATABASE_URL=x").replace(/\n/g, "\r\n"),
      "environment",
    ],
    ["an NBSP for the space", () => inFinal("USER\u00A0root"), "unknown instruction"],
    ["a misspelt instruction", () => inFinal("UZER root"), "unknown instruction"],
    ["an escape directive", () => `# escape=\`\n${DOCKERFILE}`, "unknown instruction"],
    ["a heredoc", () => inFinal("RUN <<EOF\nEOF"), "unknown instruction"],
    ["another Node major", () => DOCKERFILE.replaceAll("node:24.", "node:22."), "node version"],
    ["COPY .env", () => inFinal("COPY .env .env"), "environment file"],
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

  it("CI builds the image and smoke tests it in the job checks, which ci-ok requires", () => {
    const checks = CI.slice(CI.indexOf("\n  checks:\n"), CI.indexOf("\n  database:\n"));
    const step = checks.slice(checks.indexOf("- name: Slika web procesa (DAN-893)"));
    expect(step).toContain("docker build -f infra/web/Dockerfile");
    expect(step).toContain("docker run -d");
    expect(step).toContain("= healthy ]");
    expect(step).toContain(`curl -fsS "http://127.0.0.1:4000${HEALTH}"`);
    expect(step).not.toMatch(/\n {8}if:|continue-on-error|\|\| true|set \+e/);
  });
});
