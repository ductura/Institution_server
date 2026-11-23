// SRV-ADMIN-3 (docs/contracts/admin-settings-v1.md): every catalogue key the
// administrator's answers carry beside a code has a text in hr and en.
import { describe, expect, it } from "vitest";

import { messagesEn, messagesHr, textOf, type MessageKey } from "../../locales/index.ts";

import { EXPORT_ALREADY_OPEN_KEY, RetentionClassReport } from "./index.ts";

const periodKeys = (): string[] => {
  const schema = RetentionClassReport.properties.periodStatusKey as unknown as {
    anyOf: { const: string }[];
  };
  return schema.anyOf.map((branch) => branch.const);
};

describe("admin settings catalogue keys", () => {
  it.each([EXPORT_ALREADY_OPEN_KEY, ...periodKeys()])("%s has a text in hr and en", (key) => {
    expect(textOf(messagesHr, key as MessageKey)).toMatch(/\S/u);
    expect(textOf(messagesEn, key as MessageKey)).toMatch(/\S/u);
  });

  it("the retention contract names exactly the three period texts", () => {
    expect(periodKeys()).toEqual([
      "adminSettings.retentionPeriod.decided",
      "adminSettings.retentionPeriod.awaitingDecision",
      "adminSettings.retentionPeriod.neverDeleted",
    ]);
  });
});
