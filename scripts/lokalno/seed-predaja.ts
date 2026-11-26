import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type ActorTransaction,
  actorReader,
  closePools,
  withActor,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  digestSubmissionReceiptPayloadV2,
  type EvidenceEventV2,
  isSignedSubmissionReceiptV2,
  type JcsJsonValue,
  REVISION_ZERO_NODE_ID,
  REVISION_ZERO_SHA256,
} from "../../server/domain/index.ts";
import { noticeFingerprint } from "../../server/domain/notice/index.ts";
import { createEditStepsV1Replayer } from "../../server/external/storage/index.ts";
import { SESSION_COOKIE_NAME, sessionTokenFromCookie } from "../../server/session/index.ts";

import { adminTarget, assertLocal, DATABASE, ISSUER, loginUrl, stackOptions } from "./config.ts";
import { databaseUrl, LOCAL_DIR, parseFlags } from "./lokalno.ts";

const TIMEOUT_MS = 15_000;
const DEMO_INSTITUTION = "demo-fakultet";
const MENTORSHIP_STUDENT = "sim:student:demo-student-5@demo.ductus.test";
const MENTORSHIP_TEACHER = "demo-teacher";
const MENTORSHIP_WORK_TYPE = "bachelor_thesis";
const SCENARIOS = [
  {
    account: "demo-student-3",
    code: "UPIS2026DEMO",
    course: "Izmišljeni seminar iz ekologije grada",
    title: "Seminarski rad: kućno kompostiranje",
    // Paragraph from ductura/.github: prototipovi/editor/samples/primjer-izmisljeni.json.
    text: "Cilj je ovog rada opisati kako se program provodio u tri gradske četvrti i koji su čimbenici povezani s time koliko kućanstava i nakon dvije godine redovito koristi komposter. Rad polazi od pitanja zašto ista ponuda daje različite ishode u četvrtima slične veličine i sastava.",
    afterDeadline: false,
  },
  {
    account: "demo-student-4",
    code: "HIDRO2026DEMO",
    course: "Izmišljeni seminar iz urbane hidrologije",
    title: "Kratki osvrt: gradski vrtovi",
    text: "U izmišljenom Lipovcu gradski vrt upija kišnicu. Vrtlari skupljaju ostatak u spremnik za zalijevanje.",
    afterDeadline: true,
  },
] as const;

type Scenario = {
  code: string;
  course: string;
  title: string;
  text: string;
  afterDeadline: boolean;
};
type Course = { name: string; assignments: { id: string; title: string }[] };
type Notice = {
  assignmentId: string;
  versionNo: number;
  acknowledgedAt: string | null;
  readAt: string | null;
  templateVersion: number;
  title: string;
  instructions: string;
  workType: string;
  opensAt: string;
  dueAt: string;
  aiPolicy: string;
  aiPurposes: string[];
  evidenceProfile: string;
  wordMin: number | null;
  wordMax: number | null;
};
type Work = {
  status: string;
  documentId: string;
  document: string;
  documentHash: string;
  evidenceProfileId: string;
  currentRevision: number;
};

/** One cookie jar per student. Every hop stays on the expected local origin. */
function browser(origin: string, issuer: string) {
  const jars = new Map([origin, issuer].map((host) => [host, new Map<string, string>()]));
  return async (url: URL, init: RequestInit = {}) => {
    const jar = jars.get(url.origin);
    if (jar === undefined || url.username !== "" || url.password !== "")
      throw new Error("Neočekivano odredište lokalne prijave.");
    const headers = new Headers(init.headers);
    headers.set("cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0] ?? "";
      const at = pair.indexOf("=");
      if (at < 1) continue;
      const name = pair.slice(0, at);
      if (/;\s*Max-Age=0(?:;|$)/iu.test(cookie)) jar.delete(name);
      else jar.set(name, pair.slice(at + 1));
    }
    return response;
  };
}

