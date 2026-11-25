import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

type Update = {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
  schedule: { interval: string };
};

const updates = (parse(read(".github/dependabot.yml")) as { version: number; updates: Update[] })
  .updates;

/** Active (uncommented) variable assignments of .env.example, name to value. */
const envExample = (): Map<string, string> => {
  const entries = read(".env.example")
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line): [string, string] => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    });
  return new Map(entries);
};

const documented = (): string[] =>
  read(".env.example")
    .split("\n")
    .map((line) => /^#? ?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

describe("dependabot.yml", () => {
  it("covers the pnpm workspace and the GitHub Actions on a schedule", () => {
    const ecosystems = updates.map((u) => u["package-ecosystem"]).sort();
    expect(ecosystems).toEqual(["github-actions", "npm"]);
    for (const update of updates) expect(update.schedule.interval).toBe("weekly");
    const npm = updates.find((u) => u["package-ecosystem"] === "npm");
    expect(npm?.directories).toEqual(["/", "/packages/*"]);
  });
});

describe(".env.example", () => {
  it("names every variable of the Render blueprint (render.yaml)", () => {
    const blueprint = [...read("render.yaml").matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(blueprint.length).toBeGreaterThan(0);
    for (const name of blueprint) expect(documented(), name).toContain(name);
  });

  it("names every variable the server reads directly", () => {
    const sources = [
      "server/config/environment.ts",
      "server/settings/metrics-interval.ts",
      "server/settings/deployment.ts",
      "server/settings/test-mode.ts",
    ].map(read);
    const names = [
      ...sources
        .join("\n")
        .matchAll(/\b(DUCTURA_[A-Z_]+|METRICS_INTERVAL_MS|SHUTDOWN_GRACE_MS)\b/g),
    ];
    for (const [name] of names) expect(documented(), name).toContain(name);
  });

  it("holds no secret value and no duplicate name", () => {
    const names = documented();
    expect(new Set(names).size).toBe(names.length);
    const values = envExample();
    for (const secret of ["OIDC_CLIENT_SECRET", "DUCTURA_PROVISIONING_TOKEN"]) {
      expect(values.get(secret), secret).toBe("");
    }
    // Only loopback database hosts; a real URL would name another host.
    for (const [name, value] of values) {
      if (name.endsWith("DATABASE_URL") && value !== "")
        expect(value, name).toContain("@127.0.0.1:");
    }
  });
});
