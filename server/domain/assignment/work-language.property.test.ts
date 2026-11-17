// DAN-909 (S-M-3): properties of the work language parser, ported from Ductus
// src/domain/assignment/work-language.property.test.ts at 4651a25. The third
// Ductus property (independent of the interface language) imports the
// interface locales, which server/domain may not; the second covers it, since
// the parser reads nothing but its input.
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";

import { parseWorkLanguage, WORK_LANGUAGES } from "./work-language.ts";

test.prop([
  fc
    .string({ maxLength: 12 })
    .filter((value) => !(WORK_LANGUAGES as readonly string[]).includes(value)),
])("every string outside the set reads as null", (value) => {
  expect(parseWorkLanguage(value)).toBeNull();
});

test.prop([fc.anything({ withBoxedValues: true, withNullPrototype: true })])(
  "anything reads as a member of the set or null, and nothing throws",
  (value) => {
    const language = parseWorkLanguage(value);
    expect(language === null || WORK_LANGUAGES.includes(language)).toBe(true);
    if (language !== null) expect(value).toBe(language);
  },
);
