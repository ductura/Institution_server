export { loadInvocation, main as loadDemoK3, PSQL_ARGS } from "./demo-k3.ts";
export type { Invocation } from "./demo-k3.ts";
export { dockerExecArgs, nativePsqlTarget } from "./psql-target.ts";
export type { Env, NativePsqlTarget, PsqlTarget } from "./psql-target.ts";
export {
  GROUP_ATTRIBUTES,
  GROUP_ROLES,
  LOGIN_ATTRIBUTES,
  LOGIN_ROLES,
  MIGRATION_ROLES,
  MIGRATOR_ATTRIBUTES,
  MIGRATOR_ROLE,
} from "./roles.ts";
export type { RoleAttributes } from "./roles.ts";
