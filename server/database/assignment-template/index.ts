// The port of the work template of an assignment (SRV-V17-TEMPLATE-ASSIGN; migration
// 20261219250000): the teacher of the assignment's course switches the institution's template
// on (freezing its latest version for the assignment's work type) or off, and a student of the
// course reads the frozen version. Writes go through the RPC only; the caller comes only from
// the session.
//
// Refusals are outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23), ZD409 conflict (no template of the institution for the work type yet),
// ZD422 invalid_input. Anything else is thrown.
import type { WithActor } from "../index.ts";

import type { WorkTemplateSection, WorkTemplateTitleField } from "../work-template/index.ts";

export type AssignmentTemplateRefusal = {
  readonly status: "unauthorized" | "not_found" | "conflict" | "invalid_input";
};

export type AssignmentTemplateSetResult =
  { readonly status: "saved"; readonly version: number | null } | AssignmentTemplateRefusal;

export type FrozenAssignmentTemplate = {
  readonly version: number;
  readonly titlePage: WorkTemplateTitleField[];
  readonly sections: WorkTemplateSection[];
  readonly citationStyle: "fpzg";
};

export type AssignmentTemplateReadResult =
  | { readonly status: "found"; readonly template: FrozenAssignmentTemplate }
  | { readonly status: "no_template" }
  | AssignmentTemplateRefusal;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

const REFUSALS = new Map<unknown, AssignmentTemplateRefusal>([
  ["ZD401", { status: "unauthorized" }],
  ["ZD403", { status: "not_found" }],
  ["ZD409", { status: "conflict" }],
  ["ZD422", { status: "invalid_input" }],
]);

type FrozenRow = {
  version: number;
  titlePage: WorkTemplateTitleField[];
  sections: WorkTemplateSection[];
  citationStyle: "fpzg";
};

export function createAssignmentTemplate(withActor: WithActor) {
  return {
    /** Switches the template on (the pinned version) or off (null) for the assignment. */
    async set(
      token: string,
      assignmentId: string,
      useInstitutionTemplate: boolean,
    ): Promise<AssignmentTemplateSetResult> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx): Promise<AssignmentTemplateSetResult> => {
          const { rows } = await tx.query<{ version: unknown }>(
            "SELECT app.set_assignment_template($1::uuid, $2::boolean) AS version",
            [assignmentId, useInstitutionTemplate],
          );
          const version = rows[0]?.version;
          // Confirmed inside the transaction: an answer that is not what the switch implies
          // rolls the write back.
          if (
            rows.length !== 1 ||
            typeof version !== "number" ||
            !Number.isInteger(version) ||
            version < 0 ||
            (useInstitutionTemplate ? version < 1 : version !== 0)
          ) {
            throw new Error("unconfirmed assignment template");
          }
          return { status: "saved", version: version === 0 ? null : version };
        });
      } catch (error) {
        const refusal = REFUSALS.get(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** A student of the course reads the template frozen on the assignment. */
    async read(token: string, assignmentId: string): Promise<AssignmentTemplateReadResult> {
      if (!isId(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx): Promise<AssignmentTemplateReadResult> => {
          const { rows } = await tx.query<FrozenRow>(
            `SELECT version, title_page AS "titlePage", sections, citation_style AS "citationStyle"
               FROM app.read_assignment_template($1::uuid)`,
            [assignmentId],
          );
          const row = rows[0];
          if (rows.length === 0) return { status: "no_template" };
          if (rows.length !== 1 || row === undefined) {
            throw new Error("invalid assignment template");
          }
          return { status: "found", template: row };
        });
      } catch (error) {
        const refusal = REFUSALS.get(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}

export type AssignmentTemplate = ReturnType<typeof createAssignmentTemplate>;