async function redirect(response: Response, expectedOrigin: string, path?: string): Promise<URL> {
  await response.body?.cancel();
  const location = response.headers.get("location");
  if (![302, 303].includes(response.status) || location === null)
    throw new Error(`Lokalna prijava: HTTP ${response.status}.`);
  const url = new URL(location, response.url);
  if (url.origin !== expectedOrigin || (path !== undefined && url.pathname !== path))
    throw new Error("Neočekivano odredište lokalne prijave.");
  return url;
}

export async function signInSession(origin: string, issuer: string, account: string) {
  const go = browser(origin, issuer);
  const login = new URL("/api/v1/auth/login?returnTo=/aplikacija/", origin);
  const authorize = await redirect(await go(login), issuer);
  const interaction = await redirect(await go(authorize), issuer);
  const page = await go(interaction);
  await page.body?.cancel();
  if (page.status !== 200) throw new Error(`Lažni OIDC: HTTP ${page.status}.`);
  const submitted = await go(new URL(`${interaction.pathname}/login`, issuer), {
    method: "POST",
    body: new URLSearchParams({ account }),
  });
  const resume = await redirect(submitted, issuer);
  const callback = await redirect(await go(resume), origin, "/api/v1/auth/callback");
  const answer = await go(callback);
  const session = answer.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "")
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`))
    .join("; ");
  await redirect(answer, origin, "/aplikacija/");
  if (!session) throw new Error("Lažni OIDC nije otvorio sesiju.");
  const api = (path: string, body?: object) =>
    go(new URL(`/api/v1/${path}`, origin), {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "ductus-protocol": "1",
      },
    });
  return { api, session };
}

export async function signIn(origin: string, issuer: string, account: string) {
  return (await signInSession(origin, issuer, account)).api;
}

type Api = Awaited<ReturnType<typeof signIn>>;

async function json<T>(api: Api, path: string, body?: object): Promise<T> {
  const response = await api(path, body);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`/api/v1/${path}: HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

export function initialCommit(work: Work, text: string, now: string) {
  const initial = Buffer.from(work.document, "base64").toString("utf8");
  if (hash(initial) !== REVISION_ZERO_SHA256 || work.documentHash !== REVISION_ZERO_SHA256)
    throw new Error("Neočekivan sadržaj početne revizije.");
  const replayer = createEditStepsV1Replayer();
  const event: EvidenceEventV2 = {
    sequence: 1,
    source: "editor",
    steps: [{ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text }] } }],
    touchedNodeIds: [REVISION_ZERO_NODE_ID],
    beforeDocumentHash: work.documentHash,
    afterDocumentHash: "",
  };
  const document = replayer.apply(replayer.load(JSON.parse(initial) as JcsJsonValue), event);
  const snapshot = canonicalizeJcs(replayer.toCanonical(document));
  event.afterDocumentHash = hash(snapshot);
  const transaction = `seed-predaja-${work.documentId}`;
  const segment = canonicalizeJcs({
    evidenceSchema: "ductus-evidence-segment-v2",
    canonicalization: "RFC8785-JCS",
    hashAlgorithm: "sha256",
    documentId: work.documentId,
    evidenceProfileId: work.evidenceProfileId,
    sessionId: transaction,
    segmentId: transaction,
    sequenceFrom: 1,
    sequenceTo: 1,
    observedStartedAt: now,
    observedEndedAt: now,
    initialDocumentHash: work.documentHash,
    finalDocumentHash: event.afterDocumentHash,
    predecessorSegmentHash: null,
    captureContext: { editorModel: "prosemirror", transactionFormat: "ductus-edit-steps-v1" },
    events: [event],
  });
  return {
    documentId: work.documentId,
    clientTransactionId: transaction,
    baseRevision: 0,
    segments: [base64(segment)],
    document: base64(snapshot),
  };
}

