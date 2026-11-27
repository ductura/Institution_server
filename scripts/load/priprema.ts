// ISTR-9: prepares one k6 load run on a separate local stack (`pnpm lokalno
// --izravno`, never a stack in use). Signs in N synthetic students of the
// pattern `sim:student:load-<run>-<i>@demo.ductus.test`, enrols each in the
// demo seminar, acknowledges its notice, opens the work and writes the chain
// of saves k6 then sends (lanac.ts). Fresh accounts every run keep runs
// comparable. The output holds session cookies of the fake login: it goes to
// .local/ (git-ignored) and is never printed.
//
//   node scripts/load/priprema.ts --korisnika=50 --spremanja=6 --pokret=r1

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { noticeFingerprint } from "../../server/domain/notice/index.ts";
import { assertLocal, DIRECT_ORIGIN, ISSUER, LOCAL_DIR, signInSession } from "../lokalno/index.ts";

import { buildCommitChain, type CommitBody, type OpenedWork } from "./lanac.ts";

const COURSE_CODE = "UPIS2026DEMO";
const ASSIGNMENT_TITLE = "Seminarski rad: kućno kompostiranje";
// The login limit is 30 a minute per client IP (network.rate_limit_login_per_ip),
// one sign-in spends two of them (auth/login and auth/callback) and every
// prepared student signs in from 127.0.0.1, so sign-ins are paced.
const LOGIN_GAP_MS = 4_100;
// A session idle for two hours is refused (app.current_actor, migration
// 20261101200000_session_idle). The first student signs in at the start of the
// preparation and stays idle until the run, so preparation has to finish well
// within that: 1000 sign-ins take about 68 minutes.
const MAX_USERS = 1_000;
const MAX_SIZE = 2_000;
const TEXT = "Kućno kompostiranje smanjuje količinu otpada u izmišljenoj četvrti.";

export type PreparedStudent = {
  cookie: string;
  assignmentId: string;
  documentId: string;
  commits: CommitBody[];
};

type Flags = { users: number; saves: number; run: string; size: number; out: string };

export function parseLoadFlags(argv: readonly string[]): Flags {
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const users = Number(value("korisnika") ?? "10");
  const saves = Number(value("spremanja") ?? "5");
  const run = value("pokret") ?? "";
  // Characters of every save after the first: larger documents for SRV-OPT-1000.
  const size = Number(value("velicina") ?? "0");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE)
    throw new Error(`--velicina must be 0 to ${MAX_SIZE}`);
  if (!Number.isSafeInteger(users) || users < 1 || users > MAX_USERS)
    throw new Error(`--korisnika must be 1 to ${MAX_USERS}`);
  if (!Number.isSafeInteger(saves) || saves < 1 || saves > 200)
    throw new Error("--spremanja must be 1 to 200");
  if (!/^[a-z0-9]{1,12}$/u.test(run)) throw new Error("--pokret must be 1 to 12 of a-z, 0-9");
  return { users, saves, run, size, out: join(LOCAL_DIR, "load", `${run}.json`) };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepareStudent(
  account: string,
  saves: number,
  run: string,
  size: number,
): Promise<PreparedStudent> {
  const { api, session } = await signInSession(DIRECT_ORIGIN, ISSUER, account);
  const call = async <T>(path: string, body?: object): Promise<T> => {
    const response = await api(path, body);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  };
  await call("student/enrollments", { code: COURSE_CODE });
  type Courses = { courses: { assignments: { id: string; title: string }[] }[] };
  const assignment = (await call<Courses>("student/assignments")).courses
    .flatMap((course) => course.assignments)
    .find((entry) => entry.title === ASSIGNMENT_TITLE);
  if (assignment === undefined) throw new Error(`missing assignment ${ASSIGNMENT_TITLE}`);
  const id = encodeURIComponent(assignment.id);
  const notice = await call<Parameters<typeof noticeFingerprint>[0] & { versionNo: number }>(
    `student/assignments/${id}/notice`,
  );
  await call(`student/assignments/${id}/notice-read`, { versionNo: notice.versionNo });
  await call(`institution/assignments/${id}/acknowledgment`, {
    versionNo: notice.versionNo,
    fingerprint: await noticeFingerprint(notice),
  });
  const work = await call<OpenedWork & { status: string; currentRevision: number }>(
    "evidence/open",
    { assignmentId: assignment.id, start: true },
  );
  if (work.status !== "opened" || work.currentRevision !== 0)
    throw new Error("the work of a fresh student is not at revision zero");
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const texts = Array.from({ length: saves }, (_, i) =>
    i === 0 ? TEXT : size === 0 ? ` Dopuna ${i}.` : ` Dopuna ${i}. `.padEnd(size, "x"),
  );
  return {
    cookie: session,
    assignmentId: assignment.id,
    documentId: work.documentId,
    commits: buildCommitChain(work, texts, minute, run),
  };
}

async function main(): Promise<void> {
  assertLocal(process.env);
  const flags = parseLoadFlags(process.argv.slice(2));
  const students: PreparedStudent[] = [];
  for (let i = 0; i < flags.users; i++) {
    if (i > 0) await pause(LOGIN_GAP_MS);
    students.push(
      await prepareStudent(
        `sim:student:load-${flags.run}-${i}@demo.ductus.test`,
        flags.saves,
        flags.run,
        flags.size,
      ),
    );
    if ((i + 1) % 10 === 0) console.log(`pripremljeno ${i + 1}/${flags.users}`);
  }
  mkdirSync(dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, JSON.stringify(students));
  console.log(`Pripremljeno ${students.length} studenata, ${flags.saves} spremanja: ${flags.out}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(`priprema: ${error instanceof Error ? error.message : "nepoznata pogreška"}`);
      process.exit(1);
    });
}
