// The test mode of the server (S-1H.7, DAN-938-1; contract Ductus#1836
// c.6949441473). DUCTURA_MODE=test is the test server's switch (fake OIDC
// and synthetic seed come with DAN-938-3); this check only keeps it out of
// production. Production is every NODE_ENV but development and test
// (isNonProductionBuild, the same gate as the fake provider, D-09). Any other
// DUCTURA_MODE value is refused, so a typo neither hides the check nor turns
// the mode on. Only an own data property counts: an inherited key is as if
// unset, and a getter is a problem without being called. Problems name the
// variable, never its value.
import { isNonProductionBuild } from "./non-production.ts";

type Env = Readonly<Record<string, string | undefined>>;

const MODE = "DUCTURA_MODE";
const TEST = "test";

/** The own value: undefined when unset, null when it is not a plain string. */
function ownValue(env: Env, name: string): string | null | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (descriptor === undefined) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === "string" ? value : null;
}

/** The problem of DUCTURA_MODE, by variable name only; empty when unset or allowed. */
export function testModeProblems(env: Env): string[] {
  const mode = ownValue(env, MODE);
  if (mode === undefined) return [];
  if (mode !== TEST) return [`${MODE} is not a known mode`];
  const nodeEnv = ownValue(env, "NODE_ENV");
  return isNonProductionBuild(nodeEnv ?? undefined)
    ? []
    : [`${MODE} test is refused in production`];
}
