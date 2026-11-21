export {
  CITATION_STYLES,
  FACULTY_RULES_FORMAT,
  FACULTY_RULES_MAX_BYTES,
  FACULTY_SLUG_PATTERN,
  WORK_LANGUAGES,
  facultyRulesFileSchema,
  facultyRulesSchema,
  issueField,
  type FacultyRules,
  type FacultyRulesFile,
} from "./schema.ts";
export {
  FACULTY_CONFIG_DIR,
  FACULTY_RULES_ERROR_CODES,
  FACULTY_RULES_FILE,
  facultyRulesCatalogOf,
  facultyRulesProblems,
  loadFacultyRules,
  type FacultyRulesCatalog,
  type FacultyRulesError,
  type FacultyRulesErrorCode,
  type FacultyRulesResult,
} from "./loader.ts";
export {
  createInstitutionConfigStore,
  type AssignmentRulesOutcome,
  type InstitutionConfigStore,
  type InstitutionConfigVersion,
  type PublishOutcome,
  type VersionsOutcome,
} from "./store.ts";
