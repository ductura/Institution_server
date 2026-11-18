// S-1G-a part 2 (DAN-1012-2a; contract Ductus#2028 c.6965270952): the backup
// scheduler through the area's public interface, over settings that pass the
// real catalogue check, on a fake clock across four days. No database: the
// system level has no reader yet (settings.read_values refuses it, ZD403).
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { checkSettingWrite } from "../domain/index.ts";
import { BACKUP_CHECK_MS as H, createBackupScheduler } from "./index.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("runs only while backup.enabled is true, once per interval_hours", async () => {
  // The system level in memory: only a write the catalogue takes is kept.
  const system = new Map<string, unknown>();
  let reachable = true;
  const put = (key: string, value: unknown) => {
    expect(checkSettingWrite({ level: "system", key, value, bound: null }).ok).toBe(true);
    if (value === null) system.delete(key);
    else system.set(key, value);
  };
  const t0 = performance.now();
  const calls: number[] = [];
  const run = vi.fn(() => {
    calls.push((performance.now() - t0) / H);
  });
  const onSkip = vi.fn();
  const scheduler = createBackupScheduler({
    readSettings: () => (reachable ? new Map(system) : Promise.reject(new Error("down"))),
    run,
    onSkip,
  });
  scheduler.start();

  put("backup.enabled", false);
  await vi.advanceTimersByTimeAsync(24 * H);
  expect(run).not.toHaveBeenCalled();

  put("backup.enabled", true);
  put("backup.interval_hours", 6);
  await vi.advanceTimersByTimeAsync(24 * H);
  expect(run).toHaveBeenCalledTimes(4);
  // On the hourly grid from start(), six ticks after backup was last seen off.
  expect(calls).toEqual([30, 36, 42, 48]);

  put("backup.enabled", null);
  await vi.advanceTimersByTimeAsync(24 * H);
  expect(run).toHaveBeenCalledTimes(4);

  put("backup.enabled", true);
  reachable = false;
  await vi.advanceTimersByTimeAsync(24 * H);
  expect(run).toHaveBeenCalledTimes(4);

  await scheduler.stop();
  expect(onSkip.mock.calls).toEqual([
    ...Array.from({ length: 24 }, () => ["disabled"]),
    ...Array.from({ length: 24 }, () => ["enabled_missing"]),
    ...Array.from({ length: 24 }, () => ["settings_unavailable"]),
  ]);
});
