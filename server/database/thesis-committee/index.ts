// SRV-V16-POVJERENSTVO-ZAPIS: the committee of a thesis as a list, only through
// the app.* RPCs of 20261220120000_thesis_committee.sql. The RPCs decide who may
// read and who may write and raise ZD401, ZD403, ZD404 or ZD422; this file only
// maps rows to the contract shape. The list gives no right to read the work.
import type { ActorTransaction as Tx, WithActor } from "../index.ts";

type CommitteeRow = { members: unknown; changedAt: Date | null };
type MemberJson = {
  userId: string;
  name: { givenName: string; familyName: string } | null;
  role: string;
};

const COMMITTEE = `members, changed_at AS "changedAt"`;

async function committeeOf(tx: Tx, query: string, params: unknown[]) {
  const { rows } = await tx.query<CommitteeRow>(`SELECT ${COMMITTEE} FROM ${query}`, params);
  const [row] = rows;
  if (rows.length !== 1 || row === undefined || !Array.isArray(row.members)) {
    throw new Error("Expected one thesis committee row");
  }
  return {
    members: row.members as MemberJson[],
    changedAt: row.changedAt === null ? null : row.changedAt.toISOString(),
    changedByPart: row.changedAt === null ? null : ("faculty" as const),
  };
}

export function createThesisCommitteeStore(withActor: WithActor) {
  return {
    committee: (token: string, documentId: string) =>
      withActor(token, (tx) => committeeOf(tx, "app.read_work_thesis_committee($1)", [documentId])),
    replace: (
      token: string,
      documentId: string,
      members: readonly { userId: string; role: string }[],
    ) =>
      withActor(token, (tx) =>
        committeeOf(tx, "app.set_work_thesis_committee($1, $2::jsonb)", [
          documentId,
          JSON.stringify(members),
        ]),
      ),
  };
}

export type ThesisCommitteeStore = ReturnType<typeof createThesisCommitteeStore>;
