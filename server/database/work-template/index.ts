import type { WithActor } from "../index.ts";

/**
 * SRV-V17-TEMPLATE-ADMIN: the work template of an institution, one per work type; a version
 * is only ever added. The database decides who may (an administrator of the institution) and
 * raises ZD401, ZD403, ZD409 and ZD422; they are not caught here, the HTTP edge maps them.
 * Nothing in this port comes from the caller but the session token, the work type and the
 * fields of the version.
 */

export type WorkTemplateTitleField = "title" | "author" | "mentor" | "course" | "date";

export type WorkTemplateSection = { title: string; hint: string };

export type WorkTemplateVersion = {
  version: number;
  effectiveFrom: string;
  titlePage: WorkTemplateTitleField[];
  sections: WorkTemplateSection[];
  citationStyle: "fpzg";
};

export type WorkTemplateContent = {
  titlePage: readonly WorkTemplateTitleField[];
  sections: readonly WorkTemplateSection[];
  citationStyle: "fpzg";
};

type VersionRow = {
  version: number;
  titlePage: WorkTemplateTitleField[];
  sections: WorkTemplateSection[];
  citationStyle: "fpzg";
  createdAt: Date;
};

export function createWorkTemplate(withActor: WithActor) {
  return {
    /** The versions of one work type of the own institution in ascending order; an administrator only. */
    versions(token: string, workType: string): Promise<WorkTemplateVersion[]> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<VersionRow>(
          `SELECT version, title_page AS "titlePage", sections, citation_style AS "citationStyle",
                  created_at AS "createdAt"
             FROM app.read_work_template($1)`,
          [workType],
        );
        return rows.map((row, index) => {
          if (row.version !== index + 1 || !(row.createdAt instanceof Date)) {
            throw new Error("invalid work template chain");
          }
          return {
            version: row.version,
            effectiveFrom: row.createdAt.toISOString(),
            titlePage: row.titlePage,
            sections: row.sections,
            citationStyle: row.citationStyle,
          };
        });
      });
    },
    /** Adds the next version; the version number is the database's. */
    publish(
      token: string,
      workType: string,
      expectedVersion: number,
      content: WorkTemplateContent,
    ): Promise<number> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<{ version: number }>(
          "SELECT app.publish_work_template($1, $2::integer, $3::jsonb, $4::jsonb, $5) AS version",
          [
            workType,
            expectedVersion,
            JSON.stringify(content.titlePage),
            JSON.stringify(content.sections),
            content.citationStyle,
          ],
        );
        const version = rows[0]?.version;
        if (rows.length !== 1 || version !== expectedVersion + 1) {
          throw new Error("invalid published work template version");
        }
        return version;
      });
    },
  };
}

export type WorkTemplate = ReturnType<typeof createWorkTemplate>;
