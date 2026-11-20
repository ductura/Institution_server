import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  canonicalizeJcs,
  digestSubmissionReceiptPayloadV2,
  type EvidenceEventV2,
  isSignedSubmissionReceiptV2,
  type JcsJsonValue,
  REVISION_ZERO_NODE_ID,
  REVISION_ZERO_SHA256,
} from "../../server/domain/index.ts";
import { createEditStepsV1Replayer } from "../../server/external/storage/index.ts";
import { SESSION_COOKIE_NAME } from "../../server/session/index.ts";

import { assertLocal, ISSUER, stackOptions } from "./config.ts";
import { parseFlags } from "./lokalno.ts";

const TIMEOUT_MS = 15_000;
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

export async function signIn(origin: string, issuer: string, account: string) {
  const go = browser(origin, issuer);
  const login = new URL("/api/v1/auth/login?returnTo=/app/web/", origin);
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
    .some((line) => line.startsWith(`${SESSION_COOKIE_NAME}=`));
  await redirect(answer, origin, "/app/web/");
  if (!session) throw new Error("Lažni OIDC nije otvorio sesiju.");
  return (path: string, body?: object) =>
    go(new URL(`/api/v1/${path}`, origin), {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "ductus-protocol": "1",
      },
    });
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

// The notice route sends exactly the fingerprint fields and these four identifiers/markers.
function noticeFingerprint({ assignmentId, versionNo, acknowledgedAt, readAt, ...notice }: Notice) {
  const aiPurposes = notice.aiPolicy === "prohibited" ? [] : [...new Set(notice.aiPurposes)].sort();
  return hash(`ductus-notice-fingerprint-v1\n${canonicalizeJcs({ ...notice, aiPurposes })}`);
}

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
      fingerprint: noticeFingerprint(notice),
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

async function main() {
  assertLocal(process.env);
  const { direct } = parseFlags(process.argv.slice(2));
  for (const scenario of SCENARIOS) {
    const api = await signIn(
      stackOptions(direct).origin,
      ISSUER,
      `sim:student:${scenario.account}@demo.ductus.test`,
    );
    try {
      await seedSubmission(api, scenario);
      console.log(
        `${scenario.account}: ${scenario.afterDeadline ? "predano nakon roka" : "predano"}.`,
      );
    } finally {
      const logout = await api("auth/logout", {});
      await logout.body?.cancel();
    }
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
