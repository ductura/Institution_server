import {
  type ActorTransaction,
  createReplaySource,
  type WithActor,
  type WorkVersionsReader,
  workVersionsPageOf,
} from "../../database/index.ts";
import { verifyCanonicalEvidencePayloadV2 } from "../../evidence/index.ts";
import type { InstitutionEvidencePayloadReader } from "../../external/storage/index.ts";

type Snapshot = { body: string; hash: string };
type Snapshots =
  | { status: "found"; snapshots: Snapshot[] }
  | { status: "not_found" | "unauthenticated" | "unavailable" };

const VIEWER_SQL = `SELECT CASE
  WHEN EXISTS (SELECT 1 FROM evidence.document d
                WHERE d.id = $1 AND d.principal_id = actor.user_id
                  AND d.institution_id = actor.institution_id) THEN 'owner'
  WHEN EXISTS (
    SELECT 1 FROM institution.mentorship m
    JOIN institution.assignment a ON a.mentorship_id = m.id AND a.institution_id = m.institution_id
    CROSS JOIN LATERAL app.assignment_works(a.id) w
    WHERE m.mentor_id = actor.user_id AND m.institution_id = actor.institution_id
      AND institution.actor_mentorship_role(m.id) = 'teacher'
      AND w.student_id = m.student_id AND w.document_id = $1
  ) THEN 'mentor'
  END AS viewer
  FROM app.current_actor() actor WHERE actor.user_id IS NOT NULL`;

const VERSIONS_SQL = `SELECT outcome, kind, revision::text AS revision,
    saved_minute AS "savedMinute", after_deadline AS "afterDeadline"
  FROM app.read_work_versions($1, $2::bigint) v
  ORDER BY v.revision DESC, v.kind DESC`;

// A completed response explicitly sends a revision for review. A request to
// change the text, a declined response and an autosave do not send a version.
const REVIEWS_SQL = `SELECT 'found' AS outcome, 'checkpoint' AS kind,
    response_revision::text AS revision, min(response_window) AS "savedMinute",
    NULL AS "afterDeadline"
  FROM collaboration.list_revision_requests($1)
  WHERE response_kind = 'done' AND response_revision > 0
    AND ($2::bigint IS NULL OR response_revision < $2)
    AND ($3::bigint IS NULL OR response_revision <= $3)
  GROUP BY response_revision
  ORDER BY response_revision DESC LIMIT 201`;

// Reconstruction checkpoints are sparse. The original store is keyed by
// the committed hash and still supplies other available exact revisions.
const OWNER_SNAPSHOT_SQL = `SELECT COALESCE(c.body, legacy.body) AS body, r.content_hash AS hash
  FROM evidence.document_revision r
  LEFT JOIN LATERAL (
    SELECT checkpoint.body FROM app.read_own_reconstruction_checkpoint($1, $2::bigint) checkpoint
    WHERE checkpoint.revision = r.revision AND checkpoint.content_hash = r.content_hash
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT checkpoint.body FROM app.read_replay_checkpoints($1, ARRAY[r.content_hash]) checkpoint
    WHERE c.body IS NULL
  ) legacy ON true
  WHERE r.document_id = $1 AND r.revision = $2::bigint`;

const SUBMITTED_SQL = `SELECT body, content_hash AS hash
  FROM collaboration.read_live_state($1, NULL) WHERE outcome = 'submitted'`;
const REVIEW_EXISTS_SQL = `SELECT EXISTS (
  SELECT 1 FROM collaboration.list_revision_requests($1)
  WHERE response_kind = 'done' AND response_revision = $2::bigint
) AS sent`;

const NOT_FOUND = { status: "not_found" } as const;
const UNAUTHENTICATED = { status: "unauthenticated" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;

function accessFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ZD401") return UNAUTHENTICATED;
  if (code === "ZD403") return NOT_FOUND;
  throw error;
}

async function viewerOf(tx: ActorTransaction, documentId: string) {
  const { rows } = await tx.query<{ viewer: unknown }>(VIEWER_SQL, [documentId]);
  if (rows.length === 0) return UNAUTHENTICATED;
  const viewer = rows[0]?.viewer;
  return rows.length === 1 && (viewer === "owner" || viewer === "mentor") ? viewer : NOT_FOUND;
}