export async function seedSubmission(api: Api, scenario: Scenario) {
  const courses = async () =>
    (await json<{ courses: Course[] }>(api, "student/assignments")).courses;
  if (!(await courses()).some((course) => course.name === scenario.course))
    await json(api, "student/enrollments", { code: scenario.code });
  const course = (await courses()).find((entry) => entry.name === scenario.course);
  const assignment = course?.assignments.find((entry) => entry.title === scenario.title);
  if (assignment === undefined) throw new Error(`Nedostaje zadatak „${scenario.title}”.`);
  const assignmentId = encodeURIComponent(assignment.id);
  const notice = await json<Notice>(api, `student/assignments/${assignmentId}/notice`);
  if (notice.acknowledgedAt === null) {
    const { versionNo } = notice;
    await json(api, `student/assignments/${assignmentId}/notice-read`, { versionNo });
    await json(api, `institution/assignments/${assignmentId}/acknowledgment`, {
      versionNo,
      // The server's own field list: the notice route also sends fields that are not
      // members of the fingerprint (purposeCatalogVersion).
      fingerprint: await noticeFingerprint(notice),
    });
  }
  const work = await json<Work>(api, "evidence/open", { assignmentId: assignment.id, start: true });
  if (work.status !== "opened" || ![0, 1].includes(work.currentRevision))
    throw new Error("Rad odstupa od očekivane demo revizije.");
  const revision =
    work.currentRevision === 0
      ? (
          await json<{ revision: number }>(
            api,
            "evidence/commit",
            initialCommit(
              work,
              scenario.text,
              new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(),
            ),
          )
        ).revision
      : work.currentRevision;
  if (revision !== 1) throw new Error("Spremanje nije vratilo očekivanu demo reviziju.");
  const submit = () =>
    json<{ status: string; receipt: unknown }>(api, "submission", {
      documentId: work.documentId,
      revision,
    });
  const { status, receipt } = await submit();
  if (
    status !== "submitted" ||
    !isSignedSubmissionReceiptV2(receipt) ||
    receipt.payload.assignmentId !== assignment.id ||
    receipt.payload.documentId !== work.documentId ||
    receipt.payload.revision !== revision ||
    receipt.payload.afterDeadline !== scenario.afterDeadline ||
    receipt.payloadDigestSha256 !== (await digestSubmissionReceiptPayloadV2(receipt.payload)).sha256
  )
    throw new Error("Poslužitelj nije vratio očekivanu potpisanu potvrdu.");
  const repeated = await submit();
  if (
    repeated.status !== "submitted" ||
    JSON.stringify(repeated.receipt) !== JSON.stringify(receipt)
  )
    throw new Error("Ponovna predaja iste revizije nije vratila istu potvrdu.");
  const state = await json<{ assignments: { assignmentId: string; workState: string }[] }>(
    api,
    "student/assignment-work",
  );
  if (
    !state.assignments.some(
      (item) => item.assignmentId === assignment.id && item.workState === "submitted",
    )
  )
    throw new Error("Stanje studentskog rada nije submitted.");
}

async function signOut(api: Api) {
  const logout = await api("auth/logout", {});
  await logout.body?.cancel();
}

function localAppDatabaseUrl() {
  const target = adminTarget(databaseUrl(process.env, LOCAL_DIR));
  let secrets: { appPassword?: unknown } | null;
  try {
    secrets = JSON.parse(
      readFileSync(join(LOCAL_DIR, "lokalno-tajne.json"), "utf8"),
    ) as typeof secrets;
  } catch {
    throw new Error("Lokalne tajne nisu čitljive. Najprije pokreni pnpm lokalno.");
  }
  const password = secrets?.appPassword;
  if (typeof password !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(password))
    throw new Error("Nedostaje valjana lokalna lozinka aplikacijske uloge.");
  return loginUrl(target, "ductus_app_local", password, DATABASE);
}

