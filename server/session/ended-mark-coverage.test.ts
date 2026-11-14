import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Ported from Ductus src/server/auth/ended-mark-coverage.test.ts at d52a92c3
 * (S-0.18, DAN-731). There, DAN-99 (contract on #1836): the institution and
 * teacher screens and the teacher GET routes read the session cookie only
 * through liveSessionToken, so a session this browser has ended shows no data.
 * The screens stay in the web app (PLAN §4: pages are not ported) and the
 * teacher routes come with their own tasks, so the same invariant is checked
 * over the whole server instead: outside server/session, which owns the
 * cookie, no server file reads it by name. A new route anywhere in server/ is
 * found on disk and checked too.
 */
const ROOT = process.cwd();

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const relativePath = (file: string) => relative(ROOT, file).replaceAll("\\", "/");

const SERVER_FILES = files(join(ROOT, "server")).map(relativePath).sort();
const OUTSIDE_SESSION = SERVER_FILES.filter((file) => !file.startsWith("server/session/"));

/** The session cookie read by its name, through the constant or spelled out. */
const RAW_SESSION_READ = /SESSION_COOKIE_NAME|ductus_session/;

describe("ended sessions outside server/session (DAN-99)", () => {
  it("finds the server files on disk, the session area among them", () => {
    expect(SERVER_FILES).toEqual(
      expect.arrayContaining([
        "server/app.ts",
        "server/session/ended-mark.ts",
        "server/session/session-token.ts",
      ]),
    );
    expect(OUTSIDE_SESSION).toContain("server/app.ts");
    expect(OUTSIDE_SESSION.some((file) => file.startsWith("server/session/"))).toBe(false);
  });

  it("would catch the cookie read by its constant or by its spelled-out name", () => {
    expect(RAW_SESSION_READ.test("jar.get(SESSION_COOKIE_NAME)?.value")).toBe(true);
    expect(RAW_SESSION_READ.test('jar.get("__Host-ductus_session")?.value')).toBe(true);
    expect(RAW_SESSION_READ.test("liveSessionToken(await cookies())")).toBe(false);
  });

  it.each(OUTSIDE_SESSION)("%s does not read the session cookie by name", (file) => {
    expect(readFileSync(join(ROOT, file), "utf8")).not.toMatch(RAW_SESSION_READ);
  });
});