async function reviewSnapshot(
  tx: ActorTransaction,
  payloads: InstitutionEvidencePayloadReader,
  documentId: string,
  revision: number,
): Promise<Snapshot | null> {
  const replay = createReplaySource((_token, run) => run(tx), "");
  const source = await replay.readSource(documentId);
  if (source.status !== "found") return null;
  const segmentHash = source.segmentHashes[revision - 1];
  if (segmentHash === undefined) return null;
  const stored = await payloads.readImmutable({
    institutionId: source.institutionId,
    evidencePackageId: source.evidencePackageId,
    segmentHash,
  });
  if (stored.status !== "found") return null;
  const verified = await verifyCanonicalEvidencePayloadV2(stored.bytes);
  if (
    !verified.ok ||
    verified.sha256 !== segmentHash ||
    verified.segment.documentId !== documentId ||
    verified.segment.predecessorSegmentHash !== (source.segmentHashes[revision - 2] ?? null)
  ) {
    return null;
  }
  const hash = verified.segment.finalDocumentHash;
  const checkpoints = await replay.readCheckpoints(documentId, [hash]);
  const body = checkpoints.status === "found" ? checkpoints.texts.get(hash) : undefined;
  return body === undefined ? null : { body, hash };
}

export function createTimeMachineStore(
  withActor: WithActor,
  payloads: InstitutionEvidencePayloadReader,
) {
  const list: WorkVersionsReader = async (token, documentId, before) => {
    try {
      return await withActor(token, async (tx) => {
        const viewer = await viewerOf(tx, documentId);
        if (typeof viewer !== "string") return viewer;
        const values = [documentId, before];
        const base = (await tx.query(VERSIONS_SQL, values)).rows;
        const page = workVersionsPageOf(base, before);
        if (viewer === "owner" || page.status !== "found") return page;
        const submission = page.versions.find((item) => item.kind === "submission");
        const reviews = (await tx.query(REVIEWS_SQL, [...values, submission?.revision ?? null]))
          .rows;
        const rows = [...base.filter((row) => row.kind === "submission"), ...reviews]
          .sort((a, b) => Number(b.revision) - Number(a.revision))
          .slice(0, 201);
        const currentViewer = await viewerOf(tx, documentId);
        if (currentViewer !== "mentor") {
          return typeof currentViewer === "string" ? NOT_FOUND : currentViewer;
        }
        return rows.length === 0
          ? { status: "found", versions: [], nextBeforeRevision: null }
          : workVersionsPageOf(rows, before);
      });
    } catch (error) {
      return accessFailure(error);
    }
  };

  async function read(
    token: string,
    documentId: string,
    revisions: readonly number[],
  ): Promise<Snapshots> {
    try {
      return await withActor(token, async (tx) => {
        const viewer = await viewerOf(tx, documentId);
        if (typeof viewer !== "string") return viewer;
        const page = workVersionsPageOf(
          (await tx.query(VERSIONS_SQL, [documentId, null])).rows,
          null,
        );
        if (page.status !== "found") return page.status === "not_found" ? NOT_FOUND : UNAVAILABLE;
        const submission = page.versions.find((item) => item.kind === "submission")?.revision;
        const requested: { revision: number; submitted: boolean }[] = [];
        for (const revision of revisions) {
          if (submission !== undefined && revision > submission) return NOT_FOUND;
          const submitted = submission === revision;
          if (!submitted && (viewer === "mentor" || revisions.length > 1)) {
            const { rows } = await tx.query<{ sent: boolean }>(REVIEW_EXISTS_SQL, [
              documentId,
              revision,
            ]);
            if (rows[0]?.sent !== true) return NOT_FOUND;
          }
          requested.push({ revision, submitted });
        }

        const snapshots: Snapshot[] = [];
        for (const { revision, submitted } of requested) {
          if (viewer === "mentor" && !submitted) {
            const snapshot = await reviewSnapshot(tx, payloads, documentId, revision);
            if (snapshot === null) return UNAVAILABLE;
            snapshots.push(snapshot);
            continue;
          }
          const { rows } =
            viewer === "owner"
              ? await tx.query(OWNER_SNAPSHOT_SQL, [documentId, revision])
              : await tx.query(SUBMITTED_SQL, [documentId]);
          const row = rows[0];
          if (row === undefined) return submitted || revisions.length > 1 ? UNAVAILABLE : NOT_FOUND;
          if (viewer === "owner" && row.body === null && !submitted && revisions.length === 1) {
            return NOT_FOUND;
          }
          if (rows.length !== 1 || typeof row.body !== "string" || typeof row.hash !== "string") {
            return UNAVAILABLE;
          }
          snapshots.push({ body: row.body, hash: row.hash });
        }
        // The app RPCs recheck replay access. Recheck the narrower mentorship
        // as well before releasing any content, including after a storage read.
        const currentViewer = await viewerOf(tx, documentId);
        if (currentViewer !== viewer) {
          return typeof currentViewer === "string" ? NOT_FOUND : currentViewer;
        }
        return { status: "found", snapshots };
      });
    } catch (error) {
      return accessFailure(error);
    }
  }

  return { list, read };
}

export type TimeMachineStore = ReturnType<typeof createTimeMachineStore>;
