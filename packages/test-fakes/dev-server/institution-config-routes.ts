// The versioned rules of the institution on the dev fake server
// (institution.config.get and institution.config-versions.post, SRV-1406).
// Only the administrator reads or adds a version; a version is never changed,
// and the history is per fake state. The real rules are
// app.publish_institution_config (SRV-1405 and 20261202190600).
import type { Handlers } from "./server.ts";
import type { Account, State } from "./state.ts";

type Rules = {
  citationStyle: "fpzg";
  workLanguages: ("hr" | "en")[];
  defaultWorkLanguage: "hr" | "en";
};
type Version = { version: number; effectiveFrom: string; rules: Rules };

const history = new WeakMap<State, Version[]>();
const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;

export const INSTITUTION_CONFIG_HANDLERS: Handlers = {
  "institution.config.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const versions = history.get(state) ?? [];
    return { status: 200, body: { current: versions.at(-1) ?? null, versions } };
  },
  "institution.config-versions.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    const versions = history.get(state) ?? [];
    if (!body.workLanguages.includes(body.defaultWorkLanguage)) return { error: "invalid_input" };
    if (new Set(body.workLanguages).size !== body.workLanguages.length) {
      return { error: "invalid_input" };
    }
    if (body.expectedVersion !== versions.length) return { error: "conflict" };
    const made: Version = {
      version: versions.length + 1,
      effectiveFrom: new Date(now).toISOString(),
      rules: {
        citationStyle: body.citationStyle,
        workLanguages: body.workLanguages,
        defaultWorkLanguage: body.defaultWorkLanguage,
      },
    };
    history.set(state, [...versions, made]);
    return { status: 201, body: made };
  },
};
