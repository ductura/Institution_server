// STG-OIDC (Ductus#2055): the image of the staging fake OIDC provider, read
// as text. It holds no secret and no .env file, always runs the staging mode
// and runs the provider's own entry point (packages/test-fakes/oidc/server.ts).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const DOCKERFILE = read("infra/fake-oidc/Dockerfile");
const IGNORE = read("infra/fake-oidc/Dockerfile.dockerignore");
const WEB = read("infra/web/Dockerfile");

type Instruction = { op: string; args: string };

/** Instructions in order: `\` continuations joined, comments dropped, op upper case. */
function instructions(text: string): Instruction[] {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/\\[ \t]*\n/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [op = "", args = ""] = line.split(/[ \t]+(.*)/su);
      return { op: op.toUpperCase(), args: args.trim() };
    });
}

/** ENV pairs of one instruction, `NAME=value` form. */
const envPairs = (args: string): [string, string][] =>
  args.split(/\s+/u).map((pair) => {
    const at = pair.indexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
  });

/** The instructions of the final stage (after the last FROM). */
function finalStage(text: string): Instruction[] {
  const all = instructions(text);
  const last = all.map((i) => i.op).lastIndexOf("FROM");
  return all.slice(last);
}

const FROMS = (text: string) =>
  instructions(text)
    .filter((i) => i.op === "FROM")
    .map((i) => i.args.split(/\s+/u)[0]);

describe("infra/fake-oidc/Dockerfile", () => {
  const all = instructions(DOCKERFILE);
  const final = finalStage(DOCKERFILE);

  it("is built on the base image of infra/web/Dockerfile, pinned by digest", () => {
    const base = FROMS(WEB)[0];
    expect(base).toMatch(/@sha256:[0-9a-f]{64}$/u);
    for (const from of FROMS(DOCKERFILE)) expect(from).toBe(base);
  });

  it("fixes the staging mode and sets nothing else but the port", () => {
    const env = new Map(all.filter((i) => i.op === "ENV").flatMap((i) => envPairs(i.args)));
    expect(env.get("DUCTURA_DEPLOYMENT")).toBe("staging");
    expect([...env.keys()].sort()).toEqual(["DUCTURA_DEPLOYMENT", "PORT"]);
    // No ARG either: nothing reaches the image from the build command.
    expect(all.some((i) => i.op === "ARG" || i.op === "ADD")).toBe(false);
  });

  it("names no secret, no local value of the provider and no .env file", () => {
    // The health check reads process.env.PORT; no other instruction names .env.
    const text = all
      .filter((i) => i.op !== "HEALTHCHECK")
      .map((i) => i.args)
      .join("\n");
    for (const word of [
      "FAKE_OIDC_CLIENT_SECRET",
      "FAKE_OIDC_COOKIE_KEY",
      "ductus-local-only",
      "ductus-fake-oidc-local-only",
      ".env",
      "NODE_ENV",
    ]) {
      expect(text, word).not.toContain(word);
    }
  });

  it("copies into the final stage only the dependencies and the provider's package", () => {
    const copies = final.filter((i) => i.op === "COPY").map((i) => i.args);
    expect(copies).toEqual([
      "--from=build /src/node_modules node_modules",
      "--from=build /src/packages/test-fakes/node_modules packages/test-fakes/node_modules",
      "packages/test-fakes/package.json packages/test-fakes/package.json",
      "packages/test-fakes/oidc packages/test-fakes/oidc",
    ]);
  });

  it("installs from the lockfile, production dependencies only, without scripts", () => {
    const install = all.find((i) => i.op === "RUN" && i.args.includes("pnpm install"));
    expect(install?.args).toContain("--frozen-lockfile");
    expect(install?.args).toContain("--prod");
    expect(install?.args).toContain("--ignore-scripts");
  });

  it("runs the provider's entry point as an unprivileged user", () => {
    expect(final.find((i) => i.op === "USER")?.args).toBe("node");
    const cmd = final.filter((i) => i.op === "CMD").at(-1)?.args ?? "";
    expect(JSON.parse(cmd)).toEqual(["node", "packages/test-fakes/oidc/server.ts"]);
    expect(existsSync(resolve(ROOT, "packages/test-fakes/oidc/server.ts"))).toBe(true);
  });

  it("keeps every .env, the tests and local state out of the build context", () => {
    const lines = IGNORE.split("\n").map((line) => line.trim());
    for (const entry of ["**/.env*", "**/*.test.ts", "**/node_modules", ".git"]) {
      expect(lines).toContain(entry);
    }
  });
});
