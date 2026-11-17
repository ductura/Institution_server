import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { BackupService } from "./index.ts";

describe("server/backup public interface", () => {
  it("exports the empty routes and schemas and the scheduler", () => {
    expect(Object.keys(area).sort()).toEqual([
      "BACKUP_CHECK_MS",
      "BACKUP_ROUTES",
      "BACKUP_SCHEMAS",
      "BACKUP_SKIP_REASONS",
      "createBackupScheduler",
    ]);
    expect(area.BACKUP_ROUTES).toEqual([]);
    expect(area.BACKUP_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof BackupService>().toEqualTypeOf<string>();
    expectTypeOf<BackupService[string]>().toEqualTypeOf<never>();
  });
});
