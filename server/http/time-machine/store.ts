import {
  type ActorTransaction,
  type WithActor,
  type WorkVersionsReader,
  workVersionsPageOf,
} from "../../database/index.ts";

type Viewer = "owner" | "mentor";
type Failure = { status: "not_found" | "unauthenticated" };
type Snapshot = { body: string; hash: string };
type SnapshotResult =
  { status: "found"; snapshots: Snapshot[] } | Failure | { status: "unavailable" };

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

// SRV-1503 keeps a sparse cache. For other exact revisions (including older
// works), use the same committed hash against the original checkpoint store.
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

// The RPC rechecks the relation and logs the read. Accept only the immutable
// submitted state even if the live-state RPC yields a different outcome.
const MENTOR_SNAPSHOT_SQL = `SELECT outcome, body, content_hash AS hash
  FROM collaboration.read_live_state($1, NULL)`;

const NOT_FOUND = { status: "not_found" } as const;
const UNAUTHENTICATED = { status: "unauthenticated" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;

function accessFailure(error: unknown): Failure | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ZD401") return UNAUTHENTICATED;
  if (code === "ZD403") return NOT_FOUND;
}

async function viewerOf(tx: ActorTransaction, documentId: string): Promise<Viewer | Failure> {
  const { rows } = await tx.query<{ viewer: unknown }>(VIEWER_SQL, [documentId]);
  if (rows.length === 0) return UNAUTHENTICATED;
  const viewer = rows[0]?.viewer;
  return rows.length === 1 && (viewer === "owner" || viewer === "mentor") ? viewer : NOT_FOUND;
}

async function page(tx: ActorTransaction, documentId: string, before: number | null) {
  return workVersionsPageOf((await tx.query(VERSIONS_SQL, [documentId, before])).rows, before);
}

export function createTimeMachineStore(withActor: WithActor) {
  const list: WorkVersionsReader = async (token, documentId, before) => {
    try {
      return await withActor(token, async (tx) => {
        const viewer = await viewerOf(tx, documentId);
        if (typeof viewer !== "string") return viewer;
        const result = await page(tx, documentId, before);
        if (result.status !== "found" || viewer === "owner") return result;
        return {
          status: "found",
          versions: result.versions.filter((item) => item.kind === "submission"),
          nextBeforeRevision: null,
        };
      });
    } catch (error) {
      const failure = accessFailure(error);
      if (failure !== undefined) return failure;
      throw error;
    }
  };

  async function read(
    token: string,
    documentId: string,
    revisions: number[],
  ): Promise<SnapshotResult> {
    try {
      return await withActor(token, async (tx) => {
        const viewer = await viewerOf(tx, documentId);
        if (typeof viewer !== "string") return viewer;
        const snapshots: Snapshot[] = [];
        for (const revision of revisions) {
          const before = revision === Number.MAX_SAFE_INTEGER ? null : revision + 1;
          const versions = await page(tx, documentId, before);
          if (versions.status === "not_found") return NOT_FOUND;
          if (versions.status !== "found") return UNAVAILABLE;
          if (
            !versions.versions.some(
              (item) =>
                item.revision === revision && (viewer === "owner" || item.kind === "submission"),
            )
          )
            return NOT_FOUND;
          const { rows } =
            viewer === "owner"
              ? await tx.query(OWNER_SNAPSHOT_SQL, [documentId, revision])
              : await tx.query(MENTOR_SNAPSHOT_SQL, [documentId]);
          const row = rows[0];
          if (
            rows.length !== 1 ||
            typeof row?.body !== "string" ||
            typeof row.hash !== "string" ||
            (viewer === "mentor" && row.outcome !== "submitted")
          )
            return UNAVAILABLE;
          snapshots.push({ body: row.body, hash: row.hash });
        }
        return { status: "found", snapshots };
      });
    } catch (error) {
      const failure = accessFailure(error);
      if (failure !== undefined) return failure;
      throw error;
    }
  }

  return { list, read };
}
