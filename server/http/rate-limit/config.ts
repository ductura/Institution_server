import { DEFAULT_RATE_LIMITS, type RateLimits } from "../../traffic/index.ts";

const MIN_LIMIT = 1;
const MAX_LIMIT = 100_000;

export function readRateLimitConfig(env: NodeJS.ProcessEnv) {
  const problems: string[] = [];
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const limit = Number(raw);
    if (/^[1-9][0-9]*$/u.test(raw) && limit >= MIN_LIMIT && limit <= MAX_LIMIT) return limit;
    problems.push(`${key} must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`);
    return fallback;
  };
  const readClass = (name: "enroll" | "save" | "default") => {
    const prefix = `DUCTURA_RATE_LIMIT_${name.toUpperCase()}`;
    const defaults = DEFAULT_RATE_LIMITS[name];
    return {
      perIp: read(`${prefix}_PER_IP`, defaults.perIp),
      perAccount: read(`${prefix}_PER_ACCOUNT`, defaults.perAccount ?? MAX_LIMIT),
    };
  };
  const limits: RateLimits = {
    login: {
      perIp: read("DUCTURA_RATE_LIMIT_LOGIN_PER_IP", DEFAULT_RATE_LIMITS.login.perIp),
      perAccount: null,
    },
    enroll: readClass("enroll"),
    save: readClass("save"),
    default: readClass("default"),
  };
  return { limits, problems };
}
