/**
 * SRV-1405 (M2.12, M2.17; D-117, D-199): the schema of the rules of a faculty,
 * `config/faculties/<faculty>/rules.json` and every version an administrator
 * publishes into `app.institution_config`.
 *
 * The schema is closed (zod strict objects): an unknown key, a value outside
 * the closed sets or a default language that is not offered refuses the whole
 * document. It holds only per-institution settings that are decided and kept
 * nowhere else: the citation style (D-83) and the languages a work may be
 * written in (F-06, `institution.is_work_language`). The AI rule per kind of
 * work is `institution.faculty_rule_version` (DAN-315, D-175); thresholds,
 * retention and providers are not decided (D-30, Q-10) and have no key here.
 * The AI switch of the institution stays in `config/faculties/<faculty>.json`
 * and changes only through the owner's PR (OC-1).
 */
import { z } from "zod";

export const FACULTY_RULES_FORMAT = "ductura-faculty-rules-v1";
/** The `identity.institution.slug` CHECK, matched exactly. */
export const FACULTY_SLUG_PATTERN = /^[a-z0-9-]{2,32}$/u;
/**
 * The style IDs of the settings catalogue (`citation.style`, D-83), which stays
 * the source: `server/citation-styles.test.ts` fails when the lists differ.
 */
export const CITATION_STYLES = ["fpzg", "apa", "chicago", "ieee", "vancouver", "fusnote"] as const;
/** `institution.is_work_language`. */
export const WORK_LANGUAGES = ["hr", "en"] as const;
/** The bound of `app.institution_config.rules` and of a rules file. */
export const FACULTY_RULES_MAX_BYTES = 16 * 1024;

const workLanguage = z.enum(WORK_LANGUAGES);

export const facultyRulesSchema = z
  .strictObject({
    citationStyle: z.enum(CITATION_STYLES),
    workLanguages: z
      .array(workLanguage)
      .min(1)
      .max(WORK_LANGUAGES.length)
      .refine((list) => new Set(list).size === list.length, { message: "duplicate" }),
    defaultWorkLanguage: workLanguage,
  })
  .refine((rules) => rules.workLanguages.includes(rules.defaultWorkLanguage), {
    message: "not_offered",
    path: ["defaultWorkLanguage"],
  });

export const facultyRulesFileSchema = z.strictObject({
  format: z.literal(FACULTY_RULES_FORMAT),
  faculty: z.string().regex(FACULTY_SLUG_PATTERN),
  rules: facultyRulesSchema,
});

export type FacultyRules = Readonly<z.infer<typeof facultyRulesSchema>>;
export type FacultyRulesFile = Readonly<z.infer<typeof facultyRulesFileSchema>>;

const FIELD = /^[A-Za-z0-9]{1,32}$/u;

/**
 * The place of the first schema issue as `a.b.0`, built only from the
 * schema's own keys and indices; anything else reads as `?`, so a problem
 * line never repeats a value of the input.
 */
export function issueField(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "";
  return issue.path
    .map((part) =>
      typeof part === "number" || (typeof part === "string" && FIELD.test(part))
        ? String(part)
        : "?",
    )
    .join(".");
}
