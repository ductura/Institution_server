// SRV-V16-TEMA-PRIJEDLOG: the topic of a thesis, proposed by the student and
// decided by the mentor, only through the app.* RPCs of
// 20261220110000_thesis_topic.sql. The RPCs decide who may read, propose and
// decide and raise ZD401, ZD403, ZD404, ZD409 or ZD422; this file only maps
// rows to the contract shape.
import type { ActorTransaction as Tx, WithActor } from "../index.ts";

type TopicRow = {
  state: string;
  version: number | null;
  title: string | null;
  summary: string | null;
  proposedAt: Date | null;
  decision: string | null;
  decisionComment: string | null;
  decidedAt: Date | null;
};
type VersionRow = { version: number; title: string; summary: string; proposedAt: Date };

const TOPIC = `state, version, title, summary, proposed_at AS "proposedAt", decision,
  decision_comment AS "decisionComment", decided_at AS "decidedAt"`;
const VERSION = `version, title, summary, proposed_at AS "proposedAt"`;

const versionOf = (row: VersionRow) => ({ ...row, proposedAt: row.proposedAt.toISOString() });

/** The topic in force and every version in order, in one transaction. */
async function topicOf(tx: Tx, documentId: string) {
  const { rows } = await tx.query<TopicRow>(`SELECT ${TOPIC} FROM app.read_work_thesis_topic($1)`, [
    documentId,
  ]);
  const [now] = rows;
  if (rows.length !== 1 || now === undefined) throw new Error("Expected one thesis topic row");
  const history = await tx.query<VersionRow>(
    `SELECT ${VERSION} FROM app.read_work_thesis_topic_history($1)`,
    [documentId],
  );
  const current =
    now.version === null || now.title === null || now.summary === null || now.proposedAt === null
      ? null
      : versionOf({
          version: now.version,
          title: now.title,
          summary: now.summary,
          proposedAt: now.proposedAt,
        });
  const decision =
    now.decision === null || now.version === null || now.decidedAt === null
      ? null
      : {
          version: now.version,
          decision: now.decision,
          comment: now.decisionComment,
          decidedAt: now.decidedAt.toISOString(),
          decidedByPart: "mentor" as const,
        };
  return { state: now.state, current, decision, history: history.rows.map(versionOf) };
}

export function createThesisTopicStore(withActor: WithActor) {
  return {
    topic: (token: string, documentId: string) => withActor(token, (tx) => topicOf(tx, documentId)),
    propose: (token: string, documentId: string, title: string, summary: string | null) =>
      withActor(token, async (tx) => {
        await tx.query("SELECT 1 FROM app.set_work_thesis_topic($1, $2, $3)", [
          documentId,
          title,
          summary,
        ]);
        return topicOf(tx, documentId);
      }),
    decide: (
      token: string,
      documentId: string,
      version: number,
      decision: string,
      comment: string | null,
    ) =>
      withActor(token, async (tx) => {
        await tx.query("SELECT 1 FROM app.decide_work_thesis_topic($1, $2, $3, $4)", [
          documentId,
          version,
          decision,
          comment,
        ]);
        return topicOf(tx, documentId);
      }),
  };
}

export type ThesisTopicStore = ReturnType<typeof createThesisTopicStore>;
