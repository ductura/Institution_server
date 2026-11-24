// SRV-MENTOR-2: the forms of the faculty for a thesis, the mentor's consent and
// the stage after the submission, only through the app.* RPCs of
// 20261216120000_thesis_forms_consent.sql. The RPCs decide who may read and
// write (the student owner, the mentor, the administrator of the faculty) and
// raise ZD401, ZD403, ZD404, ZD409 or ZD422; this file only maps rows to the
// contract shapes.
import type { ActorTransaction as Tx, WithActor } from "../index.ts";

const iso = (date: Date | null) => date?.toISOString() ?? null;

const FORM = `code, version, title, work_types AS "workTypes", active, published_at AS "publishedAt"`;
type FormRow = {
  code: string;
  version: number;
  title: string;
  workTypes: string[];
  active: boolean;
  publishedAt: Date;
};
const formOf = (row: FormRow) => ({ ...row, publishedAt: row.publishedAt.toISOString() });

const SETTING = `mentor_consent_required AS "mentorConsentRequired", changed_at AS "changedAt"`;
type SettingRow = { mentorConsentRequired: boolean; changedAt: Date | null };
const settingOf = (row: SettingRow) => ({ ...row, changedAt: iso(row.changedAt) });

const WORK_FORM = `code, version, title, state, state_form_version AS "stateFormVersion",
  changed_at AS "changedAt", changed_by AS "changedBy", changed_by_part AS "changedByPart"`;
type WorkFormRow = {
  code: string;
  version: number;
  title: string;
  state: string;
  stateFormVersion: number | null;
  changedAt: Date | null;
  changedBy: string | null;
  changedByPart: string | null;
};
const workFormOf = (row: WorkFormRow) => ({ ...row, changedAt: iso(row.changedAt) });

const CONSENT = `state, changed_by AS "changedBy", changed_at AS "changedAt", comment,
  required_for_submission AS "requiredForSubmission"`;
type ConsentRow = {
  state: string;
  changedBy: string | null;
  changedAt: Date | null;
  comment: string | null;
  requiredForSubmission: boolean;
};
const CONSENT_EVENT = `given, changed_by AS "changedBy", changed_at AS "changedAt", comment`;
type ConsentEventRow = {
  given: boolean;
  changedBy: string;
  changedAt: Date;
  comment: string | null;
};

const STAGE = `stage, defense_at AS "defenseAt", changed_by AS "changedBy", changed_at AS "changedAt",
  changed_by_part AS "changedByPart"`;
type StageRow = {
  stage: string;
  defenseAt: Date | null;
  changedBy: string | null;
  changedAt: Date | null;
  changedByPart: string | null;
};
const stageOf = (row: StageRow) => ({
  ...row,
  defenseAt: iso(row.defenseAt),
  changedAt: iso(row.changedAt),
});

async function one<R extends object>(tx: Tx, sql: string, values: unknown[]): Promise<R> {
  const { rows } = await tx.query<R>(sql, values);
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) throw new Error("Expected one thesis row");
  return row;
}

/** The consent in force and every change in order, in one transaction. */
async function consentOf(tx: Tx, documentId: string) {
  const now = await one<ConsentRow>(tx, `SELECT ${CONSENT} FROM app.read_work_mentor_consent($1)`, [
    documentId,
  ]);
  const { rows } = await tx.query<ConsentEventRow>(
    `SELECT ${CONSENT_EVENT} FROM app.read_work_mentor_consent_events($1)`,
    [documentId],
  );
  return {
    ...now,
    changedAt: iso(now.changedAt),
    history: rows.map((row) => ({ ...row, changedAt: row.changedAt.toISOString() })),
  };
}

export type ThesisFormInputValue = {
  code: string;
  title: string;
  workTypes: readonly string[];
  active: boolean;
};

export function createThesisStore(withActor: WithActor) {
  return {
    forms: (token: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<FormRow>(`SELECT ${FORM} FROM app.read_thesis_forms()`);
        return { forms: rows.map(formOf) };
      }),
    publishForm: (token: string, input: ThesisFormInputValue) =>
      withActor(token, async (tx) =>
        formOf(
          await one<FormRow>(
            tx,
            `SELECT ${FORM} FROM app.publish_thesis_form($1, $2, $3::text[], $4)`,
            [input.code, input.title, [...input.workTypes], input.active],
          ),
        ),
      ),
    setting: (token: string) =>
      withActor(token, async (tx) =>
        settingOf(
          await one<SettingRow>(tx, `SELECT ${SETTING} FROM app.read_thesis_setting()`, []),
        ),
      ),
    setSetting: (token: string, mentorConsentRequired: boolean) =>
      withActor(token, async (tx) =>
        settingOf(
          await one<SettingRow>(tx, `SELECT ${SETTING} FROM app.set_thesis_setting($1)`, [
            mentorConsentRequired,
          ]),
        ),
      ),
    workForms: (token: string, documentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<WorkFormRow>(
          `SELECT ${WORK_FORM} FROM app.read_work_thesis_forms($1)`,
          [documentId],
        );
        return { forms: rows.map(workFormOf) };
      }),
    setWorkForm: (token: string, documentId: string, code: string, state: string) =>
      withActor(token, async (tx) =>
        workFormOf(
          await one<WorkFormRow>(
            tx,
            `SELECT ${WORK_FORM} FROM app.set_work_thesis_form_state($1, $2, $3)`,
            [documentId, code, state],
          ),
        ),
      ),
    consent: (token: string, documentId: string) =>
      withActor(token, (tx) => consentOf(tx, documentId)),
    setConsent: (token: string, documentId: string, given: boolean, comment: string | null) =>
      withActor(token, async (tx) => {
        await tx.query("SELECT 1 FROM app.set_work_mentor_consent($1, $2, $3)", [
          documentId,
          given,
          comment,
        ]);
        return consentOf(tx, documentId);
      }),
    stage: (token: string, documentId: string) =>
      withActor(token, async (tx) =>
        stageOf(
          await one<StageRow>(tx, `SELECT ${STAGE} FROM app.read_work_thesis_stage($1)`, [
            documentId,
          ]),
        ),
      ),
    setStage: (token: string, documentId: string, stage: string, defenseAt: string | null) =>
      withActor(token, async (tx) =>
        stageOf(
          await one<StageRow>(
            tx,
            `SELECT ${STAGE} FROM app.set_work_thesis_stage($1, $2, $3::timestamptz)`,
            [documentId, stage, defenseAt],
          ),
        ),
      ),
  };
}

export type ThesisStore = ReturnType<typeof createThesisStore>;
