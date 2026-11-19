// The dev fake server (Ductus#2028): every route of /api/v1 from the contract,
// with in-memory state, for building the web without the server's handlers.
// Local development and tests only (D-09): loading it elsewhere throws.
import "../guard/index.ts";

import { ACCOUNT_HANDLERS } from "./account-routes.ts";
import { INSTITUTION_HANDLERS } from "./institution-routes.ts";
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
  IDS,
  INSTITUTION,
  type AccountKey,
  type State,
} from "./state.ts";

/** The answer of every route the dev fake server knows, by operation id. */
export const DEV_HANDLERS: Handlers = { ...ACCOUNT_HANDLERS, ...INSTITUTION_HANDLERS };
