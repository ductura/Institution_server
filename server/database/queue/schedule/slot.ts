// SRV-1303 (M10.0-S2): the slot of a scheduled job as the one identifier its
// queued body carries (D-74: identifiers only). A slot is a start time on a
// fixed grid of the job's period. Its id has the shape of a UUIDv7: the first
// 48 bits are the start in Unix milliseconds, the other 74 bits come from the
// SHA-256 of the job's name and that start. So one job and one start always
// give the same id (the queue's singleton key, so a slot is queued once at a
// time), the start is read back from the id, and an id is only accepted for
// the job it was made for.
import { createHash } from "node:crypto";

/** The largest start a UUIDv7 holds: 2^48 - 1 milliseconds. */
const MAX_MS = 2 ** 48 - 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The start of the slot that holds `nowMs`: the last multiple of `everyMs` at or before it. */
export function slotStart(nowMs: number, everyMs: number): number {
  return Math.floor(nowMs / everyMs) * everyMs;
}

/** The id of the slot of `name` that starts at `startMs`. */
export function slotId(name: string, startMs: number): string {
  if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > MAX_MS)
    throw new RangeError("slot_out_of_range");
  const time = startMs.toString(16).padStart(12, "0");
  const rest = createHash("sha256").update(`${name}\u0000${startMs}`).digest("hex");
  // Version 7 in the 13th digit, the RFC 9562 variant (10xx) in the 17th.
  const variant = ((parseInt(rest.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${rest.slice(0, 3)}-${variant}${rest.slice(4, 7)}-${rest.slice(7, 19)}`;
}

/** The start of a slot id of `name`, or null for any id that is not exactly one of its slots. */
export function slotOf(name: string, id: string): number | null {
  if (!UUID.test(id)) return null;
  const startMs = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return slotId(name, startMs) === id ? startMs : null;
}
