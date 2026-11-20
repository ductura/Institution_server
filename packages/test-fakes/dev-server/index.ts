// The dev fake server (Ductus#2028): every route of /api/v1 from the contract,
// with in-memory state, for building the web without the server's handlers.
// Local development and tests only (D-09): loading it elsewhere throws.
import "../guard/index.ts";

import { ACCOUNT_HANDLERS } from "./account-routes.ts";
import { COLLABORATION_HANDLERS } from "./collaboration-routes.ts";
import { EVIDENCE_HANDLERS } from "./evidence-routes.ts";
import { COURSE_SETUP_HANDLERS } from "./course-setup-routes.ts";
import { INSTITUTION_HANDLERS } from "./institution-routes.ts";
import { SETTINGS_HANDLERS } from "./settings-routes.ts";
import { STUDENT_HANDLERS } from "./student-routes.ts";
import { TEACHER_HANDLERS } from "./teacher-routes.ts";
import type { Handlers } from "./server.ts";

export {
  answerDev,
  createDevServer,
  DELAY_HEADER,
  DELAY_PARAM,
  ERROR_HEADER,
  ERROR_PARAM,
  MAX_DELAY_MS,
  SESSION_COOKIE,
  type Context,
  type DevRequest,
  type Handlers,
  type Reply,
} from "./server.ts";
export { DEFAULT_PORT, devServerPort } from "./port.ts";
export {
  ACCOUNT_KEYS,
  CODES,
  createState,
  EMPTY_DOCUMENT,
  IDS,
  INSTITUTION,
  type AccountKey,
  type State,
} from "./state.ts";

/**
 * The answer of every route of the contract, by operation id.
 * coverage.test.ts fails for a route of ROUTE_TABLE without one.
 */
export const DEV_HANDLERS: Handlers = {
  ...ACCOUNT_HANDLERS,
  ...INSTITUTION_HANDLERS,
  ...COURSE_SETUP_HANDLERS,
  ...STUDENT_HANDLERS,
  ...TEACHER_HANDLERS,
  ...SETTINGS_HANDLERS,
  ...EVIDENCE_HANDLERS,
  ...COLLABORATION_HANDLERS,
};
