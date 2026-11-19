// The port of the dev fake server: DUCTURA_LAZNI_PORT, 4010 by default, never
// 3000 to 3004, which the web and the other local servers use.
export const DEFAULT_PORT = 4010;
const RESERVED = { from: 3000, to: 3004 } as const;

/** The port from the environment, or an error text for a bad value. */
export function devServerPort(env: Readonly<Record<string, string | undefined>>): number | string {
  const raw = env.DUCTURA_LAZNI_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/u.test(raw)) return `DUCTURA_LAZNI_PORT=${raw} is not a port`;
  const port = Number(raw);
  if (port < 1024 || port > 65535) return `DUCTURA_LAZNI_PORT=${raw} is outside 1024 to 65535`;
  if (port >= RESERVED.from && port <= RESERVED.to)
    return `DUCTURA_LAZNI_PORT=${raw}: ports ${RESERVED.from} to ${RESERVED.to} are reserved`;
  return port;
}
