// Public interface of server/support; other areas import only this file.
export {
  createSupportService,
  PROBLEM_REPORT_INVALID_BODY,
  PROBLEM_REPORT_INVALID_JSON,
  SUPPORT_ERRORS,
  type SupportService,
} from "./service.ts";
