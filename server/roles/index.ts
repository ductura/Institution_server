// Public interface of server/roles; other areas import only this file.
export { ROLES_ROUTES } from "./routes.ts";
export { ROLES_SCHEMAS } from "./schemas.ts";
export type { RolesService } from "./service.ts";
export { ACCOUNT_KINDS, LOGIN_METHODS, isAccountKind } from "./account-kinds.ts";
export type { AccountKind, Login, LoginMethod } from "./account-kinds.ts";
export {
  ACTIONS,
  CONTENT_ACTIONS,
  CONTENT_SCOPES,
  DELETION_ACTIONS,
  PERMISSIONS,
  PERMISSION_ROWS,
  SCOPES,
  isAction,
  scopeOf,
} from "./permissions.ts";
export type {
  Action,
  CellFor,
  ContentAction,
  ContentScope,
  KindCells,
  PermissionRow,
  Scope,
} from "./permissions.ts";