async function demoMentorshipRequest(studentToken: string, teacherId: string) {
  const find = async (tx: ActorTransaction) =>
    (
      await tx.query<{ id: string; pending: boolean }>(
        `SELECT id, (withdrawn_at IS NULL AND approved_at IS NULL AND declined_at IS NULL) AS pending
           FROM institution.mentorship_request
          WHERE institution_id = app.current_institution_id()
            AND student_id = app.current_user_id()
            AND teacher_id = $1 AND work_type = $2
          ORDER BY pending DESC, id
          LIMIT 1`,
        [teacherId, MENTORSHIP_WORK_TYPE],
      )
    ).rows[0];

  try {
    return await withActor(studentToken, async (tx) => {
      // Preserve a completed request on reruns, including a teacher's decision.
      const existing = await find(tx);
      if (existing !== undefined) return existing;

      // The RPC takes its student from the session and has no title argument.
      const created = await tx.query<{ id: string }>(
        "SELECT institution.request_mentorship($1, $2) AS id",
        [teacherId, MENTORSHIP_WORK_TYPE],
      );
      const id = created.rows[0]?.id;
      if (typeof id !== "string") throw new Error("Baza nije vratila identifikator zahtjeva.");
      return { id, pending: true };
    });
  } catch (error) {
    // Another run may have made the same request after the read. The RPC
    // serializes creation, so only accept a conflict if that exact request exists.
    if (error instanceof Error && "code" in error && error.code === "ZD409") {
      const existing = await withActor(studentToken, find);
      if (existing !== undefined) return existing;
    }
    throw error;
  }
}

async function seedMentorshipRequest(origin: string) {
  process.env.APP_DATABASE_URL = localAppDatabaseUrl();
  const teacher = await signInSession(origin, ISSUER, MENTORSHIP_TEACHER);
  try {
    const teacherToken = sessionTokenFromCookie(teacher.session);
    if (teacherToken === undefined) throw new Error("Nedostaje lokalna sesija nastavnika.");
    const teacherActor = await actorReader.currentActorWithInstitution(teacherToken);
    const teacherId = teacherActor.userId;
    if (teacherId === null || teacherActor.institutionSlug !== DEMO_INSTITUTION)
      throw new Error("Nastavnik nije u lokalnoj demo ustanovi.");

    const student = await signInSession(origin, ISSUER, MENTORSHIP_STUDENT);
    try {
      const studentToken = sessionTokenFromCookie(student.session);
      if (studentToken === undefined) throw new Error("Nedostaje lokalna sesija studenta.");
      const studentActor = await actorReader.currentActorWithInstitution(studentToken);
      const studentId = studentActor.userId;
      if (studentId === null || studentActor.institutionSlug !== DEMO_INSTITUTION)
        throw new Error("Student nije u lokalnoj demo ustanovi.");

      const request = await demoMentorshipRequest(studentToken, teacherId);
      if (request.pending) {
        // Pending requests have their own HTTP route in SRV-31. Until then,
        // check visibility through the same application role and teacher session.
        const visible = await withActor(teacherToken, (tx) =>
          tx.query(
            "SELECT id FROM institution.mentorship_request WHERE id = $1 AND student_id = $2",
            [request.id, studentId],
          ),
        );
        if (visible.rowCount !== 1)
          throw new Error("Nastavnik ne vidi novi zahtjev za mentorstvo.");
      }
    } finally {
      await signOut(student.api);
    }
  } finally {
    await signOut(teacher.api);
  }
}

async function main() {
  assertLocal(process.env);
  const { direct } = parseFlags(process.argv.slice(2));
  const { origin } = stackOptions(direct);
  for (const scenario of SCENARIOS) {
    const api = await signIn(origin, ISSUER, `sim:student:${scenario.account}@demo.ductus.test`);
    try {
      await seedSubmission(api, scenario);
      console.log(
        `${scenario.account}: ${scenario.afterDeadline ? "predano nakon roka" : "predano"}.`,
      );
    } finally {
      await signOut(api);
    }
  }
  try {
    await seedMentorshipRequest(origin);
    console.log("demo-student-5: zahtjev za mentorstvo pripremljen.");
  } finally {
    await closePools();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(
      `pnpm lokalno:predaje: ${error instanceof Error ? error.message : "nepoznata pogreška"}`,
    );
    process.exitCode = 1;
  });
}
